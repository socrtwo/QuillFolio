/** Helpers shared by the command modules (no commands are defined here). */
import type { App } from '../app';
import type { PageInfo, PdfDocument } from '../pdf/document';
import type { Ref } from '../pdf/objects';
import { pageAnnotations, type AnnotInfo } from '../pdf/structure';
import { openDialog, toast } from '../ui/dialog';
import { saveAs } from '../platform/native';
import { parseRanges } from '../pdf/ops/pages';
import type { Viewer } from '../view/viewer';

export type RGB = [number, number, number];
export type Rect = [number, number, number, number];

export const toBlob = (data: Uint8Array | string, mime: string): Blob => new Blob([data as BlobPart], { type: mime });

/** The document's base file name without extension. */
export const baseName = (app: App): string => (app.tab.fileName || app.tab.title || 'Document').replace(/\.[^.]+$/, '');

/** Saves bytes produced by an export with the system save dialog. */
export async function saveBytes(data: Uint8Array | string, name: string, mime: string): Promise<boolean> {
  const r = await saveAs(toBlob(data, mime), name);
  if (r) toast(`Saved ${r.name}`);
  return !!r;
}

export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** '#rrggbb' → [r, g, b] in 0..1. */
export function hexToRgb(hex: string, fallback: RGB = [0, 0, 0]): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
export function rgbToHex(c: RGB | null | undefined, fallback = '#000000'): string {
  if (!c) return fallback;
  return '#' + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
}

export const viewer = (app: App): Viewer => app.viewer;

/** Pages the organize commands act on: the thumbnail selection, or the current page. */
export function targetPages(app: App): number[] { return viewer(app).targetPages(); }

export function currentPage(app: App): PageInfo {
  const p = app.doc.pages[app.page] || app.doc.pages[0];
  if (!p) throw new Error('The document has no pages.');
  return p;
}

/** The selected annotation (object number from the viewer) as engine data. */
export function selectedAnnotation(app: App): { page: PageInfo; ref: Ref; info: AnnotInfo } | null {
  const s = app.tab?.ui?.selectedAnnot;
  if (!s) return null;
  const page = app.doc.pages[s.page];
  if (!page) return null;
  const info = pageAnnotations(app.doc, page).find((a) => a.ref?.num === s.num);
  return info && info.ref ? { page, ref: info.ref, info } : null;
}

export const hasAnnotSelected = (app: App): boolean => !!selectedAnnotation(app);

/** Dialog field for a page range ("1-3, 7, 9-") and its parsing. */
export function rangeField(app: App, key = 'range', label = 'Pages'): { key: string; label: string; type: 'text'; value: string; help: string } {
  const sel = viewer(app).pageSel;
  const value = sel.length > 1 ? compressRange(sel) : String(app.page + 1);
  return { key, label, type: 'text', value, help: `1-${app.doc.pageCount}; e.g. "1-3, 7, 9-" (odd/even allowed)` };
}
export function pagesFromRange(app: App, spec: string): number[] {
  const n = app.doc.pageCount;
  const s = String(spec || '').trim().toLowerCase();
  if (!s || s === 'all') return app.doc.pages.map((_, i) => i);
  if (s === 'odd') return app.doc.pages.map((_, i) => i).filter((i) => i % 2 === 0);
  if (s === 'even') return app.doc.pages.map((_, i) => i).filter((i) => i % 2 === 1);
  const r = parseRanges(s, n);
  if (!r.length) throw new Error(`No pages match "${spec}".`);
  return r;
}
export function compressRange(pages: number[]): string {
  const p = [...pages].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < p.length; i++) { let j = i; while (j + 1 < p.length && p[j + 1] === p[j] + 1) j++; out.push(j > i ? `${p[i] + 1}-${p[j] + 1}` : String(p[i] + 1)); i = j; }
  return out.join(', ');
}

/** Asks for a page range (defaulting to the selection) and returns page indexes. */
export async function askPages(app: App, title: string, extra: any[] = [], ok = 'OK'): Promise<{ pages: number[]; values: Record<string, any> } | null> {
  const r = await openDialog({ title, fields: [rangeField(app), ...extra], ok });
  if (!r) return null;
  return { pages: pagesFromRange(app, r.range), values: r };
}

/** Runs fn(doc) as one undoable step on the active document. */
export function edit<T>(app: App, label: string, fn: (doc: PdfDocument) => T): T | undefined {
  return app.edit(label, (doc) => fn(doc));
}

export function pageOf(app: App, i: number): PageInfo {
  const p = app.doc.pages[i];
  if (!p) throw new Error(`Page ${i + 1} does not exist.`);
  return p;
}

/** The text selected in the viewer, or an empty string. */
export const selectedText = (app: App): string => app.tab?.ui?.selectedText || '';

/** Loads a copy of the active document (for exports that must not alter it). */
export async function docCopy(app: App): Promise<PdfDocument> {
  const { PdfDocument } = await import('../pdf/document');
  return PdfDocument.load(app.tab.bytes, { password: app.tab.password || undefined });
}

/** Builds a PNG (or JPEG) blob of a page through the viewer's renderer. */
export async function pageImage(app: App, i: number, dpi: number, format: 'png' | 'jpeg' = 'png', quality = 0.9): Promise<Blob> {
  const png = await viewer(app).renderPagePng(i, dpi);
  if (format === 'png') return png;
  const bmp = await createImageBitmap(png);
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(bmp, 0, 0);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the page'))), 'image/jpeg', quality));
}

/** Converts a File to an engine image XObject (JPEG kept as is, everything else via canvas). */
export async function imageRefFromFile(app: App, file: Blob): Promise<{ ref: Ref; width: number; height: number }> {
  const { imageSpecFromBytes } = await import('../io');
  const { imageXObject } = await import('../pdf/build');
  const spec = await imageSpecFromBytes(new Uint8Array(await file.arrayBuffer()), file.type === 'image/jpeg' ? 'jpeg' : undefined);
  const ref = imageXObject(app.doc, spec);
  return { ref, width: spec.width, height: spec.height };
}

/** Fits an image into a box (points), centered. */
export function fitBox(w: number, h: number, box: Rect): { x: number; y: number; w: number; h: number } {
  const bw = box[2] - box[0], bh = box[3] - box[1];
  const s = Math.min(bw / w, bh / h);
  const fw = w * s, fh = h * s;
  return { x: box[0] + (bw - fw) / 2, y: box[1] + (bh - fh) / 2, w: fw, h: fh };
}

export const FONT_OPTIONS = ['Helvetica', 'Helvetica-Bold', 'Times-Roman', 'Times-Bold', 'Courier'];

export function zipOf(files: { name: string; data: Uint8Array | string }[]): Promise<Uint8Array> {
  return import('jszip').then(async ({ default: JSZip }) => { const z = new JSZip(); for (const f of files) z.file(f.name, f.data); return z.generateAsync({ type: 'uint8array' }); });
}
