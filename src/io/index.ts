/**
 * File format registry: detection by content, opening (with automatic repair of damaged PDFs) and
 * the conversions that make a PDF out of images and text. Heavy work loads on demand.
 */
import { PdfDocument, PasswordNeeded } from '../pdf/document';
import type { RepairReport } from '../pdf/repair';
import { Lexer } from '../pdf/lexer';
import { addImagePage, addTextPages, jpegInfo, PAPER, type ImageSpec } from '../pdf/build';
import { decodeXml } from './xml';

export interface FormatDef { id: string; label: string; ext: string[]; mime: string; canImport: boolean; canExport: boolean; kind: 'pdf' | 'form-data' | 'comments' | 'image' | 'text' | 'package' }

export const FORMATS: FormatDef[] = [
  { id: 'pdf', label: 'PDF Document', ext: ['pdf'], mime: 'application/pdf', canImport: true, canExport: true, kind: 'pdf' },
  { id: 'xfdf', label: 'XFDF Form and Comment Data', ext: ['xfdf'], mime: 'application/vnd.adobe.xfdf', canImport: true, canExport: true, kind: 'form-data' },
  { id: 'fdf', label: 'FDF Form Data', ext: ['fdf'], mime: 'application/vnd.fdf', canImport: true, canExport: true, kind: 'form-data' },
  { id: 'qfr', label: 'QuillFolio Review Package', ext: ['qfr'], mime: 'application/x-quillfolio-review', canImport: true, canExport: true, kind: 'package' },
  { id: 'png', label: 'PNG Image', ext: ['png'], mime: 'image/png', canImport: true, canExport: true, kind: 'image' },
  { id: 'jpeg', label: 'JPEG Image', ext: ['jpg', 'jpeg'], mime: 'image/jpeg', canImport: true, canExport: true, kind: 'image' },
  { id: 'gif', label: 'GIF Image', ext: ['gif'], mime: 'image/gif', canImport: true, canExport: false, kind: 'image' },
  { id: 'webp', label: 'WebP Image', ext: ['webp'], mime: 'image/webp', canImport: true, canExport: false, kind: 'image' },
  { id: 'bmp', label: 'BMP Image', ext: ['bmp'], mime: 'image/bmp', canImport: true, canExport: false, kind: 'image' },
  { id: 'tiff', label: 'TIFF Image', ext: ['tif', 'tiff'], mime: 'image/tiff', canImport: true, canExport: false, kind: 'image' },
  { id: 'svg', label: 'SVG Image', ext: ['svg'], mime: 'image/svg+xml', canImport: true, canExport: false, kind: 'image' },
  { id: 'txt', label: 'Plain Text', ext: ['txt'], mime: 'text/plain', canImport: true, canExport: true, kind: 'text' },
  { id: 'md', label: 'Markdown', ext: ['md', 'markdown'], mime: 'text/markdown', canImport: true, canExport: true, kind: 'text' },
  { id: 'html', label: 'HTML', ext: ['html', 'htm'], mime: 'text/html', canImport: true, canExport: true, kind: 'text' },
  { id: 'csv', label: 'CSV Table', ext: ['csv'], mime: 'text/csv', canImport: false, canExport: true, kind: 'text' },
  { id: 'json', label: 'JSON Form Data', ext: ['json'], mime: 'application/json', canImport: true, canExport: true, kind: 'form-data' },
  { id: 'zip', label: 'ZIP of PDFs', ext: ['zip'], mime: 'application/zip', canImport: true, canExport: true, kind: 'package' },
];

export function formatById(id: string): FormatDef | undefined { return FORMATS.find((f) => f.id === id); }
export function formatFromName(name: string): FormatDef | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(name || '')?.[1]?.toLowerCase();
  return ext ? FORMATS.find((f) => f.ext.includes(ext)) : undefined;
}

const ascii = (u8: Uint8Array, from: number, to: number) => { let s = ''; for (let i = from; i < Math.min(u8.length, to); i++) s += String.fromCharCode(u8[i]); return s; };

/** Detects the format by content, falling back to the extension. */
export function sniffFormat(data: Uint8Array, name: string): string | null {
  const byName = formatFromName(name)?.id || null;
  if (!data.length) return byName;
  const head = ascii(data, 0, 16);
  if (Lexer.find(data, '%PDF-', 0, Math.min(data.length, 65536)) >= 0) return 'pdf';
  if (head.startsWith('%FDF-')) return 'fdf';
  if (data[0] === 0x89 && head.slice(1, 4) === 'PNG') return 'png';
  if (data[0] === 0xff && data[1] === 0xd8) return 'jpeg';
  if (head.startsWith('GIF8')) return 'gif';
  if (head.startsWith('RIFF') && ascii(data, 8, 12) === 'WEBP') return 'webp';
  if (head.startsWith('BM')) return 'bmp';
  if (head.startsWith('II*\0') || head.startsWith('MM\0*')) return 'tiff';
  if (head.startsWith('PK\x03\x04') || head.startsWith('PK\x05\x06')) {
    if (Lexer.find(data, 'application/x-quillfolio-review', 0, 200) >= 0) return 'qfr';
    return byName === 'qfr' ? 'qfr' : 'zip';
  }
  const text = (() => { try { return decodeXml(data.subarray(0, 4096)); } catch { return ascii(data, 0, 4096); } })();
  if (/^\s*<\?xml[^>]*>\s*<xfdf/i.test(text) || /<xfdf\b/i.test(text)) return 'xfdf';
  if (/^\s*<svg\b/i.test(text) || (/^\s*<\?xml/.test(text) && /<svg\b/i.test(text))) return 'svg';
  if (/^\s*<(!doctype html|html|head|body)/i.test(text)) return 'html';
  if (/^\s*[{[]/.test(text)) { try { JSON.parse(ascii(data, 0, data.length)); return 'json'; } catch { /* */ } }
  if (byName) return byName;
  // Mostly printable → text; Markdown if it has headings.
  let printable = 0; const n = Math.min(data.length, 2048);
  for (let i = 0; i < n; i++) { const c = data[i]; if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 0x80) printable++; }
  if (printable / n > 0.95) return /^#{1,6}\s/m.test(text) ? 'md' : 'txt';
  // Bytes that mention PDF objects but no header: a damaged PDF.
  if (Lexer.find(data, ' obj', 0) >= 0 && Lexer.find(data, 'endobj', 0) >= 0) return 'pdf';
  return byName;
}

export interface OpenResult { doc: PdfDocument; format: string; warnings: string[]; repair?: RepairReport; bytes: Uint8Array }

export class PasswordNeededError extends PasswordNeeded {}

/** Opens any supported file as a PdfDocument: PDFs directly (repairing when needed), images and text by conversion. */
export async function openAsPdf(data: Uint8Array, name: string, opts: { password?: string; repair?: boolean } = {}): Promise<OpenResult> {
  const format = sniffFormat(data, name) || 'pdf';
  const warnings: string[] = [];
  if (format === 'pdf') {
    let loaded: PdfDocument | null = null;
    if (!opts.repair) {
      try {
        const doc = PdfDocument.load(data, { password: opts.password });
        warnings.push(...doc.report.warnings);
        if (!doc.report.reconstructed && doc.pageCount > 0) return { doc, format, warnings, bytes: data };
        // Damaged: run the full pipeline and keep whichever is better.
        if (doc.pageCount > 0) loaded = doc;
      } catch (e) {
        if (e instanceof PasswordNeeded) throw e;
        warnings.push(String((e as any)?.message || e));
      }
    }
    const { repairPdf } = await import('../pdf/repair');
    const report = repairPdf(data, name, { password: opts.password });
    // The repair pipeline salvages what it can, but the scan-based load may already have more pages.
    if (loaded && (!report.doc || report.doc.pageCount < loaded.pageCount)) return { doc: loaded, format, warnings, bytes: data };
    if (!report.doc || !report.bytes) throw new Error(report.summary);
    return { doc: report.doc, format, warnings, repair: report, bytes: report.bytes };
  }
  if (format === 'jpeg' || format === 'png' || format === 'gif' || format === 'webp' || format === 'bmp' || format === 'tiff' || format === 'svg') {
    const doc = PdfDocument.create();
    const spec = await imageSpecFromBytes(data, format);
    addImagePage(doc, spec, { paper: 'image' });
    doc.ensureInfo().set('Title', { toText: () => name } as any);
    const { PdfString } = await import('../pdf/objects');
    doc.ensureInfo().set('Title', PdfString.fromText(name.replace(/\.[^.]+$/, '')));
    const bytes = doc.save({ incremental: false });
    return { doc: PdfDocument.load(bytes), format, warnings, bytes };
  }
  if (format === 'txt' || format === 'md' || format === 'html') {
    let text = decodeXml(data);
    if (format === 'html') text = htmlToText(text);
    const doc = PdfDocument.create();
    addTextPages(doc, text, { title: name.replace(/\.[^.]+$/, ''), paper: PAPER.letter, font: 'Helvetica' });
    const bytes = doc.save({ incremental: false });
    return { doc: PdfDocument.load(bytes), format, warnings, bytes };
  }
  if (format === 'zip' || format === 'qfr') {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(data);
    const pdfs = Object.keys(zip.files).filter((n) => /\.pdf$/i.test(n) && !zip.files[n].dir).sort();
    if (!pdfs.length) throw new Error('The archive holds no PDF files.');
    const first = await zip.file(pdfs[0])!.async('uint8array');
    const r = await openAsPdf(first, pdfs[0], opts);
    if (format === 'qfr') {
      const xfdf = Object.keys(zip.files).find((n) => /\.xfdf$/i.test(n));
      if (xfdf) { const { importXfdf } = await import('../pdf/ops/annots'); const n = importXfdf(r.doc, await zip.file(xfdf)!.async('string')); if (n) warnings.push(`${n} comment(s) from the review package applied.`); }
    } else if (pdfs.length > 1) {
      const { importPages } = await import('../pdf/ops/pages');
      for (const n of pdfs.slice(1)) { try { const d = PdfDocument.load(await zip.file(n)!.async('uint8array')); importPages(d, r.doc, d.pages.map((_, i) => i)); } catch { warnings.push(`${n} could not be read.`); } }
      warnings.push(`${pdfs.length} PDFs from the archive were combined.`);
    }
    return { ...r, format };
  }
  if (format === 'xfdf' || format === 'fdf' || format === 'json') throw new Error(`${formatById(format)?.label || format} holds form or comment data: open the PDF first, then use Forms ▸ Import Data or Comment ▸ Import Comments.`);
  throw new Error(`QuillFolio cannot open ${name}.`);
}

export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, noscript').forEach((e) => e.remove());
  const out: string[] = [];
  const walk = (el: Element) => {
    for (const n of [...el.childNodes]) {
      if (n.nodeType === 3) out.push((n.textContent || '').replace(/\s+/g, ' '));
      else if (n.nodeType === 1) {
        const e = n as Element;
        const tag = e.tagName.toLowerCase();
        if (/^h[1-6]$/.test(tag)) { out.push('\n\n' + '#'.repeat(+tag[1]) + ' '); walk(e); out.push('\n\n'); }
        else if (tag === 'li') { out.push('\n- '); walk(e); }
        else if (tag === 'br') out.push('\n');
        else if (/^(p|div|tr|section|article|blockquote|pre|ul|ol|table|header|footer|main)$/.test(tag)) { out.push('\n\n'); walk(e); out.push('\n\n'); }
        else walk(e);
      }
    }
  };
  walk(doc.body);
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Decodes an image file into an ImageSpec using the browser (JPEG stays JPEG). */
export async function imageSpecFromBytes(data: Uint8Array, format?: string): Promise<ImageSpec> {
  const f = format || sniffFormat(data, '') || 'png';
  if (f === 'jpeg') {
    const info = jpegInfo(data);
    if (info) return { kind: 'jpeg', data, width: info.width, height: info.height, gray: info.components === 1, cmyk: info.components === 4 };
  }
  let bytes = data;
  let mime = formatById(f)?.mime || 'image/png';
  if (f === 'tiff') {
    const { tiffToBmp } = await import('./tiff');
    const bmp = tiffToBmp(data);
    if (!bmp) throw new Error('This TIFF uses a compression QuillFolio cannot read (baseline, PackBits and LZW are supported).');
    bytes = bmp; mime = 'image/bmp';
  }
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') throw new Error('Image decoding needs a browser.');
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const bmp = await (f === 'svg' ? svgToBitmap(blob) : createImageBitmap(blob));
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width; canvas.height = bmp.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  const id = ctx.getImageData(0, 0, bmp.width, bmp.height);
  const rgb = new Uint8Array(bmp.width * bmp.height * 3);
  const alpha = new Uint8Array(bmp.width * bmp.height);
  let hasAlpha = false;
  for (let i = 0, j = 0; i < id.data.length; i += 4, j += 3) { rgb[j] = id.data[i]; rgb[j + 1] = id.data[i + 1]; rgb[j + 2] = id.data[i + 2]; alpha[i / 4] = id.data[i + 3]; if (id.data[i + 3] < 255) hasAlpha = true; }
  return { kind: 'rgb', data: rgb, width: bmp.width, height: bmp.height, alpha: hasAlpha ? alpha : undefined };
}

async function svgToBitmap(blob: Blob): Promise<ImageBitmap> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('SVG could not be decoded')); img.src = url; });
    const w = img.naturalWidth || 800, h = img.naturalHeight || 600;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d')!.drawImage(img, 0, 0, w, h);
    return createImageBitmap(c);
  } finally { URL.revokeObjectURL(url); }
}

export { PasswordNeeded };
