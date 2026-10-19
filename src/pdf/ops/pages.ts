/**
 * Page operations: insert, delete, move, rotate, duplicate, crop, scale, extract, split, merge,
 * headers/footers, Bates numbering, watermarks, backgrounds, N-up and booklet imposition.
 */
import { Dict, Name, PdfObj, PdfStream, PdfString, Ref, cloneObj } from '../objects';
import { flateStream } from '../filters';
import { PdfDocument, PageInfo } from '../document';
import { remapRefs, fmtNum } from '../writer';
import { addBlankPage, ensureFont, ensureXObject, ensureExtGState, litText, PAPER } from '../build';
import { textWidth, type StdFont } from '../stdfonts';
import { bytesOf, concat } from '../objects';

function kidsOf(doc: PdfDocument, node: Dict): PdfObj[] { return (doc.getArray(node, 'Kids') || []).slice(); }

/** Flattens the page tree: every page becomes a direct kid of the root (simplest correct structure for edits). */
export function flattenPageTree(doc: PdfDocument): void {
  const rootRef = doc.pagesRootRef;
  const root = doc.pagesRoot;
  if (!root || !rootRef) return;
  const pages = doc.pages;
  const kids = pages.map((p) => p.ref).filter((r): r is Ref => !!r);
  if (kids.length !== pages.length) return;
  for (const p of pages) { if (p.dict.get('Parent') instanceof Ref && (p.dict.get('Parent') as Ref).num !== rootRef.num) { p.dict.set('Parent', rootRef); } else p.dict.set('Parent', rootRef);
    // Make inherited attributes explicit so flattening loses nothing.
    if (!p.dict.has('MediaBox')) p.dict.set('MediaBox', [...p.mediaBox]);
    if (!p.dict.has('Resources') && p.resources) p.dict.set('Resources', p.resources);
    if (!p.dict.has('Rotate') && p.rotate) p.dict.set('Rotate', p.rotate);
    if (p.ref) doc.touch(p.ref);
  }
  root.set('Kids', kids);
  root.set('Count', kids.length);
  for (const k of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) root.delete(k);
  doc.update(rootRef, root);
  doc.invalidatePages();
}

export function setPageOrder(doc: PdfDocument, order: number[]): void {
  flattenPageTree(doc);
  const root = doc.pagesRoot!, rootRef = doc.pagesRootRef!;
  const pages = doc.pages;
  const kids = order.map((i) => pages[i].ref!).filter(Boolean);
  root.set('Kids', kids); root.set('Count', kids.length);
  doc.update(rootRef, root);
  doc.invalidatePages();
}

export function deletePages(doc: PdfDocument, indexes: number[]): void {
  const del = new Set(indexes);
  const keep = doc.pages.map((_, i) => i).filter((i) => !del.has(i));
  if (!keep.length) throw new Error('A document must keep at least one page.');
  const removed = doc.pages.filter((_, i) => del.has(i));
  setPageOrder(doc, keep);
  for (const p of removed) if (p.ref) doc.remove(p.ref);
}

export function movePages(doc: PdfDocument, indexes: number[], to: number): void {
  const n = doc.pages.length;
  const moving = [...new Set(indexes)].sort((a, b) => a - b);
  const rest = [...Array(n).keys()].filter((i) => !moving.includes(i));
  const before = moving.filter((i) => i < to).length;
  const at = Math.max(0, Math.min(rest.length, to - before));
  rest.splice(at, 0, ...moving);
  setPageOrder(doc, rest);
}

export function rotatePages(doc: PdfDocument, indexes: number[], delta: number): void {
  for (const i of indexes) {
    const p = doc.pages[i];
    if (!p) continue;
    p.dict.set('Rotate', ((p.rotate + delta) % 360 + 360) % 360);
    if (p.ref) doc.touch(p.ref);
  }
  doc.invalidatePages();
}

export function duplicatePages(doc: PdfDocument, indexes: number[]): void {
  flattenPageTree(doc);
  const root = doc.pagesRoot!, rootRef = doc.pagesRootRef!;
  const kids = kidsOf(doc, root);
  const pages = doc.pages;
  let added = 0;
  for (const i of [...indexes].sort((a, b) => a - b)) {
    const p = pages[i];
    const copy = cloneObj(p.dict) as Dict;
    copy.delete('Annots'); // annotations belong to one page
    const ref = doc.register(copy);
    kids.splice(i + 1 + added, 0, ref);
    added++;
  }
  root.set('Kids', kids); root.set('Count', kids.length);
  doc.update(rootRef, root);
  doc.invalidatePages();
}

export function insertBlankPages(doc: PdfDocument, at: number, count: number, size: [number, number]): void {
  for (let i = 0; i < count; i++) addBlankPage(doc, size, at + i);
}

export function setPageBox(doc: PdfDocument, indexes: number[], box: 'MediaBox' | 'CropBox' | 'BleedBox' | 'TrimBox' | 'ArtBox', rect: [number, number, number, number] | null): void {
  for (const i of indexes) {
    const p = doc.pages[i];
    if (!p) continue;
    if (rect) p.dict.set(box, rect); else p.dict.delete(box);
    if (p.ref) doc.touch(p.ref);
  }
  doc.invalidatePages();
}

/** Crops pages by margins (points) from each edge of the current crop box. */
export function cropPages(doc: PdfDocument, indexes: number[], m: { left: number; top: number; right: number; bottom: number }): void {
  for (const i of indexes) {
    const p = doc.pages[i];
    if (!p) continue;
    const [x0, y0, x1, y1] = p.cropBox;
    const r: [number, number, number, number] = [x0 + m.left, y0 + m.bottom, x1 - m.right, y1 - m.top];
    if (r[2] - r[0] < 10 || r[3] - r[1] < 10) continue;
    p.dict.set('CropBox', r);
    if (p.ref) doc.touch(p.ref);
  }
  doc.invalidatePages();
}

/** Scales page content (and boxes) by a factor, or to fit a paper size. */
export function scalePages(doc: PdfDocument, indexes: number[], target: { factor?: number; paper?: [number, number] }): void {
  for (const i of indexes) {
    const p = doc.pages[i];
    if (!p) continue;
    const [x0, y0, x1, y1] = p.mediaBox;
    const w = x1 - x0, h = y1 - y0;
    let s = target.factor ?? 1, nw = w * s, nh = h * s, dx = 0, dy = 0;
    if (target.paper) { s = Math.min(target.paper[0] / w, target.paper[1] / h); nw = target.paper[0]; nh = target.paper[1]; dx = (nw - w * s) / 2; dy = (nh - h * s) / 2; }
    const content = doc.pageContent(p);
    const pre = bytesOf(`q ${fmtNum(s)} 0 0 ${fmtNum(s)} ${fmtNum(dx - x0 * s)} ${fmtNum(dy - y0 * s)} cm\n`);
    doc.setPageContent(p, concat([pre, content, bytesOf('\nQ\n')]));
    p.dict.set('MediaBox', [0, 0, nw, nh]);
    for (const b of ['CropBox', 'BleedBox', 'TrimBox', 'ArtBox']) p.dict.delete(b);
    // Annotations move with the content.
    for (const a of doc.getArray(p.dict, 'Annots') || []) {
      const d = doc.resolve<Dict | null>(a);
      const r = d instanceof Dict ? doc.rect(d.get('Rect')) : null;
      if (d && r) { d.set('Rect', [(r[0] - x0) * s + dx, (r[1] - y0) * s + dy, (r[2] - x0) * s + dx, (r[3] - y0) * s + dy]); if (a instanceof Ref) doc.touch(a); }
    }
    if (p.ref) doc.touch(p.ref);
  }
  doc.invalidatePages();
}

// ------------------------------------------------------------------------------------------
// Copying pages between documents

/** Copies an object graph from `src` into `dst`, remapping references (streams keep their raw bytes). */
export function copyGraph(src: PdfDocument, dst: PdfDocument, obj: PdfObj, map = new Map<number, Ref>(), skipKeys = new Set<string>()): PdfObj {
  const mapRef = (r: Ref): Ref => {
    const got = map.get(r.num);
    if (got) return got;
    const placeholder = dst.register(null);
    map.set(r.num, placeholder);
    const o = src.fetch(r);
    const copied = copyGraph(src, dst, o, map, skipKeys);
    dst.update(placeholder, copied);
    return placeholder;
  };
  const walk = (o: PdfObj): PdfObj => {
    if (o instanceof Ref) return mapRef(o);
    if (Array.isArray(o)) return o.map(walk);
    if (o instanceof Dict) { const d = new Dict(); for (const [k, v] of o.map) { if (skipKeys.has(k)) continue; d.map.set(k, walk(v)); } return d; }
    if (o instanceof PdfStream) {
      // Streams are copied decoded-and-re-encoded only when the source is encrypted (raw bytes were decrypted already).
      const d = walk(o.dict) as Dict;
      const s = new PdfStream(d, o.raw);
      s.decoded = o.decoded;
      return s;
    }
    if (o instanceof PdfString) return new PdfString(o.bytes.slice(), o.hex);
    return o;
  };
  return walk(obj);
}

const PAGE_SKIP = new Set(['Parent', 'StructParents', 'B', 'PieceInfo']);

/** Appends pages of `src` (by index) to `dst` at position `at` (default end). Returns the new PageInfos. */
export function importPages(src: PdfDocument, dst: PdfDocument, indexes: number[], at?: number, opts: { keepAnnots?: boolean } = {}): PageInfo[] {
  flattenPageTree(dst);
  const root = dst.pagesRoot!, rootRef = dst.pagesRootRef!;
  const kids = kidsOf(dst, root);
  const map = new Map<number, Ref>();
  const skip = new Set(PAGE_SKIP);
  if (opts.keepAnnots === false) skip.add('Annots');
  const newRefs: Ref[] = [];
  for (const i of indexes) {
    const p = src.pages[i];
    if (!p) continue;
    const d = p.dict.clone();
    // Inherited attributes become explicit.
    if (!d.has('MediaBox')) d.set('MediaBox', [...p.mediaBox]);
    if (!d.has('Resources') && p.resources) d.set('Resources', p.resources);
    if (!d.has('Rotate') && p.rotate) d.set('Rotate', p.rotate);
    if (!d.has('CropBox') && p.cropBox !== p.mediaBox) d.set('CropBox', [...p.cropBox]);
    const copied = copyGraph(src, dst, d, map, skip) as Dict;
    copied.set('Parent', rootRef);
    copied.delete('Annots');
    if (opts.keepAnnots !== false && p.dict.has('Annots')) {
      const annots = (src.getArray(p.dict, 'Annots') || []).map((a) => { const ad = src.resolve<Dict | null>(a); if (!(ad instanceof Dict)) return null; if (src.getName(ad, 'Subtype') === 'Popup') return null; const c = copyGraph(src, dst, ad, map, new Set(['P', 'Parent', 'Popup', 'IRT', 'Dest'])) as Dict; return dst.register(c); }).filter((x): x is Ref => !!x);
      if (annots.length) { copied.set('Annots', annots); }
    }
    const ref = dst.register(copied);
    for (const a of dst.getArray(copied, 'Annots') || []) { const ad = dst.resolve<Dict>(a); ad.set('P', ref); }
    newRefs.push(ref);
  }
  const pos = at == null ? kids.length : Math.max(0, Math.min(kids.length, at));
  kids.splice(pos, 0, ...newRefs);
  root.set('Kids', kids); root.set('Count', kids.length);
  dst.update(rootRef, root);
  // Form fields of imported pages: merge into the destination AcroForm.
  const srcAf = src.getDict(src.catalog, 'AcroForm');
  if (srcAf && opts.keepAnnots !== false) {
    const fields = src.getArray(srcAf, 'Fields') || [];
    if (fields.length) {
      const dstAf = (() => { let af = dst.getDict(dst.catalog, 'AcroForm'); if (!af) { af = new Dict({ Fields: [] }); dst.catalog.set('AcroForm', dst.register(af)); dst.update(dst.catalogRef, dst.catalog); } return af; })();
      const dstFields = (dst.getArray(dstAf, 'Fields') || []).slice();
      for (const f of fields) if (f instanceof Ref && map.has(f.num)) dstFields.push(map.get(f.num)!);
      dstAf.set('Fields', dstFields);
      if (!dstAf.has('DA') && srcAf.has('DA')) dstAf.set('DA', srcAf.get('DA')!);
      if (!dstAf.has('DR') && srcAf.has('DR')) dstAf.set('DR', copyGraph(src, dst, srcAf.get('DR')!, map));
      const afRef = dst.catalog.get('AcroForm'); if (afRef instanceof Ref) dst.touch(afRef);
    }
  }
  dst.invalidatePages();
  const pages = dst.pages;
  return newRefs.map((r) => pages.find((p) => p.ref?.num === r.num)!).filter(Boolean);
}

/** A new document holding the given pages of `src`. */
export function extractPages(src: PdfDocument, indexes: number[]): PdfDocument {
  const dst = PdfDocument.create();
  importPages(src, dst, indexes);
  const info = src.info;
  if (info) { const di = dst.ensureInfo(); for (const k of ['Title', 'Author', 'Subject', 'Keywords']) if (info.has(k)) di.set(k, info.get(k)!); }
  return dst;
}

/** Page ranges like "1-3, 5, 8-" (1-based) → indexes. */
export function parseRanges(spec: string, count: number): number[] {
  const out = new Set<number>();
  for (const part of spec.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d*)\s*-\s*(\d*)$/.exec(part);
    if (m) { const a = m[1] ? +m[1] : 1, b = m[2] ? +m[2] : count; for (let i = Math.max(1, a); i <= Math.min(count, b); i++) out.add(i - 1); continue; }
    if (/^\d+$/.test(part)) { const n = +part; if (n >= 1 && n <= count) out.add(n - 1); continue; }
    if (/^(odd|even)$/i.test(part)) { for (let i = 0; i < count; i++) if ((i % 2 === 0) === (part.toLowerCase() === 'odd')) out.add(i); }
  }
  return [...out].sort((a, b) => a - b);
}

export type SplitMode = { kind: 'every'; n: number } | { kind: 'ranges'; ranges: string } | { kind: 'bookmarks'; items: { title: string; page: number }[] } | { kind: 'size'; maxBytes: number };

export function splitDocument(src: PdfDocument, mode: SplitMode): { name: string; doc: PdfDocument }[] {
  const n = src.pageCount;
  const groups: { name: string; pages: number[] }[] = [];
  if (mode.kind === 'every') { for (let i = 0; i < n; i += Math.max(1, mode.n)) groups.push({ name: `pages ${i + 1}-${Math.min(n, i + mode.n)}`, pages: [...Array(Math.min(mode.n, n - i)).keys()].map((k) => i + k) }); }
  else if (mode.kind === 'ranges') { for (const r of mode.ranges.split(/[;|]/)) { const pages = parseRanges(r, n); if (pages.length) groups.push({ name: r.trim(), pages }); } }
  else if (mode.kind === 'bookmarks') {
    const items = [...mode.items].sort((a, b) => a.page - b.page);
    if (!items.length || items[0].page > 0) items.unshift({ title: 'Front matter', page: 0 });
    items.forEach((it, i) => { const end = i + 1 < items.length ? items[i + 1].page : n; const pages = [...Array(Math.max(0, end - it.page)).keys()].map((k) => it.page + k); if (pages.length) groups.push({ name: it.title, pages }); });
  } else {
    // By size: add pages until the estimated size exceeds the limit (estimated from the page's content + image bytes).
    let cur: number[] = [], size = 0;
    for (let i = 0; i < n; i++) {
      const est = estimatePageBytes(src, src.pages[i]);
      if (cur.length && size + est > mode.maxBytes) { groups.push({ name: `part ${groups.length + 1}`, pages: cur }); cur = []; size = 0; }
      cur.push(i); size += est;
    }
    if (cur.length) groups.push({ name: `part ${groups.length + 1}`, pages: cur });
  }
  return groups.map((g) => ({ name: g.name.replace(/[\\/:*?"<>|]/g, '_'), doc: extractPages(src, g.pages) }));
}

export function estimatePageBytes(doc: PdfDocument, p: PageInfo): number {
  let total = 0;
  const seen = new Set<number>();
  const walk = (o: PdfObj, depth: number) => {
    if (depth > 6) return;
    if (o instanceof Ref) { if (seen.has(o.num)) return; seen.add(o.num); walk(doc.fetch(o), depth + 1); }
    else if (o instanceof PdfStream) { total += o.raw.length; walk(o.dict, depth + 1); }
    else if (o instanceof Dict) { for (const [k, v] of o.map) if (k !== 'Parent') walk(v, depth + 1); }
    else if (Array.isArray(o)) for (const v of o) walk(v, depth + 1);
  };
  walk(p.dict, 0);
  return total + 200;
}

// ------------------------------------------------------------------------------------------
// Overlays: headers/footers, Bates, watermarks, backgrounds

export interface OverlayText { text: string; font?: StdFont; size?: number; color?: [number, number, number]; position: 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right' | 'center'; margin?: number; opacity?: number; rotate?: number; underlay?: boolean }

/** Expands {page} {pages} {date} {bates:000001} {label} {title} in overlay text. */
export function expandTemplate(t: string, ctx: { page: number; pages: number; label?: string; title?: string; bates?: number }): string {
  return t.replace(/\{page\}/g, String(ctx.page)).replace(/\{pages\}/g, String(ctx.pages)).replace(/\{date\}/g, new Date().toLocaleDateString()).replace(/\{label\}/g, ctx.label ?? String(ctx.page)).replace(/\{title\}/g, ctx.title ?? '').replace(/\{bates(?::(\d+))?\}/g, (_m, pad) => String(ctx.bates ?? ctx.page).padStart(pad ? pad.length : 6, '0'));
}

export function addOverlayText(doc: PdfDocument, indexes: number[], spec: OverlayText, ctx: (i: number) => { label?: string; title?: string; bates?: number } = () => ({})): void {
  const font = spec.font || 'Helvetica', size = spec.size || 10, margin = spec.margin ?? 36;
  const rgb = spec.color || [0, 0, 0];
  const pages = doc.pages;
  for (const i of indexes) {
    const p = pages[i];
    if (!p) continue;
    const text = expandTemplate(spec.text, { page: i + 1, pages: pages.length, ...ctx(i) });
    const [x0, y0, x1, y1] = p.cropBox;
    const w = textWidth(text, font, size);
    const cx = spec.position.endsWith('left') ? x0 + margin : spec.position.endsWith('right') ? x1 - margin - w : (x0 + x1) / 2 - w / 2;
    const cy = spec.position.startsWith('top') ? y1 - margin : spec.position.startsWith('bottom') ? y0 + margin : (y0 + y1) / 2;
    const fname = ensureFont(doc, p, font);
    let gs = '';
    if (spec.opacity != null && spec.opacity < 1) gs = `/${ensureExtGState(doc, p, new Dict({ Type: Name.get('ExtGState'), CA: spec.opacity, ca: spec.opacity }))} gs `;
    const rot = spec.rotate || 0;
    const rad = (rot * Math.PI) / 180;
    const mtx = rot ? `${fmtNum(Math.cos(rad))} ${fmtNum(Math.sin(rad))} ${fmtNum(-Math.sin(rad))} ${fmtNum(Math.cos(rad))} ${fmtNum(cx + w / 2)} ${fmtNum(cy)} Tm -${fmtNum(w / 2)} 0 Td` : `${fmtNum(cx)} ${fmtNum(cy)} Td`;
    const ops = `q ${gs}BT /${fname} ${fmtNum(size)} Tf ${fmtNum(rgb[0])} ${fmtNum(rgb[1])} ${fmtNum(rgb[2])} rg ${mtx} ${litText(text)} Tj ET Q`;
    appendContent(doc, p, bytesOf(ops), !!spec.underlay);
  }
}

/** Appends (or prepends) content to a page, isolating the existing content in q…Q so its state leaks nowhere. */
export function appendContent(doc: PdfDocument, p: PageInfo, data: Uint8Array, prepend = false): void {
  const cur = doc.get(p.dict, 'Contents');
  const list: PdfObj[] = Array.isArray(cur) ? cur.slice() : cur ? [p.dict.get('Contents')!] : [];
  // Wrap existing content in q/Q once (marked by a tiny stream).
  const wrapped = (p.dict as any).__qfWrapped;
  if (!wrapped && list.length) { list.unshift(doc.register(flateStream(bytesOf('q\n'), {}, false))); list.push(doc.register(flateStream(bytesOf('\nQ\n'), {}, false))); (p.dict as any).__qfWrapped = true; }
  const s = doc.register(flateStream(concat([bytesOf('\n'), data, bytesOf('\n')])));
  if (prepend) list.unshift(s); else list.push(s);
  p.dict.set('Contents', list);
  if (p.ref) doc.touch(p.ref);
}

export function addBates(doc: PdfDocument, indexes: number[], opts: { prefix?: string; suffix?: string; start: number; digits: number; position: OverlayText['position']; size?: number }): void {
  const digits = Math.max(1, opts.digits);
  const sorted = [...indexes].sort((a, b) => a - b);
  addOverlayText(doc, sorted, { text: `${opts.prefix || ''}{bates:${'0'.repeat(digits)}}${opts.suffix || ''}`, position: opts.position, size: opts.size || 10, font: 'Helvetica' }, (i) => ({ bates: opts.start + sorted.indexOf(i) }));
}

export function addWatermark(doc: PdfDocument, indexes: number[], text: string, opts: { size?: number; opacity?: number; color?: [number, number, number]; rotate?: number; underlay?: boolean } = {}): void {
  addOverlayText(doc, indexes, { text, position: 'center', size: opts.size || 60, opacity: opts.opacity ?? 0.25, color: opts.color || [0.6, 0.6, 0.6], rotate: opts.rotate ?? 45, font: 'Helvetica-Bold', underlay: opts.underlay });
}

export function addImageOverlay(doc: PdfDocument, indexes: number[], image: Ref, box: { x: number; y: number; w: number; h: number }, opts: { opacity?: number; underlay?: boolean } = {}): void {
  for (const i of indexes) {
    const p = doc.pages[i];
    if (!p) continue;
    const name = ensureXObject(doc, p, 'QFIm', image);
    let gs = '';
    if (opts.opacity != null && opts.opacity < 1) gs = `/${ensureExtGState(doc, p, new Dict({ Type: Name.get('ExtGState'), CA: opts.opacity, ca: opts.opacity }))} gs `;
    appendContent(doc, p, bytesOf(`q ${gs}${fmtNum(box.w)} 0 0 ${fmtNum(box.h)} ${fmtNum(box.x)} ${fmtNum(box.y)} cm /${name} Do Q`), !!opts.underlay);
  }
}

export function setBackgroundColor(doc: PdfDocument, indexes: number[], rgb: [number, number, number]): void {
  for (const i of indexes) {
    const p = doc.pages[i];
    if (!p) continue;
    const [x0, y0, x1, y1] = p.mediaBox;
    appendContent(doc, p, bytesOf(`q ${fmtNum(rgb[0])} ${fmtNum(rgb[1])} ${fmtNum(rgb[2])} rg ${fmtNum(x0)} ${fmtNum(y0)} ${fmtNum(x1 - x0)} ${fmtNum(y1 - y0)} re f Q`), true);
  }
}

// ------------------------------------------------------------------------------------------
// Imposition: pages as form XObjects on new sheets

/** Turns a page into a Form XObject (content + resources + bbox) for placing on other pages. */
export function pageAsForm(doc: PdfDocument, p: PageInfo): Ref {
  const content = doc.pageContent(p);
  const [x0, y0, x1, y1] = p.cropBox;
  const rot = p.rotate;
  let matrix: number[] = [1, 0, 0, 1, 0, 0];
  if (rot === 90) matrix = [0, -1, 1, 0, -y0 + 0, x1]; else if (rot === 180) matrix = [-1, 0, 0, -1, x1 + x0, y1 + y0]; else if (rot === 270) matrix = [0, 1, -1, 0, y1, -x0];
  const s = flateStream(content, { Type: Name.get('XObject'), Subtype: Name.get('Form'), BBox: [x0, y0, x1, y1], Matrix: matrix, Resources: p.resources ? cloneObj(p.resources) : new Dict() });
  return doc.register(s);
}

export function nUp(src: PdfDocument, opts: { cols: number; rows: number; paper: [number, number]; margin?: number; gap?: number; pages?: number[]; order?: 'across' | 'down' }): PdfDocument {
  const dst = PdfDocument.create();
  const map = new Map<number, Ref>();
  const indexes = opts.pages || src.pages.map((_, i) => i);
  const per = opts.cols * opts.rows;
  const margin = opts.margin ?? 18, gap = opts.gap ?? 12;
  const cellW = (opts.paper[0] - margin * 2 - gap * (opts.cols - 1)) / opts.cols, cellH = (opts.paper[1] - margin * 2 - gap * (opts.rows - 1)) / opts.rows;
  for (let s = 0; s < indexes.length; s += per) {
    const sheet = addBlankPage(dst, opts.paper);
    const ops: string[] = [];
    for (let k = 0; k < per && s + k < indexes.length; k++) {
      const p = src.pages[indexes[s + k]];
      const form = copyGraph(src, dst, src.fetch(pageAsForm(src, p)), map) as PdfStream;
      const fref = dst.register(form);
      const name = ensureXObject(dst, sheet, 'Pg', fref);
      const col = opts.order === 'down' ? Math.floor(k / opts.rows) : k % opts.cols, row = opts.order === 'down' ? k % opts.rows : Math.floor(k / opts.cols);
      const pw = p.width, ph = p.height;
      const sc = Math.min(cellW / pw, cellH / ph);
      const x = margin + col * (cellW + gap) + (cellW - pw * sc) / 2, y = opts.paper[1] - margin - (row + 1) * cellH - row * gap + (cellH - ph * sc) / 2;
      const [bx0, by0] = p.cropBox;
      ops.push(`q ${fmtNum(sc)} 0 0 ${fmtNum(sc)} ${fmtNum(x - bx0 * sc)} ${fmtNum(y - by0 * sc)} cm /${name} Do Q`);
    }
    dst.setPageContent(sheet, bytesOf(ops.join('\n')));
  }
  return dst;
}

/** Booklet order (saddle stitch): sheets with 2 pages per side, printed duplex. */
export function booklet(src: PdfDocument, paper: [number, number] = [PAPER.letter[1], PAPER.letter[0]]): PdfDocument {
  const n = src.pageCount;
  const total = Math.ceil(n / 4) * 4;
  const order: (number | null)[] = [];
  for (let i = 0; i < total / 2; i++) {
    const a = total - 1 - i, b = i;
    if (i % 2 === 0) order.push(a < n ? a : null, b < n ? b : null); else order.push(b < n ? b : null, a < n ? a : null);
  }
  const dst = PdfDocument.create();
  const map = new Map<number, Ref>();
  for (let s = 0; s < order.length; s += 2) {
    const sheet = addBlankPage(dst, paper);
    const ops: string[] = [];
    [order[s], order[s + 1]].forEach((pi, k) => {
      if (pi == null) return;
      const p = src.pages[pi];
      const form = copyGraph(src, dst, src.fetch(pageAsForm(src, p)), map) as PdfStream;
      const name = ensureXObject(dst, sheet, 'Pg', dst.register(form));
      const cellW = paper[0] / 2, cellH = paper[1];
      const sc = Math.min((cellW - 24) / p.width, (cellH - 24) / p.height);
      const x = k * cellW + (cellW - p.width * sc) / 2, y = (cellH - p.height * sc) / 2;
      ops.push(`q ${fmtNum(sc)} 0 0 ${fmtNum(sc)} ${fmtNum(x - p.cropBox[0] * sc)} ${fmtNum(y - p.cropBox[1] * sc)} cm /${name} Do Q`);
    });
    dst.setPageContent(sheet, bytesOf(ops.join('\n')));
  }
  return dst;
}

/** Reverses page order. */
export function reversePages(doc: PdfDocument): void { setPageOrder(doc, doc.pages.map((_, i) => i).reverse()); }

export { remapRefs, PAPER };
