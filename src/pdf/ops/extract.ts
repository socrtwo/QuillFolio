/**
 * Extraction from the object graph: page text (the engine's own decoder, for environments without
 * the renderer), images (JPEG as is, Flate raster as RGB/gray samples), attachments, and tables from
 * positioned text (column clustering).
 */
import { PdfStream, isName, Name } from '../objects';
import { PdfDocument } from '../document';
import { parseContent, analyzeContent, TextRun } from '../content';
import { listImages, ImageInfo } from './optimize';

export interface PositionedText { text: string; x: number; y: number; w: number; h: number; size: number }

/** Positioned text runs of a page from the engine (top-left origin, points). */
export function pageTextRuns(doc: PdfDocument, index: number): PositionedText[] {
  const p = doc.pages[index];
  if (!p) return [];
  const info = analyzeContent(doc, parseContent(doc.pageContent(p)), p.resources);
  const top = p.cropBox[3];
  return info.runs.filter((r) => r.text.trim()).map((r: TextRun) => ({ text: r.text, x: r.box[0] - p.cropBox[0], y: top - r.box[3], w: r.box[2] - r.box[0], h: r.box[3] - r.box[1], size: r.size }));
}

/** Lines of text, in reading order, from positioned runs (works for the engine's and the renderer's runs). */
export function linesFromRuns(runs: PositionedText[]): string[] {
  const sorted = [...runs].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: PositionedText[][] = [];
  for (const r of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last[0].y - r.y) < Math.max(2, Math.min(last[0].h, r.h) * 0.5)) last.push(r); else lines.push([r]);
  }
  return lines.map((l) => { l.sort((a, b) => a.x - b.x); let s = ''; let endX = -Infinity; for (const r of l) { if (s && r.x - endX > r.h * 0.2) s += ' '; s += r.text; endX = r.x + r.w; } return s.replace(/\s+/g, ' ').trim(); }).filter(Boolean);
}

export function pageText(doc: PdfDocument, index: number): string { return linesFromRuns(pageTextRuns(doc, index)).join('\n'); }

/** Markdown-ish text: lines in a larger-than-median font become headings. */
export function textToMarkdown(pages: PositionedText[][]): string {
  const out: string[] = [];
  const sizes = pages.flat().map((r) => r.size).filter((s) => s > 0).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)] || 10;
  pages.forEach((runs, i) => {
    const sorted = [...runs].sort((a, b) => a.y - b.y || a.x - b.x);
    const lines: PositionedText[][] = [];
    for (const r of sorted) { const last = lines[lines.length - 1]; if (last && Math.abs(last[0].y - r.y) < Math.max(2, r.h * 0.5)) last.push(r); else lines.push([r]); }
    let para = '';
    for (const l of lines) {
      l.sort((a, b) => a.x - b.x);
      const text = l.map((r) => r.text).join(' ').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const size = Math.max(...l.map((r) => r.size));
      if (size >= median * 1.6) { if (para) out.push(para, ''); para = ''; out.push(`# ${text}`, ''); }
      else if (size >= median * 1.25) { if (para) out.push(para, ''); para = ''; out.push(`## ${text}`, ''); }
      else para = para ? `${para} ${text}` : text;
      if (/[.!?:]$/.test(text) && para === text) { /* keep accumulating */ }
    }
    if (para) out.push(para, '');
    if (i < pages.length - 1) out.push('---', '');
  });
  return out.join('\n');
}

/** Detects tables on a page: rows of runs sharing y, columns from x-clusters of their starts. */
export function tablesFromRuns(runs: PositionedText[]): string[][][] {
  const sorted = [...runs].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: PositionedText[][] = [];
  for (const r of sorted) { const last = rows[rows.length - 1]; if (last && Math.abs(last[0].y - r.y) < Math.max(2, r.h * 0.5)) last.push(r); else rows.push([r]); }
  // Group consecutive rows with 2+ cells into tables.
  const tables: string[][][] = [];
  let cur: PositionedText[][] = [];
  const flush = () => {
    if (cur.length >= 2) {
      // Column boundaries: cluster x starts.
      const xs = cur.flat().map((r) => r.x).sort((a, b) => a - b);
      const cols: number[] = [];
      for (const x of xs) if (!cols.length || x - cols[cols.length - 1] > 12) cols.push(x);
      const grid = cur.map((row) => { const cells = new Array(cols.length).fill(''); for (const r of row) { let c = 0; for (let i = 0; i < cols.length; i++) if (r.x + 6 >= cols[i]) c = i; cells[c] = (cells[c] ? cells[c] + ' ' : '') + r.text; } return cells; });
      if (cols.length >= 2) tables.push(grid);
    }
    cur = [];
  };
  for (const row of rows) { if (row.length >= 2) cur.push(row); else flush(); }
  flush();
  return tables;
}

export function toCsv(table: string[][]): string { return table.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n') + '\n'; }

export interface ExtractedImage { info: ImageInfo; kind: 'jpeg' | 'jp2' | 'raw' | 'unsupported'; data: Uint8Array; components: number; width: number; height: number; bpc: number }

/** Raw bytes of an image: JPEG/JPX files directly; Flate/uncompressed samples as 'raw'. */
export function extractImage(doc: PdfDocument, info: ImageInfo): ExtractedImage {
  const r = doc.decode(info.stream);
  const cs = doc.get(info.stream, 'ColorSpace');
  const csName = isName(cs) ? cs.name : Array.isArray(cs) && isName(cs[0]) ? cs[0].name : '';
  const components = csName === 'DeviceCMYK' ? 4 : csName === 'DeviceRGB' || csName === 'CalRGB' || csName === 'Lab' ? 3 : csName === 'ICCBased' ? (() => { const n = Array.isArray(cs) ? doc.resolve<PdfStream | null>(cs[1]) : null; return n instanceof PdfStream ? doc.getNum(n, 'N', 3) : 3; })() : csName === 'Indexed' ? 1 : 1;
  if (r.imageFilter === 'DCTDecode') return { info, kind: 'jpeg', data: r.data, components, width: info.width, height: info.height, bpc: 8 };
  if (r.imageFilter === 'JPXDecode') return { info, kind: 'jp2', data: r.data, components, width: info.width, height: info.height, bpc: 8 };
  if (r.imageFilter) return { info, kind: 'unsupported', data: r.data, components, width: info.width, height: info.height, bpc: info.bpc };
  return { info, kind: 'raw', data: r.data, components, width: info.width, height: info.height, bpc: info.bpc };
}

/** Expands raw samples (gray/RGB/CMYK/indexed, 1–16 bpc) to RGBA bytes for a canvas. */
export function rawToRgba(doc: PdfDocument, ex: ExtractedImage): Uint8ClampedArray | null {
  const { width: w, height: h, bpc, data } = ex;
  if (ex.kind !== 'raw') return null;
  const out = new Uint8ClampedArray(w * h * 4);
  const cs = doc.get(ex.info.stream, 'ColorSpace');
  const csName = isName(cs) ? cs.name : Array.isArray(cs) && isName(cs[0]) ? cs[0].name : '';
  let palette: Uint8Array | null = null, palComps = 3;
  if (csName === 'Indexed' && Array.isArray(cs)) {
    const base = doc.resolve(cs[1]);
    const baseName = isName(base) ? base.name : Array.isArray(base) && isName(base[0]) ? base[0].name : 'DeviceRGB';
    palComps = baseName === 'DeviceCMYK' ? 4 : baseName === 'DeviceGray' ? 1 : 3;
    const lookup = doc.resolve(cs[3]);
    palette = lookup instanceof PdfStream ? doc.decoded(lookup) : lookup && typeof (lookup as any).bytes !== 'undefined' ? (lookup as any).bytes : null;
  }
  const decode = doc.getArray(ex.info.stream, 'Decode');
  const inverted = !!decode && doc.resolve<number>(decode[0]) === 1;
  const comps = palette ? 1 : ex.components;
  const rowBytes = Math.ceil((w * comps * bpc) / 8);
  const max = (1 << bpc) - 1;
  const sample = (row: number, i: number): number => {
    if (bpc === 8) return data[row * rowBytes + i] ?? 0;
    if (bpc === 16) return (data[row * rowBytes + i * 2] ?? 0);
    const bit = i * bpc; const byte = data[row * rowBytes + (bit >> 3)] ?? 0;
    return (byte >> (8 - bpc - (bit & 7))) & max;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    if (palette) {
      const idx = sample(y, x);
      const pi = idx * palComps;
      if (palComps === 1) { out[o] = out[o + 1] = out[o + 2] = palette[pi] ?? 0; }
      else if (palComps === 4) { const c = palette[pi] / 255, m = palette[pi + 1] / 255, yy = palette[pi + 2] / 255, k = palette[pi + 3] / 255; out[o] = 255 * (1 - c) * (1 - k); out[o + 1] = 255 * (1 - m) * (1 - k); out[o + 2] = 255 * (1 - yy) * (1 - k); }
      else { out[o] = palette[pi] ?? 0; out[o + 1] = palette[pi + 1] ?? 0; out[o + 2] = palette[pi + 2] ?? 0; }
    } else if (comps === 1) { let v = (sample(y, x) / (bpc === 16 ? 255 : max)) * 255; if (inverted) v = 255 - v; out[o] = out[o + 1] = out[o + 2] = v; }
    else if (comps === 3) { for (let k = 0; k < 3; k++) out[o + k] = (sample(y, x * 3 + k) / (bpc === 16 ? 255 : max)) * 255; }
    else if (comps === 4) { const c = sample(y, x * 4) / max, m = sample(y, x * 4 + 1) / max, yy = sample(y, x * 4 + 2) / max, k = sample(y, x * 4 + 3) / max; const inv = inverted ? -1 : 1; const cc = inverted ? 1 - c : c, mm = inverted ? 1 - m : m, yy2 = inverted ? 1 - yy : yy, kk = inverted ? 1 - k : k; void inv; out[o] = 255 * (1 - cc) * (1 - kk); out[o + 1] = 255 * (1 - mm) * (1 - kk); out[o + 2] = 255 * (1 - yy2) * (1 - kk); }
    out[o + 3] = 255;
  }
  // Soft mask → alpha
  const sm = doc.get(ex.info.stream, 'SMask');
  if (sm instanceof PdfStream) {
    try {
      const smd = doc.decode(sm);
      const sw = doc.getNum(sm, 'Width'), sh = doc.getNum(sm, 'Height'), sb = doc.getNum(sm, 'BitsPerComponent', 8);
      if (!smd.imageFilter && sw === w && sh === h && sb === 8) for (let i = 0; i < w * h; i++) out[i * 4 + 3] = smd.data[i] ?? 255;
    } catch { /* keep opaque */ }
  }
  return out;
}

export { listImages };
export const imageName = (im: ImageInfo, i: number): string => `image-${i + 1}-page-${im.page + 1}${im.filter.includes('DCT') ? '.jpg' : im.filter.includes('JPX') ? '.jp2' : '.png'}`;
export const N = Name.get;
