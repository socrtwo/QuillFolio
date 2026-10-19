/**
 * Document structure readers and writers: outlines (bookmarks), named destinations, page labels,
 * embedded files (attachments), optional content (layers), metadata (Info and XMP), the AcroForm
 * field tree, annotations per page, and signature fields.
 */
import { Dict, Name, PdfObj, PdfStream, PdfString, Ref, dictOf, isName, latin1, parsePdfDate, pdfDate } from './objects';
import { flateStream } from './filters';
import type { PdfDocument, PageInfo } from './document';

// ------------------------------------------------------------------------------------------
// Destinations

export interface Dest { page: number; /** 'XYZ' | 'Fit' | 'FitH' … */ kind: string; x?: number; y?: number; zoom?: number }

function pageIndexOf(doc: PdfDocument, o: PdfObj): number {
  if (typeof o === 'number') return o;
  if (o instanceof Ref) { const i = doc.pages.findIndex((p) => p.ref?.num === o.num); return i; }
  return -1;
}

export function resolveDest(doc: PdfDocument, d: PdfObj): Dest | null {
  let v: PdfObj = doc.resolve(d);
  for (let i = 0; i < 8 && (v instanceof PdfString || isName(v)); i++) {
    const name = v instanceof PdfString ? v.toText() : (v as Name).name;
    v = lookupName(doc, 'Dests', name);
    if (v instanceof Dict && v.has('D')) v = doc.get(v, 'D');
  }
  if (v instanceof Dict && v.has('D')) v = doc.get(v, 'D');
  if (!Array.isArray(v) || !v.length) return null;
  const page = pageIndexOf(doc, doc.resolve(v[0]) instanceof Dict ? v[0] : doc.resolve(v[0]));
  const kind = isName(v[1]) ? v[1].name : 'Fit';
  const n = (i: number) => { const x = doc.resolve(v[i]); return typeof x === 'number' ? x : undefined; };
  const dest: Dest = { page: page < 0 ? 0 : page, kind };
  if (kind === 'XYZ') { dest.x = n(2); dest.y = n(3); dest.zoom = n(4); } else if (kind === 'FitH' || kind === 'FitBH') dest.y = n(2); else if (kind === 'FitV' || kind === 'FitBV') dest.x = n(2);
  return dest;
}

/** Looks a name up in a name tree of the catalog (Dests, EmbeddedFiles, JavaScript…), or the old /Dests dictionary. */
export function lookupName(doc: PdfDocument, tree: string, name: string): PdfObj {
  const names = doc.getDict(doc.catalog, 'Names');
  const root = names ? doc.getDict(names, tree) : null;
  if (root) { const v = nameTreeLookup(doc, root, name); if (v !== undefined) return v; }
  if (tree === 'Dests') { const d = doc.getDict(doc.catalog, 'Dests'); if (d) return doc.get(d, name); }
  return null;
}

function nameTreeLookup(doc: PdfDocument, node: Dict, name: string, depth = 0): PdfObj | undefined {
  if (depth > 32) return undefined;
  const names = doc.getArray(node, 'Names');
  if (names) for (let i = 0; i + 1 < names.length; i += 2) { const k = doc.resolve(names[i]); if (k instanceof PdfString && (k.toText() === name || k.toLatin1() === name)) return names[i + 1]; }
  const kids = doc.getArray(node, 'Kids') || [];
  for (const k of kids) { const kd = doc.resolve<Dict | null>(k); if (kd instanceof Dict) { const r = nameTreeLookup(doc, kd, name, depth + 1); if (r !== undefined) return r; } }
  return undefined;
}

/** Every (name, value) of a name tree. */
export function nameTreeEntries(doc: PdfDocument, root: Dict | null, depth = 0): [string, PdfObj][] {
  if (!root || depth > 32) return [];
  const out: [string, PdfObj][] = [];
  const names = doc.getArray(root, 'Names');
  if (names) for (let i = 0; i + 1 < names.length; i += 2) { const k = doc.resolve(names[i]); out.push([k instanceof PdfString ? k.toText() : String(k), names[i + 1]]); }
  for (const k of doc.getArray(root, 'Kids') || []) { const kd = doc.resolve<Dict | null>(k); if (kd instanceof Dict) out.push(...nameTreeEntries(doc, kd, depth + 1)); }
  return out;
}

function setNameTreeEntry(doc: PdfDocument, tree: string, name: string, value: PdfObj): void {
  let names = doc.getDict(doc.catalog, 'Names');
  if (!names) { names = new Dict(); doc.catalog.set('Names', names); }
  let root = doc.getDict(names, tree);
  const entries = root ? nameTreeEntries(doc, root).filter(([k]) => k !== name) : [];
  entries.push([name, value]);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const flat: PdfObj[] = [];
  for (const [k, v] of entries) flat.push(PdfString.fromText(k), v);
  const nd = new Dict({ Names: flat });
  if (root && names.get(tree) instanceof Ref) doc.update(names.get(tree) as Ref, nd); else names.set(tree, doc.register(nd));
  doc.update(doc.catalogRef, doc.catalog);
}
function deleteNameTreeEntry(doc: PdfDocument, tree: string, name: string): boolean {
  const names = doc.getDict(doc.catalog, 'Names');
  const root = names ? doc.getDict(names, tree) : null;
  if (!names || !root) return false;
  const entries = nameTreeEntries(doc, root);
  const keep = entries.filter(([k]) => k !== name);
  if (keep.length === entries.length) return false;
  const flat: PdfObj[] = [];
  for (const [k, v] of keep) flat.push(PdfString.fromText(k), v);
  const nd = new Dict({ Names: flat });
  if (names.get(tree) instanceof Ref) doc.update(names.get(tree) as Ref, nd); else names.set(tree, nd);
  doc.update(doc.catalogRef, doc.catalog);
  return true;
}

// ------------------------------------------------------------------------------------------
// Outlines (bookmarks)

export interface OutlineItem { title: string; dest: Dest | null; url?: string; children: OutlineItem[]; ref: Ref | null; open: boolean; color?: [number, number, number]; bold?: boolean; italic?: boolean }

export function readOutlines(doc: PdfDocument): OutlineItem[] {
  const root = doc.getDict(doc.catalog, 'Outlines');
  if (!root) return [];
  const seen = new Set<string>();
  const walk = (first: PdfObj | undefined, depth: number): OutlineItem[] => {
    const out: OutlineItem[] = [];
    let cur = first;
    for (let guard = 0; cur && guard < 5000 && depth < 32; guard++) {
      const ref = cur instanceof Ref ? cur : null;
      if (ref) { if (seen.has(ref.key)) break; seen.add(ref.key); }
      const d = doc.resolve<Dict | null>(cur);
      if (!(d instanceof Dict)) break;
      const item: OutlineItem = { title: doc.getText(d, 'Title'), dest: null, children: [], ref, open: doc.getNum(d, 'Count', 0) >= 0 };
      const a = doc.getDict(d, 'A');
      if (a && doc.getName(a, 'S') === 'URI') item.url = doc.getText(a, 'URI');
      else if (a && doc.getName(a, 'S') === 'GoTo') item.dest = resolveDest(doc, a.get('D') ?? null);
      else if (d.has('Dest')) item.dest = resolveDest(doc, d.get('Dest')!);
      const c = doc.getArray(d, 'C');
      if (c && c.length === 3) item.color = c.map((x) => doc.resolve<number>(x)) as [number, number, number];
      const f = doc.getNum(d, 'F', 0);
      if (f & 1) item.italic = true; if (f & 2) item.bold = true;
      item.children = walk(d.get('First'), depth + 1);
      out.push(item);
      cur = d.get('Next');
    }
    return out;
  };
  return walk(root.get('First'), 0);
}

export interface OutlineInput { title: string; page: number; y?: number; children?: OutlineInput[]; url?: string; open?: boolean }

/** Replaces the document's outline tree. */
export function writeOutlines(doc: PdfDocument, items: OutlineInput[]): void {
  const rootRef = doc.register(new Dict({ Type: Name.get('Outlines') }));
  const root = doc.resolve<Dict>(rootRef);
  const build = (list: OutlineInput[], parent: Ref): { first: Ref | null; last: Ref | null; count: number } => {
    let first: Ref | null = null, prev: Ref | null = null, count = 0;
    for (const it of list) {
      const d = new Dict({ Title: PdfString.fromText(it.title), Parent: parent });
      const ref = doc.register(d);
      const page = doc.pages[Math.max(0, Math.min(doc.pages.length - 1, it.page))];
      if (it.url) d.set('A', new Dict({ S: Name.get('URI'), URI: PdfString.fromText(it.url) }));
      else if (page?.ref) d.set('Dest', [page.ref, Name.get('XYZ'), null, it.y ?? page.cropBox[3], null]);
      if (it.children?.length) { const c = build(it.children, ref); d.set('First', c.first); d.set('Last', c.last); d.set('Count', it.open === false ? -c.count : c.count); count += c.count; }
      if (prev) { doc.resolve<Dict>(prev).set('Next', ref); d.set('Prev', prev); }
      if (!first) first = ref;
      prev = ref;
      count++;
    }
    return { first, last: prev, count };
  };
  const b = build(items, rootRef);
  root.set('First', b.first); root.set('Last', b.last); root.set('Count', b.count);
  doc.catalog.set('Outlines', rootRef);
  if (!items.length) doc.catalog.delete('Outlines');
  doc.catalog.set('PageMode', Name.get(items.length ? 'UseOutlines' : 'UseNone'));
  doc.update(doc.catalogRef, doc.catalog);
}

export function outlinesToInput(items: OutlineItem[]): OutlineInput[] {
  return items.map((i) => ({ title: i.title, page: i.dest?.page ?? 0, y: i.dest?.y, url: i.url, open: i.open, children: outlinesToInput(i.children) }));
}

// ------------------------------------------------------------------------------------------
// Page labels

export interface LabelRange { start: number; style?: 'D' | 'R' | 'r' | 'A' | 'a'; prefix?: string; first?: number }

export function readPageLabels(doc: PdfDocument): LabelRange[] {
  const pl = doc.getDict(doc.catalog, 'PageLabels');
  if (!pl) return [];
  const out: LabelRange[] = [];
  const walk = (node: Dict, depth: number) => {
    if (depth > 32) return;
    const nums = doc.getArray(node, 'Nums');
    if (nums) for (let i = 0; i + 1 < nums.length; i += 2) { const k = doc.resolve<number>(nums[i]); const v = doc.resolve<Dict | null>(nums[i + 1]); if (typeof k === 'number' && v instanceof Dict) out.push({ start: k, style: (doc.getName(v, 'S') || undefined) as any, prefix: doc.getText(v, 'P') || undefined, first: v.has('St') ? doc.getNum(v, 'St', 1) : undefined }); }
    for (const kid of doc.getArray(node, 'Kids') || []) { const kd = doc.resolve<Dict | null>(kid); if (kd instanceof Dict) walk(kd, depth + 1); }
  };
  walk(pl, 0);
  return out.sort((a, b) => a.start - b.start);
}

export function writePageLabels(doc: PdfDocument, ranges: LabelRange[]): void {
  if (!ranges.length) { doc.catalog.delete('PageLabels'); doc.update(doc.catalogRef, doc.catalog); return; }
  const nums: PdfObj[] = [];
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    const d = new Dict();
    if (r.style) d.set('S', Name.get(r.style));
    if (r.prefix) d.set('P', PdfString.fromText(r.prefix));
    if (r.first && r.first !== 1) d.set('St', r.first);
    nums.push(r.start, d);
  }
  doc.catalog.set('PageLabels', new Dict({ Nums: nums }));
  doc.update(doc.catalogRef, doc.catalog);
}

const roman = (n: number): string => { const t: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]; let s = ''; for (const [v, r] of t) while (n >= v) { s += r; n -= v; } return s; };
const alpha = (n: number): string => { let s = ''; n--; const l = String.fromCharCode(65 + (n % 26)); return s + l.repeat(Math.floor(n / 26) + 1); };

/** The label of each page (as readers show them), from the ranges. */
export function pageLabelList(ranges: LabelRange[], count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = [...ranges].reverse().find((x) => x.start <= i);
    if (!r) { out.push(String(i + 1)); continue; }
    const n = (r.first ?? 1) + (i - r.start);
    const num = r.style === 'R' ? roman(n) : r.style === 'r' ? roman(n).toLowerCase() : r.style === 'A' ? alpha(n) : r.style === 'a' ? alpha(n).toLowerCase() : r.style === 'D' ? String(n) : '';
    out.push((r.prefix || '') + num || String(i + 1));
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// Embedded files (attachments) and portfolios

export interface Attachment { name: string; description: string; size: number; mime: string; modified: Date | null; fileSpec: Dict; stream: PdfStream | null; /** 'names' (document level) or page index for FileAttachment annotations. */ where: 'document' | number; annot?: Ref | null; key?: string }

export function readAttachments(doc: PdfDocument): Attachment[] {
  const out: Attachment[] = [];
  const fromSpec = (fs: Dict, where: 'document' | number, key?: string, annot?: Ref | null): Attachment | null => {
    const ef = doc.getDict(fs, 'EF');
    const s = ef ? (doc.get(ef, 'UF') ?? doc.get(ef, 'F')) : null;
    const stream = s instanceof PdfStream ? s : null;
    const params = stream ? doc.getDict(stream, 'Params') : null;
    const name = doc.getText(fs, 'UF') || doc.getText(fs, 'F') || key || 'attachment';
    return { name, description: doc.getText(fs, 'Desc'), size: params ? doc.getNum(params, 'Size', stream ? stream.raw.length : 0) : stream ? stream.raw.length : 0, mime: stream ? doc.getName(stream, 'Subtype').replace('#2F', '/') : '', modified: params ? parsePdfDate(doc.getText(params, 'ModDate')) : null, fileSpec: fs, stream, where, annot, key };
  };
  const names = doc.getDict(doc.catalog, 'Names');
  for (const [k, v] of nameTreeEntries(doc, names ? doc.getDict(names, 'EmbeddedFiles') : null)) {
    const fs = doc.resolve<Dict | null>(v);
    if (fs instanceof Dict) { const a = fromSpec(fs, 'document', k); if (a) out.push(a); }
  }
  doc.pages.forEach((p, i) => {
    for (const ar of doc.getArray(p.dict, 'Annots') || []) {
      const a = doc.resolve<Dict | null>(ar);
      if (a instanceof Dict && doc.getName(a, 'Subtype') === 'FileAttachment') { const fs = doc.getDict(a, 'FS'); if (fs) { const att = fromSpec(fs, i, undefined, ar instanceof Ref ? ar : null); if (att) out.push(att); } }
    }
  });
  return out;
}

export function addAttachment(doc: PdfDocument, name: string, data: Uint8Array, opts: { description?: string; mime?: string } = {}): void {
  const stream = flateStream(data, { Type: Name.get('EmbeddedFile'), Subtype: Name.get((opts.mime || 'application/octet-stream').replace('/', '#2F')), Params: new Dict({ Size: data.length, ModDate: pdfDate() }) });
  const sref = doc.register(stream);
  const fs = new Dict({ Type: Name.get('Filespec'), F: PdfString.fromText(name), UF: PdfString.fromText(name, true), EF: new Dict({ F: sref, UF: sref }) });
  if (opts.description) fs.set('Desc', PdfString.fromText(opts.description));
  setNameTreeEntry(doc, 'EmbeddedFiles', name, doc.register(fs));
}

export function removeAttachment(doc: PdfDocument, a: Attachment): void {
  if (a.where === 'document' && a.key != null) deleteNameTreeEntry(doc, 'EmbeddedFiles', a.key);
  else if (typeof a.where === 'number' && a.annot) removeAnnotation(doc, doc.pages[a.where], a.annot);
}

export function isPortfolio(doc: PdfDocument): boolean { return !!doc.getDict(doc.catalog, 'Collection'); }

// ------------------------------------------------------------------------------------------
// Optional content (layers)

export interface Layer { name: string; ref: Ref; on: boolean }

export function readLayers(doc: PdfDocument): Layer[] {
  const oc = doc.getDict(doc.catalog, 'OCProperties');
  if (!oc) return [];
  const d = doc.getDict(oc, 'D');
  const off = new Set((d ? doc.getArray(d, 'OFF') || [] : []).filter((x): x is Ref => x instanceof Ref).map((r) => r.num));
  const out: Layer[] = [];
  for (const r of doc.getArray(oc, 'OCGs') || []) {
    if (!(r instanceof Ref)) continue;
    const g = doc.resolve<Dict | null>(r);
    if (g instanceof Dict) out.push({ name: doc.getText(g, 'Name') || `Layer ${r.num}`, ref: r, on: !off.has(r.num) });
  }
  return out;
}

export function setLayerVisible(doc: PdfDocument, layer: Layer, on: boolean): void {
  const oc = doc.getDict(doc.catalog, 'OCProperties');
  if (!oc) return;
  let d = doc.getDict(oc, 'D');
  if (!d) { d = new Dict(); oc.set('D', d); }
  const off = (doc.getArray(d, 'OFF') || []).filter((x) => !(x instanceof Ref && x.num === layer.ref.num));
  if (!on) off.push(layer.ref);
  d.set('OFF', off);
  const ocRef = doc.catalog.get('OCProperties');
  if (ocRef instanceof Ref) doc.touch(ocRef); else doc.update(doc.catalogRef, doc.catalog);
}

// ------------------------------------------------------------------------------------------
// Metadata

export interface Metadata { title: string; author: string; subject: string; keywords: string; creator: string; producer: string; created: Date | null; modified: Date | null; custom: Record<string, string>; xmp: string; language: string; version: string; tagged: boolean }

export function readMetadata(doc: PdfDocument): Metadata {
  const info = doc.info;
  const custom: Record<string, string> = {};
  const std = new Set(['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate', 'Trapped']);
  if (info) for (const k of info.keys()) if (!std.has(k)) custom[k] = doc.getText(info, k);
  const m = doc.get(doc.catalog, 'Metadata');
  let xmp = '';
  if (m instanceof PdfStream) { try { xmp = new TextDecoder().decode(doc.decoded(m)); } catch { xmp = ''; } }
  const x = (tag: string): string => { const r = new RegExp(`<${tag}[^>]*>(?:\\s*<rdf:(?:Alt|Seq|Bag)>\\s*<rdf:li[^>]*>)?([^<]*)`, 'i').exec(xmp); return r ? r[1].trim() : ''; };
  const mi = doc.getDict(doc.catalog, 'MarkInfo');
  return {
    title: doc.getText(info, 'Title') || x('dc:title'), author: doc.getText(info, 'Author') || x('dc:creator'), subject: doc.getText(info, 'Subject') || x('dc:description'),
    keywords: doc.getText(info, 'Keywords') || x('pdf:Keywords'), creator: doc.getText(info, 'Creator') || x('xmp:CreatorTool'), producer: doc.getText(info, 'Producer') || x('pdf:Producer'),
    created: parsePdfDate(doc.getText(info, 'CreationDate')) || (x('xmp:CreateDate') ? new Date(x('xmp:CreateDate')) : null), modified: parsePdfDate(doc.getText(info, 'ModDate')),
    custom, xmp, language: doc.getText(doc.catalog, 'Lang'), version: doc.report.header.replace('%PDF-', ''), tagged: !!mi && doc.get(mi, 'Marked') === true,
  };
}

const xmlEsc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function writeMetadata(doc: PdfDocument, m: Partial<Metadata>): void {
  const info = doc.ensureInfo();
  const set = (k: string, v: string | undefined) => { if (v === undefined) return; if (v) info.set(k, PdfString.fromText(v)); else info.delete(k); };
  set('Title', m.title); set('Author', m.author); set('Subject', m.subject); set('Keywords', m.keywords); set('Creator', m.creator); set('Producer', m.producer);
  if (m.custom) { for (const k of info.keys()) if (!['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate', 'Trapped'].includes(k)) info.delete(k); for (const [k, v] of Object.entries(m.custom)) if (k && v) info.set(k, PdfString.fromText(v)); }
  if (m.language !== undefined) { if (m.language) doc.catalog.set('Lang', PdfString.fromText(m.language)); else doc.catalog.delete('Lang'); }
  const cur = readMetadata(doc);
  const iso = (d: Date | null) => (d ? d.toISOString() : new Date().toISOString());
  const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(cur.title)}</rdf:li></rdf:Alt></dc:title>
<dc:creator><rdf:Seq><rdf:li>${xmlEsc(cur.author)}</rdf:li></rdf:Seq></dc:creator>
<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(cur.subject)}</rdf:li></rdf:Alt></dc:description>
<pdf:Keywords>${xmlEsc(cur.keywords)}</pdf:Keywords><pdf:Producer>${xmlEsc(cur.producer)}</pdf:Producer>
<xmp:CreatorTool>${xmlEsc(cur.creator)}</xmp:CreatorTool><xmp:CreateDate>${iso(cur.created)}</xmp:CreateDate><xmp:ModifyDate>${iso(new Date())}</xmp:ModifyDate>
</rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;
  const s = new PdfStream(new Dict({ Type: Name.get('Metadata'), Subtype: Name.get('XML') }), new TextEncoder().encode(xmp));
  s.dict.set('Length', s.raw.length);
  const old = doc.catalog.get('Metadata');
  if (old instanceof Ref) doc.update(old, s); else doc.catalog.set('Metadata', doc.register(s));
  doc.update(doc.catalogRef, doc.catalog);
}

// ------------------------------------------------------------------------------------------
// Annotations

export interface AnnotInfo { ref: Ref | null; dict: Dict; page: number; subtype: string; rect: [number, number, number, number]; contents: string; author: string; date: Date | null; name: string; color: [number, number, number] | null; hidden: boolean; irt: Ref | null; state?: string; opacity: number; fieldType?: string }

export function pageAnnotations(doc: PdfDocument, p: PageInfo): AnnotInfo[] {
  const out: AnnotInfo[] = [];
  for (const ar of doc.getArray(p.dict, 'Annots') || []) {
    const d = doc.resolve<Dict | null>(ar);
    if (!(d instanceof Dict)) continue;
    const rect = doc.rect(d.get('Rect')) || [0, 0, 0, 0];
    const c = doc.getArray(d, 'C');
    const color = c && c.length === 3 ? (c.map((x) => doc.resolve<number>(x)) as [number, number, number]) : c && c.length === 1 ? [doc.resolve<number>(c[0]), doc.resolve<number>(c[0]), doc.resolve<number>(c[0])] as [number, number, number] : null;
    const f = doc.getNum(d, 'F', 0);
    const irt = d.get('IRT');
    out.push({ ref: ar instanceof Ref ? ar : null, dict: d, page: p.index, subtype: doc.getName(d, 'Subtype'), rect, contents: doc.getText(d, 'Contents'), author: doc.getText(d, 'T'), date: parsePdfDate(doc.getText(d, 'M')) || parsePdfDate(doc.getText(d, 'CreationDate')), name: doc.getText(d, 'NM'), color, hidden: !!(f & 2), irt: irt instanceof Ref ? irt : null, state: doc.getText(d, 'State') || undefined, opacity: doc.getNum(d, 'CA', 1), fieldType: doc.getName(d, 'FT') || undefined });
  }
  return out;
}

export function allAnnotations(doc: PdfDocument): AnnotInfo[] { return doc.pages.flatMap((p) => pageAnnotations(doc, p)); }

export function addAnnotation(doc: PdfDocument, p: PageInfo, annot: Dict): Ref {
  annot.set('P', p.ref);
  const ref = doc.register(annot);
  const annots = (doc.getArray(p.dict, 'Annots') || []).slice();
  annots.push(ref);
  p.dict.set('Annots', annots);
  if (p.ref) doc.touch(p.ref);
  return ref;
}

export function removeAnnotation(doc: PdfDocument, p: PageInfo, ref: Ref): void {
  const annots = (doc.getArray(p.dict, 'Annots') || []).filter((a) => !(a instanceof Ref && a.num === ref.num));
  // Popups and replies of the annotation go too.
  const toRemove = new Set([ref.num]);
  for (const a of doc.getArray(p.dict, 'Annots') || []) {
    const d = doc.resolve<Dict | null>(a);
    if (!(d instanceof Dict) || !(a instanceof Ref)) continue;
    const parent = d.get('Parent'), irt = d.get('IRT');
    if ((parent instanceof Ref && parent.num === ref.num) || (irt instanceof Ref && irt.num === ref.num)) toRemove.add(a.num);
  }
  p.dict.set('Annots', annots.filter((a) => !(a instanceof Ref && toRemove.has(a.num))));
  for (const n of toRemove) doc.remove(new Ref(n, doc.genOf(n)));
  if (p.ref) doc.touch(p.ref);
}

// ------------------------------------------------------------------------------------------
// Forms

export type FieldType = 'text' | 'checkbox' | 'radio' | 'combo' | 'list' | 'button' | 'signature' | 'unknown';

export interface FieldInfo {
  ref: Ref; dict: Dict; name: string; type: FieldType; value: string | string[] | boolean; options: { value: string; label: string }[];
  flags: number; required: boolean; readOnly: boolean; multiline: boolean; password: boolean; maxLen: number;
  widgets: { ref: Ref; dict: Dict; page: number; rect: [number, number, number, number]; onState?: string }[];
  defaultAppearance: string; tooltip: string;
}

export function readFields(doc: PdfDocument): FieldInfo[] {
  const af = doc.getDict(doc.catalog, 'AcroForm');
  const out: FieldInfo[] = [];
  const pageOfAnnot = new Map<number, number>();
  doc.pages.forEach((p, i) => { for (const a of doc.getArray(p.dict, 'Annots') || []) if (a instanceof Ref) pageOfAnnot.set(a.num, i); });
  const seen = new Set<number>();
  const walk = (ref: PdfObj, inherited: Dict | null, prefix: string, depth: number) => {
    if (!(ref instanceof Ref) || seen.has(ref.num) || depth > 32) return;
    seen.add(ref.num);
    const d = doc.resolve<Dict | null>(ref);
    if (!(d instanceof Dict)) return;
    const inh = (k: string): PdfObj => (d.has(k) ? doc.get(d, k) : inherited ? doc.get(inherited, k) : null);
    const partial = doc.getText(d, 'T');
    const name = partial ? (prefix ? `${prefix}.${partial}` : partial) : prefix;
    const kids = doc.getArray(d, 'Kids') || [];
    const ft = inh('FT');
    const ftName = isName(ft) ? ft.name : '';
    const isField = !!ftName && (!kids.length || kids.every((k) => { const kd = doc.resolve<Dict | null>(k); return kd instanceof Dict && !kd.has('T'); }));
    if (isField) {
      const flags = typeof inh('Ff') === 'number' ? (inh('Ff') as number) : 0;
      let type: FieldType = 'unknown';
      if (ftName === 'Tx') type = 'text'; else if (ftName === 'Btn') type = flags & (1 << 16) ? 'button' : flags & (1 << 15) ? 'radio' : 'checkbox'; else if (ftName === 'Ch') type = flags & (1 << 17) ? 'combo' : 'list'; else if (ftName === 'Sig') type = 'signature';
      const v = inh('V');
      let value: string | string[] | boolean = '';
      if (type === 'checkbox') value = isName(v) ? v.name !== 'Off' : false;
      else if (type === 'radio') value = isName(v) && v.name !== 'Off' ? v.name : '';
      else if (Array.isArray(v)) value = v.map((x) => { const r = doc.resolve(x); return r instanceof PdfString ? r.toText() : isName(r) ? r.name : ''; });
      else if (v instanceof PdfString) value = v.toText(); else if (isName(v)) value = v.name;
      const opts = (inh('Opt') as PdfObj[] | null) || [];
      const options = Array.isArray(opts) ? opts.map((o) => { const r = doc.resolve(o); if (Array.isArray(r)) { const a = doc.resolve(r[0]), b = doc.resolve(r[1]); return { value: a instanceof PdfString ? a.toText() : '', label: b instanceof PdfString ? b.toText() : '' }; } const t = r instanceof PdfString ? r.toText() : ''; return { value: t, label: t }; }) : [];
      const widgets: FieldInfo['widgets'] = [];
      const widgetDicts: [Ref, Dict][] = kids.length ? kids.filter((k): k is Ref => k instanceof Ref).map((k) => [k, doc.resolve<Dict>(k)] as [Ref, Dict]).filter(([, kd]) => kd instanceof Dict) : [[ref, d]];
      for (const [wr, wd] of widgetDicts) {
        const page = pageOfAnnot.get(wr.num);
        const ap = doc.getDict(wd, 'AP'); const n = ap ? doc.getDict(ap, 'N') : null;
        const onState = n ? n.keys().find((k) => k !== 'Off') : undefined;
        widgets.push({ ref: wr, dict: wd, page: page ?? -1, rect: doc.rect(wd.get('Rect')) || [0, 0, 0, 0], onState });
      }
      const da = inh('DA');
      out.push({ ref, dict: d, name, type, value, options, flags, required: !!(flags & 2), readOnly: !!(flags & 1), multiline: !!(flags & (1 << 12)), password: !!(flags & (1 << 13)), maxLen: typeof inh('MaxLen') === 'number' ? (inh('MaxLen') as number) : 0, widgets, defaultAppearance: da instanceof PdfString ? da.toLatin1() : af ? doc.getText(af, 'DA') : '', tooltip: doc.getText(d, 'TU') });
      return;
    }
    for (const k of kids) walk(k, d, name, depth + 1);
  };
  for (const f of af ? doc.getArray(af, 'Fields') || [] : []) walk(f, null, '', 0);
  // Widgets not in /Fields (orphans): list them from the pages so they can be filled anyway.
  doc.pages.forEach((p) => { for (const a of doc.getArray(p.dict, 'Annots') || []) { if (!(a instanceof Ref) || seen.has(a.num)) continue; const d = doc.resolve<Dict | null>(a); if (d instanceof Dict && doc.getName(d, 'Subtype') === 'Widget') { const parent = d.get('Parent'); walk(parent instanceof Ref ? parent : a, null, '', 0); } } });
  return out;
}

export function ensureAcroForm(doc: PdfDocument): Dict {
  let af = doc.getDict(doc.catalog, 'AcroForm');
  if (!af) {
    af = new Dict({ Fields: [], DA: PdfString.fromText('/Helv 0 Tf 0 g'), DR: new Dict({ Font: new Dict({ Helv: doc.register(new Dict({ Type: Name.get('Font'), Subtype: Name.get('Type1'), BaseFont: Name.get('Helvetica'), Encoding: Name.get('WinAnsiEncoding') })) }) }) });
    doc.catalog.set('AcroForm', doc.register(af));
    doc.update(doc.catalogRef, doc.catalog);
  }
  return af;
}
export function touchAcroForm(doc: PdfDocument): void { const r = doc.catalog.get('AcroForm'); if (r instanceof Ref) doc.touch(r); else doc.update(doc.catalogRef, doc.catalog); }

// ------------------------------------------------------------------------------------------
// Signatures

export interface SignatureInfo { field: string; signer: string; reason: string; location: string; date: Date | null; filter: string; subFilter: string; byteRange: number[]; coversWholeFile: boolean; signed: boolean; contactInfo: string }

export function readSignatures(doc: PdfDocument): SignatureInfo[] {
  const out: SignatureInfo[] = [];
  for (const f of readFields(doc)) {
    if (f.type !== 'signature') continue;
    const v = doc.getDict(f.dict, 'V');
    if (!v) { out.push({ field: f.name, signer: '', reason: '', location: '', date: null, filter: '', subFilter: '', byteRange: [], coversWholeFile: false, signed: false, contactInfo: '' }); continue; }
    const br = (doc.getArray(v, 'ByteRange') || []).map((x) => doc.resolve<number>(x)).filter((x) => typeof x === 'number');
    const total = br.length === 4 ? br[2] + br[3] : 0;
    out.push({ field: f.name, signer: doc.getText(v, 'Name'), reason: doc.getText(v, 'Reason'), location: doc.getText(v, 'Location'), date: parsePdfDate(doc.getText(v, 'M')), filter: doc.getName(v, 'Filter'), subFilter: doc.getName(v, 'SubFilter'), byteRange: br, coversWholeFile: total === doc.buf.length, signed: true, contactInfo: doc.getText(v, 'ContactInfo') });
  }
  return out;
}

export { latin1 };
export const docTitle = (doc: PdfDocument): string => readMetadata(doc).title;
export const isDict = (o: unknown): o is Dict => o instanceof Dict;
export { dictOf };
