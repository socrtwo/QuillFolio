/**
 * The renderer: pdf.js (Apache 2.0) rasterizes pages and extracts positioned text for the viewer.
 * Anne's Folio's own engine remains the document of record; pdf.js only ever reads the bytes the
 * engine produces. The worker, CMaps, standard fonts and WASM decoders are bundled (scripts/copy-pdfjs.mjs).
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const base = (() => { try { return new URL('./pdfjs/', document.baseURI).href; } catch { return './pdfjs/'; } })();

export async function openPdfjs(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  const data = bytes.slice(); // pdf.js takes ownership of the buffer
  const task = pdfjs.getDocument({ data, password, cMapUrl: base + 'cmaps/', cMapPacked: true, standardFontDataUrl: base + 'standard_fonts/', wasmUrl: base + 'wasm/', iccUrl: base + 'iccs/', isEvalSupported: false, stopAtErrors: false, enableXfa: false } as any);
  const pdf = await task.promise;
  // pdf.js keeps destroy() on the loading task; the viewer calls it through the proxy.
  (pdf as any).destroy = () => task.destroy();
  return pdf;
}

export interface TextItem { str: string; x: number; y: number; w: number; h: number; dir: string; fontName: string; hasEOL: boolean }

/** Text items in PDF user space (bottom-left origin), unrotated page coordinates. */
export async function pageTextItems(page: PDFPageProxy): Promise<TextItem[]> {
  const tc = await page.getTextContent();
  const out: TextItem[] = [];
  for (const it of tc.items as any[]) {
    if (!('str' in it)) continue;
    const [a, b, c, d, e, f] = it.transform as number[];
    const fontH = Math.hypot(c, d) || Math.abs(d) || 1;
    const w = it.width ?? Math.hypot(a, b) * (it.str.length || 1);
    out.push({ str: it.str, x: e, y: f, w, h: it.height || fontH, dir: it.dir, fontName: it.fontName, hasEOL: !!it.hasEOL });
    void a; void b;
  }
  return out;
}

/** Plain text of a page with line breaks where pdf.js reports them. */
export async function pageTextString(page: PDFPageProxy): Promise<string> {
  const tc = await page.getTextContent();
  let s = '';
  let lastY: number | null = null;
  for (const it of tc.items as any[]) {
    if (!('str' in it)) continue;
    const y = it.transform[5];
    if (lastY != null && Math.abs(y - lastY) > (it.height || 10) * 0.6) s += '\n';
    else if (s && !s.endsWith(' ') && !s.endsWith('\n') && it.str && !it.str.startsWith(' ')) {
      // pdf.js inserts spaces as items; keep a space between words only when x jumps.
    }
    s += it.str;
    if (it.hasEOL) s += '\n';
    lastY = y;
  }
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

export const PdfjsTextLayer = pdfjs.TextLayer;
export const AnnotationMode = pdfjs.AnnotationMode;
export const pdfjsVersion = pdfjs.version;
export type { PDFDocumentProxy, PDFPageProxy };
