/**
 * Editing existing page text: replacing the text of one run when its font can be re-encoded
 * (simple Latin fonts), otherwise covering the run with a white box and drawing new text in a
 * standard font. Also inserting new text, images and deleting content by area.
 */
import { Dict, Name, PdfString } from '../objects';
import { PdfDocument, PageInfo } from '../document';
import { parseContent, serializeContent, analyzeContent, encodeString, fontInfo, TextRun, rectOps, Op } from '../content';
import { ensureFont, ensureXObject, litText } from '../build';
import { fmtNum } from '../writer';
import { bytesOf, concat } from '../objects';
import type { Ref } from '../objects';

export interface EditableRun extends TextRun { page: number; editable: boolean }

export function pageRuns(doc: PdfDocument, p: PageInfo): EditableRun[] {
  const info = analyzeContent(doc, parseContent(doc.pageContent(p)), p.resources);
  const fonts = p.resources ? doc.getDict(p.resources, 'Font') : null;
  const cache = new Map<string, boolean>();
  return info.runs.map((r) => {
    let ed = cache.get(r.font);
    if (ed === undefined) { ed = fontInfo(doc, r.font, fonts ? doc.getDict(fonts, r.font) : null).editable; cache.set(r.font, ed); }
    return { ...r, page: p.index, editable: ed };
  });
}

export interface ReplaceResult { mode: 'reencoded' | 'overlaid' }

/** Replaces the text of a run. */
export function replaceRunText(doc: PdfDocument, p: PageInfo, run: EditableRun, newText: string): ReplaceResult {
  const ops = parseContent(doc.pageContent(p));
  const op = ops[run.opIndex];
  const fonts = p.resources ? doc.getDict(p.resources, 'Font') : null;
  const fi = fontInfo(doc, run.font, fonts ? doc.getDict(fonts, run.font) : null);
  if (op && fi.editable && (op.op === 'Tj' || op.op === "'" || op.op === '"' || op.op === 'TJ')) {
    const encoded = encodeString(fi, newText);
    if (encoded) {
      if (op.op === 'TJ') op.args[0] = [encoded];
      else if (op.op === '"') op.args[2] = encoded;
      else op.args[0] = encoded;
      doc.setPageContent(p, serializeContent(ops));
      return { mode: 'reencoded' };
    }
  }
  // Overlay: white box over the old run, new text in Helvetica at the same size.
  const [x0, y0, x1, y1] = run.box;
  const white = rectOps(x0 - 1, y0 - 1, x1 - x0 + 2, y1 - y0 + 2, [1, 1, 1]);
  if (op && (op.op === 'Tj' || op.op === 'TJ' || op.op === "'" || op.op === '"')) {
    // Remove the old string so copy/search no longer finds it.
    if (op.op === 'TJ') op.args[0] = []; else if (op.op === '"') op.args[2] = new PdfString(new Uint8Array(0)); else op.args[0] = new PdfString(new Uint8Array(0));
  }
  const font = ensureFont(doc, p, /Times|Serif|Roman|Georgia/i.test(fi.name) ? 'Times-Roman' : /Cour|Mono/i.test(fi.name) ? 'Courier' : 'Helvetica');
  const size = run.size || y1 - y0;
  const text: Op[] = [{ op: 'BT', args: [] }, { op: 'Tf', args: [Name.get(font), size] }, { op: 'rg', args: [0, 0, 0] }, { op: 'Td', args: [x0, y0 + (y1 - y0) * 0.22] }, { op: 'Tj', args: [new PdfString(bytesOf(newText))] }, { op: 'ET', args: [] }];
  // The original content is wrapped in q…Q so its final transform, clip or text state (an invisible
  // render mode, say) cannot affect the overlay.
  const all = [{ op: 'q', args: [] }, ...ops, { op: 'Q', args: [] }, { op: 'q', args: [] }, ...white, ...text, { op: 'Q', args: [] }];
  doc.setPageContent(p, serializeContent(all));
  return { mode: 'overlaid' };
}

/** Removes every run and image whose box lies inside the area (white-out editing). */
export function eraseArea(doc: PdfDocument, p: PageInfo, area: [number, number, number, number], white = true): number {
  const ops = parseContent(doc.pageContent(p));
  const info = analyzeContent(doc, ops, p.resources);
  const inside = (b: [number, number, number, number]) => b[0] >= area[0] - 1 && b[2] <= area[2] + 1 && b[1] >= area[1] - 1 && b[3] <= area[3] + 1;
  let n = 0;
  for (const r of info.runs) if (inside(r.box)) { const op = ops[r.opIndex]; if (op.op === 'TJ') op.args[0] = []; else if (op.op === '"') op.args[2] = new PdfString(new Uint8Array(0)); else op.args[0] = new PdfString(new Uint8Array(0)); n++; }
  for (const im of info.images) if (inside(im.box)) { ops[im.opIndex] = { op: 'n', args: [] }; n++; }
  const out = white ? [{ op: 'q', args: [] }, ...ops, { op: 'Q', args: [] }, { op: 'q', args: [] }, ...rectOps(area[0], area[1], area[2] - area[0], area[3] - area[1], [1, 1, 1]), { op: 'Q', args: [] }] : ops;
  doc.setPageContent(p, serializeContent(out));
  return n;
}

export function insertText(doc: PdfDocument, p: PageInfo, x: number, y: number, text: string, o: { font?: 'Helvetica' | 'Helvetica-Bold' | 'Times-Roman' | 'Times-Bold' | 'Courier'; size?: number; color?: [number, number, number]; maxWidth?: number } = {}): void {
  const font = ensureFont(doc, p, o.font || 'Helvetica');
  const size = o.size || 12;
  const c = o.color || [0, 0, 0];
  const lines = text.split(/\r?\n/);
  const ops = lines.map((l, i) => `BT /${font} ${fmtNum(size)} Tf ${fmtNum(c[0])} ${fmtNum(c[1])} ${fmtNum(c[2])} rg ${fmtNum(x)} ${fmtNum(y - i * size * 1.2)} Td ${litText(l)} Tj ET`).join('\n');
  const cur = doc.pageContent(p);
  doc.setPageContent(p, concat([bytesOf('q\n'), cur, bytesOf('\nQ\n'), bytesOf(ops), bytesOf('\n')]));
}

export function insertImage(doc: PdfDocument, p: PageInfo, image: Ref, box: { x: number; y: number; w: number; h: number }): void {
  const name = ensureXObject(doc, p, 'QFIm', image);
  const cur = doc.pageContent(p);
  doc.setPageContent(p, concat([bytesOf('q\n'), cur, bytesOf('\nQ\n'), bytesOf(`q ${fmtNum(box.w)} 0 0 ${fmtNum(box.h)} ${fmtNum(box.x)} ${fmtNum(box.y)} cm /${name} Do Q\n`)]));
}

/** Moves or resizes the image drawn by a Do operator at `opIndex` (from analyzeContent). */
export function moveImage(doc: PdfDocument, p: PageInfo, opIndex: number, box: { x: number; y: number; w: number; h: number }): boolean {
  const ops = parseContent(doc.pageContent(p));
  const op = ops[opIndex];
  if (!op || op.op !== 'Do') return false;
  // Find the nearest preceding cm inside the same q…Q level and replace it.
  let depth = 0;
  for (let i = opIndex - 1; i >= 0; i--) {
    const o = ops[i];
    if (o.op === 'Q') depth++;
    else if (o.op === 'q') { if (depth === 0) break; depth--; }
    else if (o.op === 'cm' && depth === 0) { o.args = [box.w, 0, 0, box.h, box.x, box.y]; doc.setPageContent(p, serializeContent(ops)); return true; }
  }
  // No cm: wrap the Do in its own transform.
  ops.splice(opIndex, 1, { op: 'q', args: [] }, { op: 'cm', args: [box.w, 0, 0, box.h, box.x, box.y] }, op, { op: 'Q', args: [] });
  doc.setPageContent(p, serializeContent(ops));
  return true;
}

export function deleteImage(doc: PdfDocument, p: PageInfo, opIndex: number): boolean {
  const ops = parseContent(doc.pageContent(p));
  const op = ops[opIndex];
  if (!op || (op.op !== 'Do' && op.op !== 'INLINE_IMAGE')) return false;
  ops[opIndex] = { op: 'n', args: [] };
  doc.setPageContent(p, serializeContent(ops));
  return true;
}

export const asDict = (o: unknown): Dict | null => (o instanceof Dict ? o : null);
