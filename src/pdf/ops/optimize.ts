/**
 * Optimizing, sanitizing and checking: unused-object removal (by full rewrite), stream recompression,
 * image downsampling hooks, removal of metadata / attachments / JavaScript / links / hidden layers,
 * a hidden-information report, document statistics, font lists, and preflight-style checks
 * (archival, accessibility) reported honestly as checks rather than conformance.
 */
import { Dict, Name, PdfObj, PdfStream, PdfString, Ref, isName, nameObj } from '../objects';
import { PdfDocument } from '../document';
import { readAttachments, readLayers, readMetadata, pageAnnotations, readFields, readOutlines } from '../structure';
import { IMAGE_FILTERS } from '../filters';

export interface ImageInfo { ref: Ref | null; page: number; name: string; width: number; height: number; bpc: number; colorSpace: string; filter: string; bytes: number; hasMask: boolean; stream: PdfStream }

export function listImages(doc: PdfDocument): ImageInfo[] {
  const out: ImageInfo[] = [];
  const seen = new Set<number>();
  const walk = (res: Dict | null, page: number, depth: number) => {
    if (!res || depth > 6) return;
    const xo = doc.getDict(res, 'XObject');
    if (!xo) return;
    for (const k of xo.keys()) {
      const ref = xo.get(k);
      const s = doc.resolve<PdfStream | null>(ref);
      if (!(s instanceof PdfStream)) continue;
      const sub = doc.getName(s, 'Subtype');
      if (sub === 'Form') { if (ref instanceof Ref) { if (seen.has(ref.num)) continue; seen.add(ref.num); } walk(doc.getDict(s, 'Resources'), page, depth + 1); continue; }
      if (sub !== 'Image') continue;
      if (ref instanceof Ref) { if (seen.has(ref.num)) continue; seen.add(ref.num); }
      const f = s.dict.get('Filter');
      const cs = doc.get(s, 'ColorSpace');
      out.push({ ref: ref instanceof Ref ? ref : null, page, name: k, width: doc.getNum(s, 'Width'), height: doc.getNum(s, 'Height'), bpc: doc.getNum(s, 'BitsPerComponent', 8), colorSpace: isName(cs) ? cs.name : Array.isArray(cs) && isName(cs[0]) ? cs[0].name : cs ? 'other' : '', filter: isName(f) ? f.name : Array.isArray(f) ? f.filter(nameObj).map((n) => (n as Name).name).join('+') : '', bytes: s.raw.length, hasMask: s.dict.has('SMask') || s.dict.has('Mask'), stream: s });
    }
  };
  doc.pages.forEach((p, i) => walk(p.resources, i, 0));
  return out;
}

export interface FontUse { name: string; subtype: string; embedded: boolean; encoding: string; pages: number[]; ref: Ref | null; type3: boolean }

export function listFonts(doc: PdfDocument): FontUse[] {
  const map = new Map<string, FontUse>();
  const walk = (res: Dict | null, page: number, depth: number) => {
    if (!res || depth > 6) return;
    const fonts = doc.getDict(res, 'Font');
    if (fonts) for (const k of fonts.keys()) {
      const ref = fonts.get(k);
      const f = doc.resolve<Dict | null>(ref);
      if (!(f instanceof Dict)) continue;
      const base = doc.getName(f, 'BaseFont') || k;
      const key = ref instanceof Ref ? `R${ref.num}` : base;
      let fd = doc.getDict(f, 'FontDescriptor');
      const desc = doc.getArray(f, 'DescendantFonts');
      if (!fd && desc && desc.length) { const d0 = doc.resolve<Dict | null>(desc[0]); if (d0 instanceof Dict) fd = doc.getDict(d0, 'FontDescriptor'); }
      const sub = doc.getName(f, 'Subtype');
      const enc = doc.get(f, 'Encoding');
      const cur = map.get(key);
      if (cur) { if (!cur.pages.includes(page)) cur.pages.push(page); continue; }
      map.set(key, { name: base, subtype: sub, embedded: !!fd && (fd.has('FontFile') || fd.has('FontFile2') || fd.has('FontFile3')), encoding: isName(enc) ? enc.name : enc instanceof Dict ? 'Custom' : enc instanceof PdfStream ? 'CMap' : '', pages: [page], ref: ref instanceof Ref ? ref : null, type3: sub === 'Type3' });
    }
    const xo = doc.getDict(res, 'XObject');
    if (xo) for (const k of xo.keys()) { const s = doc.resolve<PdfStream | null>(xo.get(k)); if (s instanceof PdfStream && doc.getName(s, 'Subtype') === 'Form') walk(doc.getDict(s, 'Resources'), page, depth + 1); }
  };
  doc.pages.forEach((p, i) => walk(p.resources, i, 0));
  for (const p of doc.pages) for (const a of doc.getArray(p.dict, 'Annots') || []) { const d = doc.resolve<Dict | null>(a); const ap = d instanceof Dict ? doc.getDict(d, 'AP') : null; const n = ap ? doc.get(ap, 'N') : null; if (n instanceof PdfStream) walk(doc.getDict(n, 'Resources'), p.index, 1); }
  return [...map.values()];
}

export interface DocStats { pages: number; words: number; characters: number; images: number; fonts: number; annotations: number; fields: number; attachments: number; bookmarks: number; bytes: number; objects: number; version: string; encrypted: boolean; tagged: boolean; linearized: boolean; incrementalUpdates: number; javascript: number; links: number }

export function stats(doc: PdfDocument, text?: string): DocStats {
  const m = readMetadata(doc);
  const words = text ? (text.match(/\S+/g) || []).length : 0;
  const annots = doc.pages.flatMap((p) => pageAnnotations(doc, p));
  const countBm = (items: ReturnType<typeof readOutlines>): number => items.reduce((n, i) => n + 1 + countBm(i.children), 0);
  const head = new TextDecoder('latin1').decode(doc.buf.subarray(0, 1024));
  return { pages: doc.pageCount, words, characters: text ? text.length : 0, images: listImages(doc).length, fonts: listFonts(doc).length, annotations: annots.filter((a) => a.subtype !== 'Widget' && a.subtype !== 'Popup' && a.subtype !== 'Link').length, fields: readFields(doc).length, attachments: readAttachments(doc).length, bookmarks: countBm(readOutlines(doc)), bytes: doc.buf.length, objects: doc.objectNumbers().length, version: m.version, encrypted: !!doc.security, tagged: m.tagged, linearized: /\/Linearized/.test(head), incrementalUpdates: Math.max(0, countOccurrences(doc.buf, '%%EOF') - 1), javascript: countJavaScript(doc), links: annots.filter((a) => a.subtype === 'Link').length };
}

function countOccurrences(buf: Uint8Array, s: string): number { let n = 0, i = 0; const t = new TextDecoder('latin1').decode(buf); while ((i = t.indexOf(s, i)) >= 0) { n++; i += s.length; } return n; }

function countJavaScript(doc: PdfDocument): number {
  let n = 0;
  const names = doc.getDict(doc.catalog, 'Names');
  if (names && doc.getDict(names, 'JavaScript')) n++;
  const oa = doc.get(doc.catalog, 'OpenAction'); if (oa instanceof Dict && doc.getName(oa, 'S') === 'JavaScript') n++;
  const aa = doc.getDict(doc.catalog, 'AA'); if (aa) n += aa.size;
  for (const p of doc.pages) for (const a of pageAnnotations(doc, p)) { const act = doc.getDict(a.dict, 'A'); if (act && doc.getName(act, 'S') === 'JavaScript') n++; if (a.dict.has('AA')) n++; }
  return n;
}

// ------------------------------------------------------------------------------------------
// Sanitize

export interface SanitizeOptions { metadata?: boolean; attachments?: boolean; javascript?: boolean; links?: boolean; hiddenLayers?: boolean; comments?: boolean; forms?: boolean; embeddedSearchIndex?: boolean; bookmarks?: boolean; thumbnails?: boolean; privateData?: boolean }

export interface HiddenInfoReport { items: { kind: string; count: number; detail: string }[] }

export function hiddenInformation(doc: PdfDocument): HiddenInfoReport {
  const items: HiddenInfoReport['items'] = [];
  const m = readMetadata(doc);
  const metaFields = [m.title && 'title', m.author && 'author', m.subject && 'subject', m.keywords && 'keywords', m.creator && 'creator', m.producer && 'producer', ...Object.keys(m.custom)].filter(Boolean) as string[];
  if (metaFields.length) items.push({ kind: 'Metadata', count: metaFields.length, detail: metaFields.join(', ') });
  if (m.xmp) items.push({ kind: 'XMP metadata', count: 1, detail: `${m.xmp.length} characters` });
  const att = readAttachments(doc); if (att.length) items.push({ kind: 'Attachments', count: att.length, detail: att.map((a) => a.name).join(', ') });
  const js = countJavaScript(doc); if (js) items.push({ kind: 'JavaScript / actions', count: js, detail: 'scripts or actions that run on events' });
  const annots = doc.pages.flatMap((p) => pageAnnotations(doc, p));
  const comments = annots.filter((a) => !['Widget', 'Popup', 'Link'].includes(a.subtype)); if (comments.length) items.push({ kind: 'Comments and markup', count: comments.length, detail: [...new Set(comments.map((a) => a.author).filter(Boolean))].join(', ') });
  const hidden = annots.filter((a) => a.hidden); if (hidden.length) items.push({ kind: 'Hidden annotations', count: hidden.length, detail: '' });
  const links = annots.filter((a) => a.subtype === 'Link'); if (links.length) items.push({ kind: 'Links', count: links.length, detail: '' });
  const fields = readFields(doc); if (fields.length) items.push({ kind: 'Form fields', count: fields.length, detail: fields.filter((f) => f.value && f.value !== '').length + ' with values' });
  const layers = readLayers(doc); if (layers.some((l) => !l.on)) items.push({ kind: 'Hidden layers', count: layers.filter((l) => !l.on).length, detail: layers.filter((l) => !l.on).map((l) => l.name).join(', ') });
  const bm = readOutlines(doc); if (bm.length) items.push({ kind: 'Bookmarks', count: bm.length, detail: '' });
  if (doc.pages.some((p) => p.dict.has('Thumb'))) items.push({ kind: 'Embedded page thumbnails', count: doc.pages.filter((p) => p.dict.has('Thumb')).length, detail: '' });
  if (doc.catalog.has('PieceInfo') || doc.pages.some((p) => p.dict.has('PieceInfo'))) items.push({ kind: 'Private application data', count: 1, detail: 'PieceInfo' });
  const updates = Math.max(0, countOccurrences(doc.buf, '%%EOF') - 1); if (updates) items.push({ kind: 'Earlier versions (incremental updates)', count: updates, detail: 'a full rewrite removes them' });
  return { items };
}

/** Removes hidden information; returns what was removed. The caller saves with a full rewrite so earlier versions disappear. */
export function sanitize(doc: PdfDocument, o: SanitizeOptions): string[] {
  const done: string[] = [];
  const cat = doc.catalog;
  if (o.metadata) {
    const info = doc.trailer.get('Info');
    if (info instanceof Ref) doc.update(info, new Dict({ Producer: PdfString.fromText('QuillFolio') })); else doc.trailer.delete('Info');
    if (cat.has('Metadata')) { const m = cat.get('Metadata'); cat.delete('Metadata'); if (m instanceof Ref) doc.remove(m); }
    for (const p of doc.pages) if (p.dict.has('Metadata')) { p.dict.delete('Metadata'); if (p.ref) doc.touch(p.ref); }
    done.push('metadata');
  }
  if (o.attachments) { for (const a of readAttachments(doc)) { const { removeAttachment } = requireStructure(); removeAttachment(doc, a); } const names = doc.getDict(cat, 'Names'); if (names) { names.delete('EmbeddedFiles'); } cat.delete('Collection'); done.push('attachments'); }
  if (o.javascript) {
    const names = doc.getDict(cat, 'Names'); if (names) names.delete('JavaScript');
    const oa = doc.get(cat, 'OpenAction'); if (oa instanceof Dict && doc.getName(oa, 'S') === 'JavaScript') cat.delete('OpenAction');
    cat.delete('AA');
    for (const p of doc.pages) { let changed = false; if (p.dict.has('AA')) { p.dict.delete('AA'); changed = true; } for (const a of pageAnnotations(doc, p)) { const act = doc.getDict(a.dict, 'A'); let ch = false; if (act && doc.getName(act, 'S') === 'JavaScript') { a.dict.delete('A'); ch = true; } if (a.dict.has('AA')) { a.dict.delete('AA'); ch = true; } if (ch && a.ref) doc.update(a.ref, a.dict); } if (changed && p.ref) doc.touch(p.ref); }
    const af = doc.getDict(cat, 'AcroForm'); if (af) { for (const f of readFields(doc)) if (f.dict.has('AA')) { f.dict.delete('AA'); doc.update(f.ref, f.dict); } }
    done.push('JavaScript and actions');
  }
  if (o.links) { for (const p of doc.pages) { const keep = (doc.getArray(p.dict, 'Annots') || []).filter((a) => { const d = doc.resolve<Dict | null>(a); return !(d instanceof Dict && doc.getName(d, 'Subtype') === 'Link'); }); p.dict.set('Annots', keep); if (p.ref) doc.touch(p.ref); } done.push('links'); }
  if (o.comments) { for (const p of doc.pages) { const keep = (doc.getArray(p.dict, 'Annots') || []).filter((a) => { const d = doc.resolve<Dict | null>(a); const st = d instanceof Dict ? doc.getName(d, 'Subtype') : ''; return st === 'Widget' || st === 'Link'; }); p.dict.set('Annots', keep); if (p.ref) doc.touch(p.ref); } done.push('comments'); }
  if (o.forms) { const { flattenForm } = requireForms(); flattenForm(doc); done.push('form fields (flattened)'); }
  if (o.hiddenLayers) {
    const oc = doc.getDict(cat, 'OCProperties');
    if (oc) { const d = doc.getDict(oc, 'D'); if (d) { d.delete('OFF'); } const r = cat.get('OCProperties'); if (r instanceof Ref) doc.touch(r); }
    done.push('hidden layers (made visible)');
  }
  if (o.bookmarks) { if (cat.has('Outlines')) { cat.delete('Outlines'); done.push('bookmarks'); } }
  if (o.thumbnails) { for (const p of doc.pages) if (p.dict.has('Thumb')) { p.dict.delete('Thumb'); if (p.ref) doc.touch(p.ref); } done.push('page thumbnails'); }
  if (o.privateData) { cat.delete('PieceInfo'); for (const p of doc.pages) if (p.dict.has('PieceInfo')) { p.dict.delete('PieceInfo'); if (p.ref) doc.touch(p.ref); } done.push('private application data'); }
  if (o.embeddedSearchIndex) { const names = doc.getDict(cat, 'Names'); if (names) names.delete('EmbeddedSearch'); }
  doc.update(doc.catalogRef, cat);
  return done;
}

// Lazy requires to avoid import cycles at module evaluation time.
import * as structureMod from '../structure';
import * as formsMod from './forms';
function requireStructure() { return structureMod; }
function requireForms() { return formsMod; }

// ------------------------------------------------------------------------------------------
// Checks

export interface CheckItem { level: 'error' | 'warning' | 'info'; text: string; page?: number; fix?: string }

/** Archival-readiness checks in the spirit of PDF/A (not a conformance test; says what it cannot verify). */
export function archivalCheck(doc: PdfDocument): CheckItem[] {
  const out: CheckItem[] = [];
  if (doc.security) out.push({ level: 'error', text: 'The document is encrypted; archival PDF forbids encryption.', fix: 'Protect ▸ Remove Security' });
  const fonts = listFonts(doc);
  for (const f of fonts) if (!f.embedded && !f.type3) out.push({ level: 'error', text: `Font ${f.name} is not embedded (pages ${f.pages.map((p) => p + 1).slice(0, 8).join(', ')}).`, fix: 'Fonts can only be embedded by the program that created the document' });
  const m = readMetadata(doc);
  if (!m.xmp) out.push({ level: 'error', text: 'No XMP metadata stream.', fix: 'File ▸ Properties writes one when you save' });
  if (!m.title) out.push({ level: 'warning', text: 'The document has no title.', fix: 'File ▸ Properties' });
  if (countJavaScript(doc)) out.push({ level: 'error', text: 'JavaScript or actions are present.', fix: 'Protect ▸ Sanitize' });
  if (readAttachments(doc).some((a) => !/pdf/i.test(a.mime))) out.push({ level: 'warning', text: 'Non-PDF attachments are present (allowed only in some archival levels).' });
  for (const im of listImages(doc)) if (/JPX/.test(im.filter)) out.push({ level: 'warning', text: `Image ${im.name} on page ${im.page + 1} uses JPEG 2000 (allowed only in PDF/A-2 and later).`, page: im.page });
  if (readLayers(doc).length) out.push({ level: 'warning', text: 'Optional content (layers) is present (forbidden in PDF/A-1).' });
  const transp = doc.pages.some((p) => { const res = p.resources; const eg = res ? doc.getDict(res, 'ExtGState') : null; return !!eg && eg.keys().some((k) => { const g = doc.getDict(eg, k); return !!g && ((doc.getNum(g, 'CA', 1) < 1) || doc.getNum(g, 'ca', 1) < 1 || (g.has('SMask') && !isName(g.get('SMask'), 'None'))); }); });
  if (transp) out.push({ level: 'warning', text: 'Transparency is used (forbidden in PDF/A-1, allowed from PDF/A-2).' });
  if (!out.some((x) => x.level === 'error')) out.push({ level: 'info', text: 'No blocking problems found. QuillFolio checks structure only; color profiles and font program validity are not verified.' });
  return out;
}

export function accessibilityCheck(doc: PdfDocument, pageTexts?: string[]): CheckItem[] {
  const out: CheckItem[] = [];
  const m = readMetadata(doc);
  if (!m.title) out.push({ level: 'error', text: 'No document title (screen readers announce the file name instead).', fix: 'Review ▸ Accessibility Fixer sets it' });
  if (!m.language) out.push({ level: 'error', text: 'No document language.', fix: 'Review ▸ Accessibility Fixer sets it' });
  if (!m.tagged) out.push({ level: 'error', text: 'The document is not tagged: reading order and headings are not available to assistive technology. QuillFolio cannot add tags to existing content; create a tagged PDF from the source document.' });
  const images = listImages(doc);
  if (images.length && !m.tagged) out.push({ level: 'warning', text: `${images.length} image(s) have no alternative text (alt text needs a tagged structure).` });
  const vp = doc.getDict(doc.catalog, 'ViewerPreferences');
  if (!vp || doc.get(vp, 'DisplayDocTitle') !== true) out.push({ level: 'warning', text: 'Viewers show the file name rather than the title.', fix: 'Review ▸ Accessibility Fixer turns on Display Document Title' });
  if (pageTexts) pageTexts.forEach((t, i) => { if (!t.trim() && images.some((im) => im.page === i)) out.push({ level: 'warning', text: `Page ${i + 1} has no text (scanned?).`, page: i, fix: 'Scan/OCR ▸ Recognize Text' }); });
  for (const f of readFields(doc)) if (!f.tooltip && f.type !== 'button') out.push({ level: 'warning', text: `Form field "${f.name}" has no tooltip (its accessible name).`, fix: 'Forms ▸ Field Properties' });
  if (!out.length) out.push({ level: 'info', text: 'No problems found in what QuillFolio can check.' });
  return out;
}

/** Applies the automatic accessibility fixes: title, language, display title, field tooltips from names. */
export function accessibilityFix(doc: PdfDocument, o: { title?: string; language?: string }): string[] {
  const done: string[] = [];
  const m = readMetadata(doc);
  if (!m.title && o.title) { doc.ensureInfo().set('Title', PdfString.fromText(o.title)); done.push('title'); }
  if (!m.language && o.language) { doc.catalog.set('Lang', PdfString.fromText(o.language)); done.push('language'); }
  let vp = doc.getDict(doc.catalog, 'ViewerPreferences');
  if (!vp) { vp = new Dict(); doc.catalog.set('ViewerPreferences', vp); }
  if (doc.get(vp, 'DisplayDocTitle') !== true) { vp.set('DisplayDocTitle', true); done.push('display document title'); }
  for (const f of readFields(doc)) if (!f.tooltip && f.type !== 'button') { f.dict.set('TU', PdfString.fromText(f.name.split('.').pop()!.replace(/[_-]+/g, ' '))); doc.update(f.ref, f.dict); done.push(`tooltip for ${f.name}`); }
  doc.update(doc.catalogRef, doc.catalog);
  return done;
}

export const isImageFilter = (n: string): boolean => IMAGE_FILTERS.has(n);
export type { PdfObj };
