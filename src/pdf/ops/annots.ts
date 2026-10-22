/**
 * Annotations (ISO 32000-1 §12.5): creating markup, notes, free text, shapes, ink, stamps, links,
 * file attachments and redaction marks with generated appearance streams; editing; replies and
 * review states; XFDF import/export; applying redactions to page content.
 */
import { Dict, Name, PdfObj, PdfStream, PdfString, Ref, pdfDate } from '../objects';
import { flateStream } from '../filters';
import { PdfDocument, PageInfo } from '../document';
import { fmtNum } from '../writer';
import { addAnnotation, pageAnnotations, removeAnnotation, AnnotInfo } from '../structure';
import { stdFontRef, lit } from '../build';
import { textWidth, winAnsiBytes, wrapText, type StdFont } from '../stdfonts';
import { parseContent, serializeContent, analyzeContent, rectsOverlap, Op } from '../content';
import { bytesOf, concat } from '../objects';

export type RGB = [number, number, number];
export type Rect = [number, number, number, number];

const norm = (r: Rect): Rect => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];

export interface AnnotBase { author?: string; contents?: string; color?: RGB; opacity?: number; subject?: string }

function baseDict(subtype: string, rect: Rect, b: AnnotBase): Dict {
  const d = new Dict({ Type: Name.get('Annot'), Subtype: Name.get(subtype), Rect: norm(rect), F: 4, M: pdfDate(), CreationDate: pdfDate(), NM: PdfString.fromText(`qf-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`) });
  if (b.author) d.set('T', PdfString.fromText(b.author));
  if (b.contents) d.set('Contents', PdfString.fromText(b.contents));
  if (b.color) d.set('C', b.color);
  if (b.opacity != null && b.opacity < 1) d.set('CA', b.opacity);
  if (b.subject) d.set('Subj', PdfString.fromText(b.subject));
  return d;
}

/** A form XObject for an appearance stream. */
function appearance(doc: PdfDocument, bbox: Rect, content: string, extra: Record<string, PdfObj> = {}, resources?: Dict): Ref {
  const s = flateStream(bytesOf(content), { Type: Name.get('XObject'), Subtype: Name.get('Form'), BBox: bbox, Resources: resources || new Dict(), ...extra });
  return doc.register(s);
}

function withOpacity(doc: PdfDocument, opacity: number | undefined, blend?: string): { res: Dict; gs: string } {
  const res = new Dict();
  if ((opacity != null && opacity < 1) || blend) {
    const g = new Dict({ Type: Name.get('ExtGState') });
    if (opacity != null && opacity < 1) { g.set('CA', opacity); g.set('ca', opacity); }
    if (blend) g.set('BM', Name.get(blend));
    res.set('ExtGState', new Dict({ GS: doc.register(g) }));
    return { res, gs: '/GS gs ' };
  }
  return { res, gs: '' };
}

const rg = (c: RGB) => `${fmtNum(c[0])} ${fmtNum(c[1])} ${fmtNum(c[2])} rg`;
const RG = (c: RGB) => `${fmtNum(c[0])} ${fmtNum(c[1])} ${fmtNum(c[2])} RG`;

// ------------------------------------------------------------------------------------------
// Text markup

export type MarkupKind = 'Highlight' | 'Underline' | 'StrikeOut' | 'Squiggly';

/** Quads: [x1 y1 x2 y2 x3 y3 x4 y4] per rectangle in the order PDF wants (upper-left, upper-right, lower-left, lower-right). */
export function quadsFromRects(rects: Rect[]): number[] {
  const out: number[] = [];
  for (const r of rects.map(norm)) out.push(r[0], r[3], r[2], r[3], r[0], r[1], r[2], r[1]);
  return out;
}

export function addTextMarkup(doc: PdfDocument, p: PageInfo, kind: MarkupKind, rects: Rect[], b: AnnotBase = {}): Ref {
  const color = b.color || (kind === 'Highlight' ? [1, 1, 0] : kind === 'StrikeOut' ? [1, 0, 0] : [0, 0, 1]);
  const all = rects.map(norm);
  const bbox: Rect = [Math.min(...all.map((r) => r[0])), Math.min(...all.map((r) => r[1])), Math.max(...all.map((r) => r[2])), Math.max(...all.map((r) => r[3]))];
  const d = baseDict(kind, bbox, { ...b, color });
  d.set('QuadPoints', quadsFromRects(all));
  const { res, gs } = withOpacity(doc, b.opacity, kind === 'Highlight' ? 'Multiply' : undefined);
  let ops = `${gs}${rg(color)} ${RG(color)} `;
  for (const r of all) {
    const h = r[3] - r[1];
    if (kind === 'Highlight') ops += `${fmtNum(r[0])} ${fmtNum(r[1])} ${fmtNum(r[2] - r[0])} ${fmtNum(h)} re f `;
    else if (kind === 'Underline') ops += `${fmtNum(Math.max(0.6, h * 0.06))} w ${fmtNum(r[0])} ${fmtNum(r[1] + h * 0.08)} m ${fmtNum(r[2])} ${fmtNum(r[1] + h * 0.08)} l S `;
    else if (kind === 'StrikeOut') ops += `${fmtNum(Math.max(0.6, h * 0.07))} w ${fmtNum(r[0])} ${fmtNum(r[1] + h * 0.42)} m ${fmtNum(r[2])} ${fmtNum(r[1] + h * 0.42)} l S `;
    else { const amp = Math.max(1, h * 0.08); let x = r[0], up = true; ops += `${fmtNum(Math.max(0.5, h * 0.05))} w ${fmtNum(x)} ${fmtNum(r[1])} m `; while (x < r[2]) { x = Math.min(r[2], x + amp); ops += `${fmtNum(x)} ${fmtNum(r[1] + (up ? amp : 0))} l `; up = !up; } ops += 'S '; }
  }
  d.set('AP', new Dict({ N: appearance(doc, bbox, ops, {}, res) }));
  return addAnnotation(doc, p, d);
}

// ------------------------------------------------------------------------------------------
// Notes, free text, shapes, ink, stamps

export function addNote(doc: PdfDocument, p: PageInfo, x: number, y: number, b: AnnotBase & { icon?: string } = {}): Ref {
  const color = b.color || [1, 0.85, 0.2];
  const rect: Rect = [x, y - 20, x + 20, y];
  const d = baseDict('Text', rect, { ...b, color });
  d.set('Name', Name.get(b.icon || 'Comment'));
  d.set('Open', false);
  const ops = `${rg(color)} 0.2 0.2 0.2 RG 0.8 w 1 1 18 18 re B 0.2 0.2 0.2 rg BT /F1 7 Tf 3.5 11 Td (...) Tj ET`;
  const res = new Dict({ Font: new Dict({ F1: stdFontRef(doc, 'Helvetica-Bold') }) });
  d.set('AP', new Dict({ N: appearance(doc, [0, 0, 20, 20], ops, {}, res) }));
  const ref = addAnnotation(doc, p, d);
  addPopup(doc, p, ref, [x + 24, y - 120, x + 204, y]);
  return ref;
}

export function addPopup(doc: PdfDocument, p: PageInfo, parent: Ref, rect: Rect): Ref {
  const pop = new Dict({ Type: Name.get('Annot'), Subtype: Name.get('Popup'), Rect: rect, Parent: parent, Open: false, F: 28 });
  const ref = addAnnotation(doc, p, pop);
  const pd = doc.resolve<Dict>(parent); pd.set('Popup', ref); doc.touch(parent);
  return ref;
}

export interface FreeTextOpts extends AnnotBase { text: string; font?: StdFont; size?: number; textColor?: RGB; fill?: RGB | null; border?: RGB | null; borderWidth?: number; align?: 'left' | 'center' | 'right'; callout?: [number, number, number, number, number, number] }

export function addFreeText(doc: PdfDocument, p: PageInfo, rect: Rect, o: FreeTextOpts): Ref {
  const r = norm(rect);
  const font = o.font || 'Helvetica', size = o.size || 12, tc = o.textColor || [0, 0, 0];
  const d = baseDict('FreeText', r, { ...o, contents: o.text });
  d.set('DA', PdfString.fromText(`/F1 ${fmtNum(size)} Tf ${rg(tc)}`));
  d.set('Q', o.align === 'center' ? 1 : o.align === 'right' ? 2 : 0);
  if (o.callout) { d.set('IT', Name.get('FreeTextCallout')); d.set('CL', o.callout); d.set('LE', Name.get('OpenArrow')); }
  const w = r[2] - r[0], h = r[3] - r[1];
  const pad = 3;
  let ops = '';
  if (o.fill) ops += `${rg(o.fill)} 0 0 ${fmtNum(w)} ${fmtNum(h)} re f `;
  if (o.border) ops += `${RG(o.border)} ${fmtNum(o.borderWidth ?? 1)} w ${fmtNum((o.borderWidth ?? 1) / 2)} ${fmtNum((o.borderWidth ?? 1) / 2)} ${fmtNum(w - (o.borderWidth ?? 1))} ${fmtNum(h - (o.borderWidth ?? 1))} re S `;
  const lines = wrapText(o.text, font, size, w - pad * 2);
  ops += `BT ${rg(tc)} /F1 ${fmtNum(size)} Tf `;
  lines.forEach((l, i) => {
    const lw = textWidth(l, font, size);
    const x = o.align === 'center' ? (w - lw) / 2 : o.align === 'right' ? w - pad - lw : pad;
    const y = h - pad - size * 0.85 - i * size * 1.2;
    if (y < -size) return;
    ops += `1 0 0 1 ${fmtNum(x)} ${fmtNum(y)} Tm ${lit(winAnsiBytes(l))} Tj `;
  });
  ops += 'ET';
  const res = new Dict({ Font: new Dict({ F1: stdFontRef(doc, font) }) });
  d.set('AP', new Dict({ N: appearance(doc, [0, 0, w, h], ops, { Matrix: [1, 0, 0, 1, 0, 0] }, res) }));
  // Appearance BBox is local; the annotation Rect places it. Use Matrix identity with BBox origin 0: set BBox to rect instead.
  const ap = doc.resolve<PdfStream>((d.get('AP') as Dict).get('N') as Ref);
  ap.dict.set('BBox', [0, 0, w, h]);
  ap.dict.set('Matrix', [1, 0, 0, 1, 0, 0]);
  if (o.callout) {
    // Draw the callout line in page coordinates by extending the bbox.
    const c = o.callout;
    const bx: Rect = [Math.min(r[0], c[0], c[2], c[4]), Math.min(r[1], c[1], c[3], c[5]), Math.max(r[2], c[0], c[2], c[4]), Math.max(r[3], c[1], c[3], c[5])];
    d.set('Rect', bx);
    d.set('RD', [r[0] - bx[0], r[1] - bx[1], bx[2] - r[2], bx[3] - r[3]]);
    const shift = `1 0 0 1 ${fmtNum(r[0] - bx[0])} ${fmtNum(r[1] - bx[1])} cm `;
    const line = `${RG(o.border || tc)} 1 w ${fmtNum(c[0] - bx[0])} ${fmtNum(c[1] - bx[1])} m ${fmtNum(c[2] - bx[0])} ${fmtNum(c[3] - bx[1])} l ${fmtNum(c[4] - bx[0])} ${fmtNum(c[5] - bx[1])} l S `;
    const full = `q ${line} Q q ${shift}${ops} Q`;
    d.set('AP', new Dict({ N: appearance(doc, [0, 0, bx[2] - bx[0], bx[3] - bx[1]], full, {}, res) }));
  }
  return addAnnotation(doc, p, d);
}

export type ShapeKind = 'Square' | 'Circle' | 'Line' | 'Polygon' | 'PolyLine' | 'Cloud';
export interface ShapeOpts extends AnnotBase { stroke?: RGB; fill?: RGB | null; width?: number; points?: [number, number][]; arrow?: boolean; dashed?: boolean }

export function addShape(doc: PdfDocument, p: PageInfo, kind: ShapeKind, rect: Rect, o: ShapeOpts = {}): Ref {
  const r = norm(rect);
  const stroke = o.stroke || o.color || [1, 0, 0], lw = o.width ?? 2;
  const pts = o.points || [];
  const bbox: Rect = pts.length ? [Math.min(r[0], ...pts.map((q) => q[0])) - lw, Math.min(r[1], ...pts.map((q) => q[1])) - lw, Math.max(r[2], ...pts.map((q) => q[0])) + lw, Math.max(r[3], ...pts.map((q) => q[1])) + lw] : [r[0] - lw, r[1] - lw, r[2] + lw, r[3] + lw];
  const sub = kind === 'Cloud' ? 'Polygon' : kind;
  const d = baseDict(sub, bbox, { ...o, color: stroke });
  if (o.fill) d.set('IC', o.fill);
  const bs = new Dict({ W: lw, S: Name.get(o.dashed ? 'D' : 'S') });
  if (o.dashed) bs.set('D', [4, 2]);
  d.set('BS', bs);
  const { res, gs } = withOpacity(doc, o.opacity);
  let ops = `${gs}${RG(stroke)} ${o.fill ? rg(o.fill) + ' ' : ''}${fmtNum(lw)} w ${o.dashed ? '[4 2] 0 d ' : ''}`;
  const paint = o.fill ? 'B' : 'S';
  const X = (x: number) => fmtNum(x - bbox[0]), Y = (y: number) => fmtNum(y - bbox[1]);
  if (kind === 'Square') ops += `${X(r[0] + lw / 2)} ${Y(r[1] + lw / 2)} ${fmtNum(r[2] - r[0] - lw)} ${fmtNum(r[3] - r[1] - lw)} re ${paint}`;
  else if (kind === 'Circle') {
    const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2, rx = (r[2] - r[0]) / 2 - lw / 2, ry = (r[3] - r[1]) / 2 - lw / 2, k = 0.5523;
    ops += `${X(cx + rx)} ${Y(cy)} m ${X(cx + rx)} ${Y(cy + ry * k)} ${X(cx + rx * k)} ${Y(cy + ry)} ${X(cx)} ${Y(cy + ry)} c ${X(cx - rx * k)} ${Y(cy + ry)} ${X(cx - rx)} ${Y(cy + ry * k)} ${X(cx - rx)} ${Y(cy)} c ${X(cx - rx)} ${Y(cy - ry * k)} ${X(cx - rx * k)} ${Y(cy - ry)} ${X(cx)} ${Y(cy - ry)} c ${X(cx + rx * k)} ${Y(cy - ry)} ${X(cx + rx)} ${Y(cy - ry * k)} ${X(cx + rx)} ${Y(cy)} c ${paint}`;
  } else if (kind === 'Line') {
    const a = pts[0] || [r[0], r[1]], b = pts[1] || [r[2], r[3]];
    d.set('L', [a[0], a[1], b[0], b[1]]);
    ops += `${X(a[0])} ${Y(a[1])} m ${X(b[0])} ${Y(b[1])} l S`;
    if (o.arrow) {
      d.set('LE', [Name.get('None'), Name.get('OpenArrow')]);
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), len = Math.max(8, lw * 4);
      for (const s of [1, -1]) ops += ` ${X(b[0])} ${Y(b[1])} m ${X(b[0] - len * Math.cos(ang + s * 0.5))} ${Y(b[1] - len * Math.sin(ang + s * 0.5))} l S`;
    }
  } else if (kind === 'Polygon' || kind === 'PolyLine' || kind === 'Cloud') {
    d.set('Vertices', pts.flat());
    if (kind === 'Cloud') { d.set('IT', Name.get('PolygonCloud')); d.set('BE', new Dict({ S: Name.get('C'), I: 1 })); }
    if (pts.length) {
      ops += pts.map((q, i) => `${X(q[0])} ${Y(q[1])} ${i ? 'l' : 'm'}`).join(' ');
      if (kind === 'Cloud') {
        // Scallops along each edge.
        let cloud = '';
        const rad = Math.max(6, lw * 3);
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1, n = Math.max(1, Math.round(len / (rad * 1.6)));
          for (let k = 0; k < n; k++) { const cx = a[0] + (dx * (k + 0.5)) / n, cy = a[1] + (dy * (k + 0.5)) / n; cloud += ` ${X(cx + rad)} ${Y(cy)} m ${X(cx + rad)} ${Y(cy + rad * 0.55)} ${X(cx + rad * 0.55)} ${Y(cy + rad)} ${X(cx)} ${Y(cy + rad)} c ${X(cx - rad * 0.55)} ${Y(cy + rad)} ${X(cx - rad)} ${Y(cy + rad * 0.55)} ${X(cx - rad)} ${Y(cy)} c ${X(cx - rad)} ${Y(cy - rad * 0.55)} ${X(cx - rad * 0.55)} ${Y(cy - rad)} ${X(cx)} ${Y(cy - rad)} c ${X(cx + rad * 0.55)} ${Y(cy - rad)} ${X(cx + rad)} ${Y(cy - rad * 0.55)} ${X(cx + rad)} ${Y(cy)} c`; }
        }
        ops += ` ${o.fill ? 'f' : 'n'}${cloud} ${paint}`;
      } else ops += kind === 'Polygon' ? ` h ${paint}` : ' S';
    }
  }
  d.set('AP', new Dict({ N: appearance(doc, [0, 0, bbox[2] - bbox[0], bbox[3] - bbox[1]], ops, {}, res) }));
  return addAnnotation(doc, p, d);
}

export function addInk(doc: PdfDocument, p: PageInfo, strokes: [number, number][][], o: AnnotBase & { width?: number; highlighter?: boolean } = {}): Ref {
  const color = o.color || (o.highlighter ? [1, 1, 0] : [0, 0, 1]);
  const lw = o.width ?? (o.highlighter ? 12 : 2);
  const all = strokes.flat();
  if (!all.length) throw new Error('An ink annotation needs at least one point.');
  const bbox: Rect = [Math.min(...all.map((q) => q[0])) - lw, Math.min(...all.map((q) => q[1])) - lw, Math.max(...all.map((q) => q[0])) + lw, Math.max(...all.map((q) => q[1])) + lw];
  const d = baseDict('Ink', bbox, { ...o, color, opacity: o.highlighter ? (o.opacity ?? 0.5) : o.opacity });
  d.set('InkList', strokes.map((s) => s.flat()));
  d.set('BS', new Dict({ W: lw }));
  const { res, gs } = withOpacity(doc, o.highlighter ? (o.opacity ?? 0.5) : o.opacity, o.highlighter ? 'Multiply' : undefined);
  let ops = `${gs}${RG(color)} ${fmtNum(lw)} w 1 J 1 j `;
  for (const s of strokes) { if (!s.length) continue; ops += s.map((q, i) => `${fmtNum(q[0] - bbox[0])} ${fmtNum(q[1] - bbox[1])} ${i ? 'l' : 'm'}`).join(' ') + (s.length === 1 ? ` ${fmtNum(s[0][0] - bbox[0])} ${fmtNum(s[0][1] - bbox[1])} l` : '') + ' S '; }
  d.set('AP', new Dict({ N: appearance(doc, [0, 0, bbox[2] - bbox[0], bbox[3] - bbox[1]], ops, {}, res) }));
  return addAnnotation(doc, p, d);
}

export const STAMP_TEXTS = ['Approved', 'Draft', 'Confidential', 'Final', 'For Review', 'Not Approved', 'Received', 'Revised', 'Void', 'Completed', 'Sign Here', 'Witness', 'Initial Here', 'Top Secret', 'Expired', 'Experimental', 'Departmental', 'Preliminary Results', 'Information Only', 'For Public Release', 'Not For Public Release', 'Sold', 'For Comment', 'As Is'];

export function addTextStamp(doc: PdfDocument, p: PageInfo, rect: Rect, text: string, o: AnnotBase & { rotate?: number } = {}): Ref {
  const r = norm(rect);
  const color = o.color || [0.8, 0.1, 0.1];
  const d = baseDict('Stamp', r, { ...o, color, contents: o.contents || text });
  d.set('Name', Name.get('QF' + text.replace(/[^A-Za-z]/g, '')));
  const w = r[2] - r[0], h = r[3] - r[1];
  const font: StdFont = 'Helvetica-Bold';
  let size = h * 0.6;
  while (size > 4 && textWidth(text, font, size) > w - 12) size *= 0.9;
  const tw = textWidth(text, font, size);
  const { res, gs } = withOpacity(doc, o.opacity ?? 0.85);
  res.set('Font', new Dict({ F1: stdFontRef(doc, font) }));
  const ops = `${gs}${RG(color)} ${rg(color)} 2 w 1 1 ${fmtNum(w - 2)} ${fmtNum(h - 2)} re S BT /F1 ${fmtNum(size)} Tf ${fmtNum((w - tw) / 2)} ${fmtNum((h - size * 0.7) / 2)} Td ${lit(winAnsiBytes(text))} Tj ET`;
  const ap = appearance(doc, [0, 0, w, h], ops, {}, res);
  if (o.rotate) { const s = doc.resolve<PdfStream>(ap); const a = (o.rotate * Math.PI) / 180; s.dict.set('Matrix', [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]); }
  d.set('AP', new Dict({ N: ap }));
  return addAnnotation(doc, p, d);
}

export function addImageStamp(doc: PdfDocument, p: PageInfo, rect: Rect, image: Ref, o: AnnotBase & { name?: string } = {}): Ref {
  const r = norm(rect);
  const d = baseDict('Stamp', r, o);
  d.set('Name', Name.get(o.name || 'QFImage'));
  const w = r[2] - r[0], h = r[3] - r[1];
  const res = new Dict({ XObject: new Dict({ Im: image }) });
  d.set('AP', new Dict({ N: appearance(doc, [0, 0, w, h], `q ${fmtNum(w)} 0 0 ${fmtNum(h)} 0 0 cm /Im Do Q`, {}, res) }));
  return addAnnotation(doc, p, d);
}

export function addLink(doc: PdfDocument, p: PageInfo, rect: Rect, target: { url?: string; page?: number; y?: number }, o: { border?: boolean } = {}): Ref {
  const r = norm(rect);
  const d = new Dict({ Type: Name.get('Annot'), Subtype: Name.get('Link'), Rect: r, Border: o.border ? [0, 0, 1] : [0, 0, 0], F: 4 });
  if (target.url) d.set('A', new Dict({ S: Name.get('URI'), URI: PdfString.fromText(target.url) }));
  else if (target.page != null) { const tp = doc.pages[target.page]; if (tp?.ref) d.set('Dest', [tp.ref, Name.get('XYZ'), null, target.y ?? tp.cropBox[3], null]); }
  return addAnnotation(doc, p, d);
}

export function addFileAttachmentAnnot(doc: PdfDocument, p: PageInfo, x: number, y: number, name: string, data: Uint8Array, o: AnnotBase & { mime?: string } = {}): Ref {
  const stream = flateStream(data, { Type: Name.get('EmbeddedFile'), Subtype: Name.get(o.mime || 'application/octet-stream'), Params: new Dict({ Size: data.length, ModDate: pdfDate() }) });
  const sref = doc.register(stream);
  const fs = new Dict({ Type: Name.get('Filespec'), F: PdfString.fromText(name), UF: PdfString.fromText(name, true), EF: new Dict({ F: sref, UF: sref }) });
  const d = baseDict('FileAttachment', [x, y - 20, x + 16, y], { ...o, color: o.color || [0.3, 0.5, 0.9], contents: o.contents || name });
  d.set('FS', doc.register(fs));
  d.set('Name', Name.get('Paperclip'));
  const ops = `${rg(o.color || [0.3, 0.5, 0.9])} 0.2 0.2 0.2 RG 1 w 2 2 12 16 re B 5 6 m 5 15 l 9 15 l 9 6 l S`;
  d.set('AP', new Dict({ N: appearance(doc, [0, 0, 16, 20], ops) }));
  return addAnnotation(doc, p, d);
}

export function addRedactMark(doc: PdfDocument, p: PageInfo, rects: Rect[], o: AnnotBase & { overlayText?: string } = {}): Ref {
  const all = rects.map(norm);
  const bbox: Rect = [Math.min(...all.map((r) => r[0])), Math.min(...all.map((r) => r[1])), Math.max(...all.map((r) => r[2])), Math.max(...all.map((r) => r[3]))];
  const d = baseDict('Redact', bbox, { ...o, color: o.color || [1, 0, 0] });
  d.set('QuadPoints', quadsFromRects(all));
  d.set('IC', [0, 0, 0]);
  if (o.overlayText) d.set('OverlayText', PdfString.fromText(o.overlayText));
  let ops = '1 0 0 RG 1 w ';
  for (const r of all) ops += `${fmtNum(r[0] - bbox[0] + 0.5)} ${fmtNum(r[1] - bbox[1] + 0.5)} ${fmtNum(r[2] - r[0] - 1)} ${fmtNum(r[3] - r[1] - 1)} re S `;
  d.set('AP', new Dict({ N: appearance(doc, [0, 0, bbox[2] - bbox[0], bbox[3] - bbox[1]], ops) }));
  return addAnnotation(doc, p, d);
}

// ------------------------------------------------------------------------------------------
// Editing

export function setAnnotationProps(doc: PdfDocument, p: PageInfo, ref: Ref, props: { contents?: string; author?: string; color?: RGB; opacity?: number; rect?: Rect; hidden?: boolean; subject?: string }): void {
  const d = doc.resolve<Dict>(ref);
  if (!(d instanceof Dict)) return;
  if (props.contents !== undefined) d.set('Contents', PdfString.fromText(props.contents));
  if (props.author !== undefined) d.set('T', PdfString.fromText(props.author));
  if (props.subject !== undefined) d.set('Subj', PdfString.fromText(props.subject));
  if (props.color) d.set('C', props.color);
  if (props.opacity != null) d.set('CA', props.opacity);
  if (props.rect) {
    const old = doc.rect(d.get('Rect'));
    d.set('Rect', norm(props.rect));
    // Keep the appearance: scale its matrix to the new rect.
    const ap = doc.getDict(d, 'AP'); const n = ap ? doc.get(ap, 'N') : null;
    if (old && n instanceof PdfStream) {
      const bb = doc.rect(n.dict.get('BBox'));
      if (bb) { const sx = (props.rect[2] - props.rect[0]) / (bb[2] - bb[0] || 1), sy = (props.rect[3] - props.rect[1]) / (bb[3] - bb[1] || 1); n.dict.set('Matrix', [sx, 0, 0, sy, -bb[0] * sx, -bb[1] * sy]); const nr = ap!.get('N'); if (nr instanceof Ref) doc.touch(nr); }
    }
  }
  if (props.hidden !== undefined) { const f = doc.getNum(d, 'F', 4); d.set('F', props.hidden ? f | 2 : f & ~2); }
  d.set('M', pdfDate());
  doc.update(ref, d);
  void p;
}

export function addReply(doc: PdfDocument, p: PageInfo, parent: Ref, text: string, author: string, state?: { model: 'Review' | 'Marked'; state: string }): Ref {
  const pd = doc.resolve<Dict>(parent);
  const rect = doc.rect(pd.get('Rect')) || [0, 0, 20, 20];
  const d = baseDict('Text', rect, { author, contents: text });
  d.set('IRT', parent);
  d.set('F', 28 + 2); // hidden; replies live in the popup
  if (state) { d.set('RT', Name.get('R')); d.set('StateModel', PdfString.fromText(state.model)); d.set('State', PdfString.fromText(state.state)); }
  return addAnnotation(doc, p, d);
}

export function deleteAnnotation(doc: PdfDocument, p: PageInfo, ref: Ref): void { removeAnnotation(doc, p, ref); }

/** Flattens annotations into page content (their normal appearance is drawn, then they are removed). */
export function flattenAnnotations(doc: PdfDocument, p: PageInfo, filter: (a: AnnotInfo) => boolean = () => true): number {
  const annots = pageAnnotations(doc, p);
  const ops: string[] = [];
  let n = 0;
  const res = doc.pageResources(p);
  let xo = doc.getDict(res, 'XObject');
  if (!xo) { xo = new Dict(); res.set('XObject', xo); } else if (!(res.get('XObject') instanceof Dict)) { xo = xo.clone(); res.set('XObject', xo); }
  for (const a of annots) {
    if (!filter(a) || a.hidden || a.subtype === 'Popup' || a.subtype === 'Link') continue;
    const ap = doc.getDict(a.dict, 'AP');
    let nap = ap ? doc.get(ap, 'N') : null;
    if (nap instanceof Dict) { const as = doc.getName(a.dict, 'AS'); nap = as ? doc.get(nap, as) : doc.get(nap, nap.keys()[0]); }
    if (!(nap instanceof PdfStream)) continue;
    const bbox = doc.rect(nap.dict.get('BBox')) || [0, 0, 1, 1];
    const mtx = (doc.getArray(nap, 'Matrix') || [1, 0, 0, 1, 0, 0]).map((v) => doc.resolve<number>(v));
    // Transform bbox by matrix; map to rect (§12.5.5).
    const corners = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]].map(([x, y]) => [mtx[0] * x + mtx[2] * y + mtx[4], mtx[1] * x + mtx[3] * y + mtx[5]]);
    const tx0 = Math.min(...corners.map((c) => c[0])), ty0 = Math.min(...corners.map((c) => c[1])), tx1 = Math.max(...corners.map((c) => c[0])), ty1 = Math.max(...corners.map((c) => c[1]));
    const r = a.rect;
    const sx = (r[2] - r[0]) / (tx1 - tx0 || 1), sy = (r[3] - r[1]) / (ty1 - ty0 || 1);
    const name = `QFA${++n}${a.ref?.num || ''}`;
    const form = ap!.get('N') instanceof Ref ? (nap instanceof PdfStream ? (doc.getDict(a.dict, 'AP')!.get('N') as Ref) : null) : null;
    const fref = form || doc.register(nap);
    xo.set(name, fref);
    ops.push(`q ${fmtNum(sx)} 0 0 ${fmtNum(sy)} ${fmtNum(r[0] - tx0 * sx)} ${fmtNum(r[1] - ty0 * sy)} cm /${name} Do Q`);
    if (a.ref) removeAnnotation(doc, p, a.ref);
  }
  if (ops.length) { const cur = doc.pageContent(p); doc.setPageContent(p, concat([bytesOf('q\n'), cur, bytesOf('\nQ\n'), bytesOf(ops.join('\n'))])); }
  if (p.ref) doc.touch(p.ref);
  return ops.length;
}

// ------------------------------------------------------------------------------------------
// Redaction

export interface RedactResult { textRemoved: number; imagesRemoved: number; areas: number }

/** Applies every Redact annotation on the pages (or given rects): removes overlapped text and images, draws black boxes, deletes annotations under the area. */
export function applyRedactions(doc: PdfDocument, indexes: number[], extra: Map<number, Rect[]> = new Map()): RedactResult {
  const result: RedactResult = { textRemoved: 0, imagesRemoved: 0, areas: 0 };
  for (const i of indexes) {
    const p = doc.pages[i];
    if (!p) continue;
    const rects: Rect[] = [...(extra.get(i) || [])];
    const marks = pageAnnotations(doc, p).filter((a) => a.subtype === 'Redact');
    for (const m of marks) {
      const q = doc.getArray(m.dict, 'QuadPoints');
      if (q && q.length >= 8) { for (let k = 0; k + 7 < q.length; k += 8) { const v = q.slice(k, k + 8).map((x) => doc.resolve<number>(x)); rects.push([Math.min(v[0], v[2], v[4], v[6]), Math.min(v[1], v[3], v[5], v[7]), Math.max(v[0], v[2], v[4], v[6]), Math.max(v[1], v[3], v[5], v[7])]); } }
      else rects.push(m.rect);
    }
    if (!rects.length) continue;
    result.areas += rects.length;
    const ops = parseContent(doc.pageContent(p));
    const info = analyzeContent(doc, ops, p.resources);
    const drop = new Set<number>();
    const advance = new Map<number, number>();
    for (const run of info.runs) if (rects.some((r) => rectsOverlap(r, run.box))) { drop.add(run.opIndex); advance.set(run.opIndex, run.advance); result.textRemoved++; }
    for (const im of info.images) if (rects.some((r) => rectsOverlap(r, im.box))) { drop.add(im.opIndex); result.imagesRemoved++; }
    // A removed text operator is replaced by one that moves the text position by the same amount
    // without drawing, so the text after it on the line stays where it was (and does not slide under
    // or out of the box); ' and " keep their move to the next line.
    const kept: Op[] = ops.flatMap((o, k): Op[] => {
      if (!drop.has(k)) return [o];
      if (o.op === 'Do' || o.op === 'INLINE_IMAGE') return [{ op: 'n', args: [] }];
      const move: Op = advance.has(k) ? { op: 'TJ', args: [[advance.get(k) || 0]] } : { op: 'Tj', args: [new PdfString(new Uint8Array(0))] };
      if (o.op === "'") return [{ op: 'T*', args: [] }, move];
      if (o.op === '"') return [{ op: 'Tw', args: [o.args[0] ?? 0] }, { op: 'Tc', args: [o.args[1] ?? 0] }, { op: 'T*', args: [] }, move];
      return [move];
    });
    // Black boxes on top, in default page space: the original content is wrapped in q…Q so a transform
    // or clip it leaves in effect at its end cannot move or hide the boxes.
    kept.unshift({ op: 'q', args: [] });
    kept.push({ op: 'Q', args: [] }, { op: 'q', args: [] });
    for (const r of rects) { kept.push({ op: 'rg', args: [0, 0, 0] }, { op: 're', args: [r[0], r[1], r[2] - r[0], r[3] - r[1]] }, { op: 'f', args: [] }); }
    kept.push({ op: 'Q', args: [] });
    doc.setPageContent(p, serializeContent(kept));
    // Annotations within the areas (and the marks themselves) go.
    for (const a of pageAnnotations(doc, p)) if (a.ref && (a.subtype === 'Redact' || rects.some((r) => rectsOverlap(r, a.rect)))) removeAnnotation(doc, p, a.ref);
    // Images fully covered: blank the XObject's pixels is not possible without decoding; a removed Do suffices because the operator is gone.
  }
  // The removed content must not survive in the original part of the file.
  if (result.areas) doc.mustRewrite = true;
  return result;
}

// ------------------------------------------------------------------------------------------
// XFDF

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const hexColor = (c: RGB | null) => (c ? '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('') : undefined);

export function exportXfdf(doc: PdfDocument, fileName = ''): string {
  const items: string[] = [];
  for (const a of doc.pages.flatMap((p) => pageAnnotations(doc, p))) {
    if (a.subtype === 'Popup' || a.subtype === 'Widget' || a.subtype === 'Link') continue;
    const tag = a.subtype.toLowerCase();
    const attrs: string[] = [`page="${a.page}"`, `rect="${a.rect.map(fmtNum).join(',')}"`];
    if (a.author) attrs.push(`title="${esc(a.author)}"`);
    if (a.name) attrs.push(`name="${esc(a.name)}"`);
    if (a.color) attrs.push(`color="${hexColor(a.color)}"`);
    if (a.date) attrs.push(`date="${esc(pdfDate(a.date).toText())}"`);
    if (a.opacity < 1) attrs.push(`opacity="${fmtNum(a.opacity)}"`);
    if (a.irt) { const parent = doc.resolve<Dict>(a.irt); attrs.push(`inreplyto="${esc(doc.getText(parent, 'NM'))}"`); }
    if (a.subtype === 'Text') attrs.push(`icon="${esc(doc.getName(a.dict, 'Name') || 'Comment')}"`);
    const q = doc.getArray(a.dict, 'QuadPoints'); if (q) attrs.push(`coords="${q.map((x) => fmtNum(doc.resolve<number>(x))).join(',')}"`);
    const bs = doc.getDict(a.dict, 'BS'); if (bs) attrs.push(`width="${fmtNum(doc.getNum(bs, 'W', 1))}"`);
    const ic = doc.getArray(a.dict, 'IC'); if (ic && ic.length === 3) attrs.push(`interior-color="${hexColor(ic.map((x) => doc.resolve<number>(x)) as RGB)}"`);
    const st = doc.getText(a.dict, 'State'); if (st) attrs.push(`state="${esc(st)}" statemodel="${esc(doc.getText(a.dict, 'StateModel'))}"`);
    let inner = a.contents ? `<contents>${esc(a.contents)}</contents>` : '';
    const ink = doc.getArray(a.dict, 'InkList'); if (ink) inner += `<inklist>${ink.map((g) => { const arr = doc.resolve<PdfObj[]>(g); return `<gesture>${Array.isArray(arr) ? arr.map((x) => fmtNum(doc.resolve<number>(x))).join(',') : ''}</gesture>`; }).join('')}</inklist>`;
    const v = doc.getArray(a.dict, 'Vertices'); if (v) inner += `<vertices>${v.map((x) => fmtNum(doc.resolve<number>(x))).join(',')}</vertices>`;
    const l = doc.getArray(a.dict, 'L'); if (l) attrs.push(`start="${fmtNum(doc.resolve<number>(l[0]))},${fmtNum(doc.resolve<number>(l[1]))}" end="${fmtNum(doc.resolve<number>(l[2]))},${fmtNum(doc.resolve<number>(l[3]))}"`);
    items.push(`<${tag} ${attrs.join(' ')}>${inner}</${tag}>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">${fileName ? `<f href="${esc(fileName)}"/>` : ''}<annots>${items.join('')}</annots></xfdf>`;
}

const parseColor = (s: string | null): RGB | undefined => { const m = s && /^#?([0-9a-f]{6})$/i.exec(s.trim()); return m ? [parseInt(m[1].slice(0, 2), 16) / 255, parseInt(m[1].slice(2, 4), 16) / 255, parseInt(m[1].slice(4, 6), 16) / 255] : undefined; };
const nums = (s: string | null): number[] => (s ? s.split(/[\s,]+/).map(Number).filter((x) => isFinite(x)) : []);

/** Imports annotations from XFDF (comments from another reader). Returns how many were added. */
export function importXfdf(doc: PdfDocument, xml: string): number {
  const dom = new DOMParser().parseFromString(xml, 'application/xml');
  const annots = dom.getElementsByTagNameNS('*', 'annots')[0];
  if (!annots) return 0;
  let count = 0;
  const byName = new Map<string, Ref>();
  for (const el of [...annots.children]) {
    const page = +(el.getAttribute('page') || 0);
    const p = doc.pages[page];
    if (!p) continue;
    const rect = nums(el.getAttribute('rect'));
    if (rect.length < 4) continue;
    const base: AnnotBase = { author: el.getAttribute('title') || undefined, contents: el.getElementsByTagNameNS('*', 'contents')[0]?.textContent || el.getElementsByTagNameNS('*', 'contents-richtext')[0]?.textContent || undefined, color: parseColor(el.getAttribute('color')), opacity: el.getAttribute('opacity') ? +el.getAttribute('opacity')! : undefined };
    const tag = el.localName.toLowerCase();
    const r: Rect = [rect[0], rect[1], rect[2], rect[3]];
    const coords = nums(el.getAttribute('coords'));
    const quadRects: Rect[] = [];
    for (let k = 0; k + 7 < coords.length; k += 8) quadRects.push([Math.min(coords[k], coords[k + 4]), Math.min(coords[k + 5], coords[k + 1]), Math.max(coords[k + 2], coords[k + 6]), Math.max(coords[k + 1], coords[k + 3])]);
    let ref: Ref | null = null;
    try {
      switch (tag) {
        case 'highlight': case 'underline': case 'strikeout': case 'squiggly': ref = addTextMarkup(doc, p, (tag[0].toUpperCase() + tag.slice(1)).replace('Strikeout', 'StrikeOut') as MarkupKind, quadRects.length ? quadRects : [r], base); break;
        case 'text': ref = addNote(doc, p, r[0], r[3], { ...base, icon: el.getAttribute('icon') || undefined }); break;
        case 'freetext': ref = addFreeText(doc, p, r, { ...base, text: base.contents || '' }); break;
        case 'square': case 'circle': ref = addShape(doc, p, tag === 'square' ? 'Square' : 'Circle', r, { ...base, fill: parseColor(el.getAttribute('interior-color')) || null, width: +(el.getAttribute('width') || 1) }); break;
        case 'line': { const s = nums(el.getAttribute('start')), e = nums(el.getAttribute('end')); ref = addShape(doc, p, 'Line', r, { ...base, points: [[s[0], s[1]], [e[0], e[1]]], width: +(el.getAttribute('width') || 1) }); break; }
        case 'polygon': case 'polyline': { const v = nums(el.getElementsByTagNameNS('*', 'vertices')[0]?.textContent || null); const pts: [number, number][] = []; for (let k = 0; k + 1 < v.length; k += 2) pts.push([v[k], v[k + 1]]); ref = addShape(doc, p, tag === 'polygon' ? 'Polygon' : 'PolyLine', r, { ...base, points: pts, width: +(el.getAttribute('width') || 1) }); break; }
        case 'ink': { const strokes: [number, number][][] = [...el.getElementsByTagNameNS('*', 'gesture')].map((g) => { const v = nums(g.textContent); const pts: [number, number][] = []; for (let k = 0; k + 1 < v.length; k += 2) pts.push([v[k], v[k + 1]]); return pts; }); ref = addInk(doc, p, strokes, { ...base, width: +(el.getAttribute('width') || 2) }); break; }
        case 'stamp': ref = addTextStamp(doc, p, r, (el.getAttribute('icon') || base.contents || 'Stamp').replace(/^#/, ''), base); break;
        case 'redact': ref = addRedactMark(doc, p, quadRects.length ? quadRects : [r], base); break;
        default: continue;
      }
    } catch { continue; }
    if (ref) {
      count++;
      const nm = el.getAttribute('name'); if (nm) { byName.set(nm, ref); doc.resolve<Dict>(ref).set('NM', PdfString.fromText(nm)); }
      const irt = el.getAttribute('inreplyto'); if (irt && byName.has(irt)) { const d = doc.resolve<Dict>(ref); d.set('IRT', byName.get(irt)!); d.set('F', 30); }
      const st = el.getAttribute('state'); if (st) { const d = doc.resolve<Dict>(ref); d.set('State', PdfString.fromText(st)); d.set('StateModel', PdfString.fromText(el.getAttribute('statemodel') || 'Review')); }
    }
  }
  return count;
}

export { pageAnnotations, removeAnnotation };
