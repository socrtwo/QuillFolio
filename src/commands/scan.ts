/**
 * Scan/OCR tab: PDFs from images and the camera, text recognition with tesseract.js (an invisible
 * text layer written into the page), language data on demand, and scan clean-up (deskew, despeckle,
 * auto-crop, compression, reordering).
 */
import { def } from './registry';
import type { App } from '../app';
import { openDialog, toast, confirmDialog } from '../ui/dialog';
import { pickFile } from '../ui/dom';
import { PdfDocument, type PageInfo } from '../pdf/document';
import { addImagePage, imageXObject, ensureFont, litText, jpegInfo, PAPER } from '../pdf/build';
import { parseContent, serializeContent } from '../pdf/content';
import { textWidth } from '../pdf/stdfonts';
import { fmtNum } from '../pdf/writer';
import { bytesOf, concat, PdfString } from '../pdf/objects';
import { setPageBox, setPageOrder } from '../pdf/ops/pages';
import { listImages } from '../pdf/ops/optimize';
import { extractImage, rawToRgba } from '../pdf/ops/extract';
import { pageRuns, replaceRunText } from '../pdf/ops/textedit';
import { imageSpecFromBytes } from '../io';
import { askPages, pageOf, saveBytes, baseName, viewer, esc, targetPages } from './util';

export const OCR_LANGUAGES: [string, string][] = [
  ['eng', 'English'], ['spa', 'Spanish'], ['fra', 'French'], ['deu', 'German'], ['ita', 'Italian'], ['por', 'Portuguese'], ['nld', 'Dutch'], ['swe', 'Swedish'], ['dan', 'Danish'], ['nor', 'Norwegian'], ['fin', 'Finnish'],
  ['pol', 'Polish'], ['ces', 'Czech'], ['hun', 'Hungarian'], ['ron', 'Romanian'], ['rus', 'Russian'], ['ukr', 'Ukrainian'], ['ell', 'Greek'], ['tur', 'Turkish'], ['heb', 'Hebrew'], ['ara', 'Arabic'], ['hin', 'Hindi'],
  ['chi_sim', 'Chinese (simplified)'], ['chi_tra', 'Chinese (traditional)'], ['jpn', 'Japanese'], ['kor', 'Korean'], ['vie', 'Vietnamese'], ['tha', 'Thai'], ['ind', 'Indonesian'], ['lat', 'Latin'], ['osd', 'Orientation and script detection'],
];
const LANG_PATH = 'https://tessdata.projectnaptha.com/4.0.0';
const CONSENT_KEY = 'quillfolio.ocr.consent';

let workerPromise: Promise<any> | null = null;
let workerLangs = '';

async function ocrWorker(app: App, langs: string): Promise<any> {
  if (workerPromise && workerLangs === langs) return workerPromise;
  if (workerPromise) { try { (await workerPromise).terminate(); } catch { /* */ } workerPromise = null; }
  workerLangs = langs;
  workerPromise = (async () => {
    const T = await import('tesseract.js');
    const base = new URL('./tesseract/', document.baseURI).href;
    const w = await T.createWorker(langs.split('+'), T.OEM.LSTM_ONLY, {
      workerPath: base + 'worker.min.js', corePath: base + 'core/', langPath: LANG_PATH, workerBlobURL: false, gzip: true,
      logger: (m: any) => { if (m.status && typeof m.progress === 'number' && m.progress < 1) app.ui.status?.(`● OCR: ${m.status} ${Math.round(m.progress * 100)}%`); },
      errorHandler: (e: any) => console.warn('tesseract', e),
    });
    return w;
  })();
  return workerPromise;
}

async function ensureConsent(app: App, langs: string): Promise<boolean> {
  if (localStorage.getItem(CONSENT_KEY) === '1') return true;
  const ok = await confirmDialog('Download Language Data', `Text recognition needs language data for ${langs.split('+').map((l) => OCR_LANGUAGES.find((x) => x[0] === l)?.[1] || l).join(', ')} (about 2–15 MB per language). It is downloaded once from ${LANG_PATH} and kept on this device. The page images never leave this device. Continue?`, 'Download');
  if (ok) localStorage.setItem(CONSENT_KEY, '1');
  void app;
  return ok;
}

interface OcrWord { text: string; x0: number; y0: number; x1: number; y1: number; conf: number }

/** Recognizes one page: returns words with boxes in PDF user space. */
async function recognizePage(app: App, i: number, langs: string, dpi = 200): Promise<{ words: OcrWord[]; text: string }> {
  const v = viewer(app);
  if (!v.pdf) throw new Error('The page is not rendered yet.');
  const page = await v.pdf.getPage(i + 1);
  const vp = page.getViewport({ scale: dpi / 72 });
  const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  const ctx = c.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp } as any).promise;
  const w = await ocrWorker(app, langs);
  const res = await w.recognize(c, {}, { text: true, blocks: true });
  const words: OcrWord[] = [];
  for (const b of res.data.blocks || []) for (const par of b.paragraphs || []) for (const line of par.lines || []) for (const wd of line.words || []) {
    if (!wd.text?.trim()) continue;
    const a = vp.convertToPdfPoint(wd.bbox.x0, wd.bbox.y1), z = vp.convertToPdfPoint(wd.bbox.x1, wd.bbox.y0);
    words.push({ text: wd.text, x0: Math.min(a[0], z[0]), y0: Math.min(a[1], z[1]), x1: Math.max(a[0], z[0]), y1: Math.max(a[1], z[1]), conf: wd.confidence });
  }
  return { words, text: res.data.text || '' };
}

/** Writes words as invisible text (render mode 3) so the page becomes searchable and selectable. */
export function writeTextLayer(doc: PdfDocument, p: PageInfo, words: OcrWord[], lang: string): void {
  const font = ensureFont(doc, p, 'Helvetica');
  const ops: string[] = ['q BT 3 Tr'];
  for (const w of words) {
    const size = Math.max(2, (w.y1 - w.y0) * 0.9);
    const tw = textWidth(w.text, 'Helvetica', size) || 1;
    const tz = Math.max(10, Math.min(500, ((w.x1 - w.x0) / tw) * 100));
    ops.push(`/${font} ${fmtNum(size)} Tf ${fmtNum(tz)} Tz 1 0 0 1 ${fmtNum(w.x0)} ${fmtNum(w.y0 + size * 0.22)} Tm ${litText(w.text)} Tj`);
  }
  ops.push('ET Q');
  doc.setPageContent(p, concat([doc.pageContent(p), bytesOf('\n' + ops.join('\n') + '\n')]));
  p.dict.set('QuillFolioOCR', PdfString.fromText(lang));
  if (p.ref) doc.update(p.ref, p.dict);
}

/** Removes an earlier OCR layer (the last invisible text block Anne's Folio wrote). */
function stripOcrLayer(doc: PdfDocument, p: PageInfo): void {
  const ops = parseContent(doc.pageContent(p));
  // Drop every BT…ET block whose first Tr is 3.
  const out = [] as typeof ops;
  let i = 0;
  while (i < ops.length) {
    if (ops[i].op === 'BT') {
      let j = i + 1; let invisible = false;
      while (j < ops.length && ops[j].op !== 'ET') { if (ops[j].op === 'Tr' && ops[j].args[0] === 3) invisible = true; j++; }
      if (invisible) { i = j + 1; continue; }
    }
    out.push(ops[i]); i++;
  }
  doc.setPageContent(p, serializeContent(out));
}

async function recognize(app: App, pages: number[], langs: string, replace: boolean): Promise<{ words: number; pages: number; text: string[] }> {
  if (!(await ensureConsent(app, langs))) return { words: 0, pages: 0, text: [] };
  let words = 0; const texts: string[] = [];
  const results: { i: number; words: OcrWord[] }[] = [];
  for (const i of pages) {
    app.ui.status?.(`● OCR page ${i + 1} of ${pages.length}…`);
    const r = await recognizePage(app, i, langs);
    results.push({ i, words: r.words }); words += r.words.length; texts.push(r.text);
  }
  app.ui.status?.('');
  app.edit('Recognize Text', (doc) => { for (const r of results) { const p = doc.pages[r.i]; if (replace) stripOcrLayer(doc, p); writeTextLayer(doc, p, r.words, langs); } });
  (app.tab as any).ocrText = Object.assign((app.tab as any).ocrText || {}, Object.fromEntries(results.map((r, k) => [r.i, texts[k]])));
  return { words, pages: pages.length, text: texts };
}

/** Renders a page to a canvas at a resolution (through the viewer's renderer). */
async function renderCanvas(app: App, i: number, dpi: number): Promise<{ c: HTMLCanvasElement; vp: any }> {
  const v = viewer(app); if (!v.pdf) throw new Error('Not rendered');
  const page = await v.pdf.getPage(i + 1);
  const vp = page.getViewport({ scale: dpi / 72 });
  const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  const ctx = c.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp } as any).promise;
  return { c, vp };
}

function gray(c: HTMLCanvasElement): Uint8ClampedArray {
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  const g = new Uint8ClampedArray(c.width * c.height);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  return g;
}

/** Skew angle in degrees from the variance of horizontal projection profiles (text lines align at the right angle). */
export function estimateSkew(g: Uint8ClampedArray, w: number, h: number): number {
  let best = 0, bestScore = -1;
  const step = 2;
  for (let deg = -6; deg <= 6; deg += 0.5) {
    const t = Math.tan((deg * Math.PI) / 180);
    const rows = new Float64Array(h);
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) { const yy = Math.round(y + (x - w / 2) * t); if (yy >= 0 && yy < h && g[yy * w + x] < 128) rows[y]++; }
    let mean = 0; for (let y = 0; y < h; y += step) mean += rows[y]; mean /= h / step;
    let varc = 0; for (let y = 0; y < h; y += step) varc += (rows[y] - mean) ** 2;
    if (varc > bestScore) { bestScore = varc; best = deg; }
  }
  return best;
}

/** Replaces a page's content with a JPEG of the canvas (for scan clean-ups), keeping annotations. */
function replaceWithImage(doc: PdfDocument, p: PageInfo, jpeg: Uint8Array): void {
  const info = jpegInfo(jpeg);
  if (!info) throw new Error('Could not encode the page image.');
  const ref = imageXObject(doc, { kind: 'jpeg', data: jpeg, width: info.width, height: info.height, gray: info.components === 1 });
  const { ensureXObject } = requireBuild();
  const name = ensureXObject(doc, p, 'QFScan', ref);
  const [x0, y0, x1, y1] = p.mediaBox;
  doc.setPageContent(p, bytesOf(`q ${fmtNum(x1 - x0)} 0 0 ${fmtNum(y1 - y0)} ${fmtNum(x0)} ${fmtNum(y0)} cm /${name} Do Q\n`));
  p.dict.delete('Rotate');
  if (p.ref) doc.update(p.ref, p.dict);
}

/** The runs of a page's invisible (recognized) text layer. */
export function invisibleRuns(doc: PdfDocument, p: PageInfo) {
  const ops = parseContent(doc.pageContent(p));
  let tr = 0; const invisible = new Set<number>();
  ops.forEach((o, k) => { if (o.op === 'Tr') tr = Number(o.args[0]) || 0; if (o.op === 'BT') tr = 0; if ((o.op === 'Tj' || o.op === 'TJ' || o.op === "'" || o.op === '"') && tr === 3) invisible.add(k); });
  return pageRuns(doc, p).filter((r) => invisible.has(r.opIndex));
}

const toJpeg = (c: HTMLCanvasElement, q = 0.85): Promise<Uint8Array> => new Promise((res, rej) => c.toBlob(async (b) => (b ? res(new Uint8Array(await b.arrayBuffer())) : rej(new Error('encode'))), 'image/jpeg', q));

def([
  {
    id: 'scan.fromImages', label: 'PDF from Images…', icon: 'photo_library', tab: 'Scan/OCR', group: 'Create', popular: true, noRecord: true,
    tip: 'Photos, scans and screenshots as a new PDF, one per page',
    run: async (app) => {
      const files = await pickFile('image/*', true);
      if (!files.length) return;
      const r = await openDialog({ title: 'PDF from Images', fields: [{ key: 'paper', label: 'Page size', type: 'select', options: [{ value: 'image', label: 'Fit the page to each picture' }, ...Object.keys(PAPER).map((k) => ({ value: k, label: k.toUpperCase() }))], value: 'image', half: true }, { key: 'dpi', label: 'Picture resolution (dpi)', type: 'number', min: 36, max: 1200, value: 200, half: true }, { key: 'ocr', label: 'Recognize text afterwards', type: 'checkbox', value: false }], ok: 'Create' });
      if (!r) return;
      const doc = PdfDocument.create();
      for (const f of files) { try { addImagePage(doc, await imageSpecFromBytes(new Uint8Array(await f.arrayBuffer()), f.type === 'image/jpeg' ? 'jpeg' : undefined), { paper: r.paper === 'image' ? 'image' : PAPER[r.paper], dpi: +r.dpi || 200 }); } catch (e: any) { toast(`${f.name}: ${e?.message || e}`); } }
      if (!doc.pageCount) return;
      const bytes = doc.save({ incremental: false });
      const name = files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '') : 'Scanned pages';
      const t = app.createTab(PdfDocument.load(bytes), { title: name, fileName: `${name}.pdf` }, bytes);
      t.dirty = true;
      if (r.ocr) { await t.ui.reload(); app.exec('scan.recognize', { pages: doc.pages.map((_, i) => i) }); }
    },
  },
  {
    id: 'scan.fromCamera', label: 'Scan with Camera', icon: 'photo_camera', tab: 'Scan/OCR', group: 'Create', noRecord: true,
    tip: 'Take a photo (on phones and tablets) and add it as a page',
    run: async (app) => {
      const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'; input.setAttribute('capture', 'environment');
      const file = await new Promise<File | null>((res) => { input.onchange = () => res(input.files?.[0] || null); input.oncancel = () => res(null); input.click(); });
      if (!file) return;
      const spec = await imageSpecFromBytes(new Uint8Array(await file.arrayBuffer()), file.type === 'image/jpeg' ? 'jpeg' : undefined);
      const at = Math.max(...targetPages(app)) + 1;
      app.edit('Scan with Camera', (doc) => addImagePage(doc, spec, { paper: 'image', dpi: 200, at }));
      app.tab.ui.goToPage(at);
    },
  },
  {
    id: 'scan.recognize', label: 'Recognize Text', icon: 'document_scanner', tab: 'Scan/OCR', group: 'Recognize Text', popular: true,
    tip: 'OCR the chosen pages and add an invisible text layer so they can be searched, selected and copied',
    run: async (app, arg?: { pages?: number[]; langs?: string }) => {
      let pages = arg?.pages, langs = arg?.langs || app.prefs.ocrLanguage || 'eng', replace = true;
      if (!pages) {
        const r = await askPages(app, 'Recognize Text', [
          { key: 'langs', label: 'Languages (codes joined with +)', type: 'text', value: langs, help: 'Scan/OCR ▸ OCR Languages lists the codes.' },
          { key: 'replace', label: 'Replace an earlier recognized layer on these pages', type: 'checkbox', value: true },
          { key: 'i', type: 'info', html: '<p class="ql-help">Recognition runs on this device. Language data (a few MB) downloads once per language. Pages with real text already do not need OCR.</p>' },
        ], 'Recognize');
        if (!r) return;
        pages = r.pages; langs = String(r.values.langs).trim() || 'eng'; replace = !!r.values.replace;
        app.prefs.ocrLanguage = langs; app.savePrefs();
      }
      try {
        const res = await recognize(app, pages, langs, replace);
        if (res.pages) toast(`Recognized ${res.words} word(s) on ${res.pages} page(s).`, { ms: 6000, action: 'Clean up', onAction: () => app.exec('scan.ocrCleanup') });
      } catch (e: any) { app.ui.status?.(''); toast(`OCR failed: ${e?.message || e}`, { ms: 8000 }); }
    },
  },
  {
    id: 'scan.languages', label: 'OCR Languages…', icon: 'translate', tab: 'Scan/OCR', group: 'Recognize Text', noRecord: true, edits: false,
    tip: 'Choose the languages to recognize; their data downloads on first use and stays on this device',
    run: async (app) => {
      const cur = (app.prefs.ocrLanguage || 'eng').split('+');
      const r = await openDialog({ title: 'OCR Languages', fields: [
        { key: 'l', label: 'Languages (several are allowed; recognition is slower with more)', type: 'list', multiple: true, rows: 12, options: OCR_LANGUAGES.map(([v, l]) => ({ value: v, label: `${l} (${v})` })), value: cur },
        { key: 'i', type: 'info', html: `<p class="ql-help">Data comes from ${esc(LANG_PATH)} (tessdata, Apache 2.0), about 2–15 MB per language, cached in this browser. Nothing else is sent anywhere.</p>` },
      ], buttons: [{ label: 'Delete Cached Data', onClick: async () => { try { if (workerPromise) { (await workerPromise).terminate(); workerPromise = null; } indexedDB.deleteDatabase('keyval-store'); toast('Cached language data deleted.'); } catch { toast('Could not delete the cache.'); } } }] });
      if (!r) return;
      const langs = (r.l as string[]).filter(Boolean);
      if (!langs.length) { toast('Choose at least one language.'); return; }
      app.prefs.ocrLanguage = langs.join('+'); app.savePrefs();
      toast(`OCR languages: ${langs.join(', ')}`);
    },
  },
  {
    id: 'scan.exportText', label: 'Export Recognized Text', icon: 'notes', tab: 'Scan/OCR', group: 'Recognize Text', edits: false, noRecord: true,
    tip: 'Save the text of the pages (including recognized layers) as a .txt file',
    run: async (app) => { const v = viewer(app); const out: string[] = []; for (let i = 0; i < app.doc.pageCount; i++) out.push(`--- page ${i + 1} ---\n${(app.tab as any).ocrText?.[i] ?? (await v.pageText(i))}`); await saveBytes(out.join('\n\n'), `${baseName(app)} OCR.txt`, 'text/plain'); },
  },
  {
    id: 'scan.ocrCleanup', label: 'OCR Cleanup…', icon: 'spellcheck', tab: 'Scan/OCR', group: 'Recognize Text',
    tip: 'Correct words in the recognized (invisible) text layer of the current page',
    run: async (app) => {
      const p = pageOf(app, app.page);
      const runs = invisibleRuns(app.doc, p);
      if (!runs.length) { toast('This page has no recognized text layer. Use Recognize Text first.'); return; }
      const r = await openDialog({ title: `OCR Cleanup: page ${p.index + 1}`, wide: true, fields: [{ key: 't', label: `${runs.length} recognized word(s), one per line; edit any of them`, type: 'textarea', rows: 18, value: runs.map((x) => x.text).join('\n') }], ok: 'Apply' });
      if (!r) return;
      const lines = String(r.t).split('\n');
      if (lines.length !== runs.length) { toast('Keep one line per word (the number of lines changed).'); return; }
      let n = 0;
      app.edit('OCR Cleanup', (doc) => { runs.forEach((run, k) => { if (lines[k] !== run.text) { replaceRunText(doc, p, run, lines[k]); n++; } }); });
      toast(`${n} word(s) corrected.`);
    },
  },
  {
    id: 'scan.deskew', label: 'Deskew', icon: 'rotate_90_degrees_ccw', tab: 'Scan/OCR', group: 'Enhance Scans',
    tip: 'Straighten tilted scans (the angle is measured from the text lines; the page content is rotated about its center)',
    run: async (app) => {
      const r = await askPages(app, 'Deskew Pages', [{ key: 'manual', label: 'Angle in degrees (blank = detect)', type: 'text', value: '' }], 'Deskew');
      if (!r) return;
      const angles: { i: number; deg: number }[] = [];
      for (const i of r.pages) {
        let deg = parseFloat(r.values.manual);
        if (!Number.isFinite(deg)) { const { c } = await renderCanvas(app, i, 50); deg = estimateSkew(gray(c), c.width, c.height); }
        if (Math.abs(deg) >= 0.25) angles.push({ i, deg });
      }
      if (!angles.length) { toast('The pages look straight already.'); return; }
      app.edit('Deskew', (doc) => { for (const a of angles) { const p = doc.pages[a.i]; const [x0, y0, x1, y1] = p.mediaBox; const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2; const rad = (-a.deg * Math.PI) / 180; const cos = Math.cos(rad), sin = Math.sin(rad); const pre = `q ${fmtNum(cos)} ${fmtNum(sin)} ${fmtNum(-sin)} ${fmtNum(cos)} ${fmtNum(cx - cos * cx + sin * cy)} ${fmtNum(cy - sin * cx - cos * cy)} cm\n`; doc.setPageContent(p, concat([bytesOf(pre), doc.pageContent(p), bytesOf('\nQ\n')])); } });
      toast(`Deskewed ${angles.length} page(s): ${angles.map((a) => `${a.i + 1}: ${a.deg.toFixed(1)}°`).join(', ')}`);
    },
  },
  {
    id: 'scan.despeckle', label: 'Despeckle', icon: 'blur_on', tab: 'Scan/OCR', group: 'Enhance Scans',
    tip: 'Remove dust and noise from scanned pages with a median filter (the page is replaced by its cleaned image; use on scans only)',
    run: async (app) => {
      const r = await askPages(app, 'Despeckle Pages', [{ key: 'dpi', label: 'Resolution (dpi)', type: 'number', min: 72, max: 400, value: 200, half: true }, { key: 'bw', label: 'Also convert to black and white', type: 'checkbox', value: false, half: true }, { key: 'i', type: 'info', html: '<p class="ql-help">The page content becomes one image; text in the page (including recognized text) is lost, so run OCR afterwards.</p>' }], 'Despeckle');
      if (!r) return;
      if (!(await confirmDialog('Despeckle', `Replace ${r.pages.length} page(s) with cleaned images?`, 'Despeckle'))) return;
      const images: { i: number; jpeg: Uint8Array }[] = [];
      for (const i of r.pages) {
        app.ui.status?.(`● Cleaning page ${i + 1}…`);
        const { c } = await renderCanvas(app, i, +r.values.dpi || 200);
        const ctx = c.getContext('2d')!; const id = ctx.getImageData(0, 0, c.width, c.height); const d = id.data; const w = c.width, hh = c.height;
        const g = gray(c); const out = new Uint8ClampedArray(g.length);
        for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
          if (x === 0 || y === 0 || x === w - 1 || y === hh - 1) { out[y * w + x] = g[y * w + x]; continue; }
          const n = [g[(y - 1) * w + x - 1], g[(y - 1) * w + x], g[(y - 1) * w + x + 1], g[y * w + x - 1], g[y * w + x], g[y * w + x + 1], g[(y + 1) * w + x - 1], g[(y + 1) * w + x], g[(y + 1) * w + x + 1]].sort((a, b) => a - b);
          out[y * w + x] = n[4];
        }
        for (let j = 0, k = 0; j < d.length; j += 4, k++) { const v = r.values.bw ? (out[k] < 150 ? 0 : 255) : out[k]; d[j] = d[j + 1] = d[j + 2] = v; }
        ctx.putImageData(id, 0, 0);
        images.push({ i, jpeg: await toJpeg(c, r.values.bw ? 0.9 : 0.85) });
      }
      app.ui.status?.('');
      app.edit('Despeckle', (doc) => { for (const im of images) replaceWithImage(doc, doc.pages[im.i], im.jpeg); });
    },
  },
  {
    id: 'scan.autoCrop', label: 'Auto-Crop', icon: 'crop_free', tab: 'Scan/OCR', group: 'Enhance Scans',
    tip: 'Trim the white borders of scanned pages (sets the crop box; nothing is deleted)',
    run: async (app) => {
      const r = await askPages(app, 'Auto-Crop Pages', [{ key: 'margin', label: 'Keep a margin of (pt)', type: 'number', min: 0, max: 144, value: 12 }], 'Crop');
      if (!r) return;
      const boxes: { i: number; box: [number, number, number, number] }[] = [];
      for (const i of r.pages) {
        const { c, vp } = await renderCanvas(app, i, 72);
        const g = gray(c); const w = c.width, hh = c.height;
        let x0 = w, y0 = hh, x1 = 0, y1 = 0;
        for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) if (g[y * w + x] < 200) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        if (x1 <= x0 || y1 <= y0) continue;
        const m = +r.values.margin || 0;
        const a = vp.convertToPdfPoint(x0, y1), b = vp.convertToPdfPoint(x1, y0);
        const p = app.doc.pages[i];
        boxes.push({ i, box: [Math.max(p.mediaBox[0], Math.min(a[0], b[0]) - m), Math.max(p.mediaBox[1], Math.min(a[1], b[1]) - m), Math.min(p.mediaBox[2], Math.max(a[0], b[0]) + m), Math.min(p.mediaBox[3], Math.max(a[1], b[1]) + m)] });
      }
      if (!boxes.length) { toast('No content was found to crop to.'); return; }
      app.edit('Auto-Crop', (doc) => { for (const b of boxes) setPageBox(doc, [b.i], 'CropBox', b.box); });
      toast(`${boxes.length} page(s) cropped. Organize Pages ▸ Crop ▸ Remove Cropping undoes it later.`);
    },
  },
  {
    id: 'scan.compressScans', label: 'Compress Scans…', icon: 'compress', tab: 'Scan/OCR', group: 'Enhance Scans',
    tip: 'Re-encode large page images as JPEG at a chosen quality and size',
    run: async (app) => {
      const r = await askPages(app, 'Compress Scanned Images', [{ key: 'q', label: 'JPEG quality', type: 'range', min: 0.3, max: 0.95, step: 0.05, value: 0.7, half: true }, { key: 'max', label: 'Longest side (px)', type: 'number', min: 300, max: 6000, value: 2000, half: true }, { key: 'gray', label: 'Convert to grayscale', type: 'checkbox', value: false }], 'Compress');
      if (!r) return;
      const want = new Set(r.pages);
      const imgs = listImages(app.doc).filter((im) => want.has(im.page) && im.ref && !im.hasMask && (im.width > 400 || im.height > 400));
      if (!imgs.length) { toast('No large images on those pages.'); return; }
      const before = imgs.reduce((n, im) => n + im.bytes, 0);
      const jobs: { ref: any; jpeg: Uint8Array }[] = [];
      for (const im of imgs) {
        try {
          const ex = extractImage(app.doc, im);
          let bmp: ImageBitmap;
          if (ex.kind === 'jpeg') bmp = await createImageBitmap(new Blob([ex.data as BlobPart], { type: 'image/jpeg' }));
          else { const rgba = rawToRgba(app.doc, ex); if (!rgba) continue; bmp = await createImageBitmap(new ImageData(rgba as any, ex.width, ex.height)); }
          const s = Math.min(1, (+r.values.max || 2000) / Math.max(bmp.width, bmp.height));
          const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
          const ctx = c.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); if (r.values.gray) ctx.filter = 'grayscale(1)'; ctx.drawImage(bmp, 0, 0, c.width, c.height);
          const jpeg = await toJpeg(c, +r.values.q || 0.7);
          if (jpeg.length < im.bytes * 0.95) jobs.push({ ref: im.ref, jpeg });
        } catch (e) { console.warn('compress', e); }
      }
      if (!jobs.length) { toast('The images are already small.'); return; }
      app.edit('Compress Scans', (doc) => { for (const j of jobs) { const info = jpegInfo(j.jpeg)!; const nr = imageXObject(doc, { kind: 'jpeg', data: j.jpeg, width: info.width, height: info.height, gray: info.components === 1 }); doc.update(j.ref, doc.resolve(nr)); doc.remove(nr); } });
      const afterBytes = jobs.reduce((n, j) => n + j.jpeg.length, 0) + imgs.filter((im) => !jobs.some((j) => j.ref === im.ref)).reduce((n, im) => n + im.bytes, 0);
      toast(`${jobs.length} image(s) recompressed: ${(before / 1024).toFixed(0)} KB → ${(afterBytes / 1024).toFixed(0)} KB. Save As a rewritten PDF to shrink the file.`, { ms: 8000 });
    },
  },
  {
    id: 'scan.reorder', label: 'Reorder Duplex Scan', icon: 'swap_calls', tab: 'Scan/OCR', group: 'Pages',
    tip: 'Fix a one-sided scanner\'s output: fronts (1, 3, 5…) followed by backs (6, 4, 2) become 1, 2, 3…',
    run: async (app) => {
      const n = app.doc.pageCount;
      const r = await openDialog({ title: 'Reorder Duplex Scan', fields: [{ key: 'mode', label: 'The pages are', type: 'radio', options: [{ value: 'backsReversed', label: 'All fronts, then all backs scanned last page first' }, { value: 'backsForward', label: 'All fronts, then all backs in order' }, { value: 'alternate', label: 'Alternating already; swap each pair' }], value: 'backsReversed' }], ok: 'Reorder' });
      if (!r) return;
      const half = Math.ceil(n / 2);
      let order: number[] = [];
      if (r.mode === 'alternate') { for (let i = 0; i < n; i += 2) { if (i + 1 < n) order.push(i + 1); order.push(i); } }
      else { const fronts = [...Array(half).keys()]; const backs = [...Array(n - half).keys()].map((k) => half + k); if (r.mode === 'backsReversed') backs.reverse(); for (let i = 0; i < half; i++) { order.push(fronts[i]); if (backs[i] != null) order.push(backs[i]); } }
      app.edit('Reorder Duplex Scan', (doc) => setPageOrder(doc, order));
    },
  },
  {
    id: 'scan.makeSearchableReport', label: 'Searchable Pages Report', icon: 'fact_check', tab: 'Scan/OCR', group: 'Recognize Text', edits: false, noRecord: true,
    tip: 'Which pages have text (real or recognized) and which are image-only',
    run: async (app) => {
      const v = viewer(app);
      const items = [] as { level: 'info' | 'warning'; text: string; page: number }[];
      for (let i = 0; i < app.doc.pageCount; i++) { const t = (await v.pageText(i)).trim(); const ocr = app.doc.pages[i].dict.has('QuillFolioOCR'); items.push(t ? { level: 'info', text: `Page ${i + 1}: ${t.split(/\s+/).length} word(s)${ocr ? ' (recognized)' : ''}`, page: i } : { level: 'warning', text: `Page ${i + 1}: no text (image only)`, page: i }); }
      const missing = items.filter((x) => x.level === 'warning').map((x) => x.page);
      app.ui.openPane('report', { title: 'Searchable Pages', items, actions: missing.length ? [{ label: `Recognize ${missing.length} page(s)`, run: () => app.exec('scan.recognize', { pages: missing }) }] : [] });
    },
  },
]);

import * as buildMod from '../pdf/build';
function requireBuild() { return buildMod; }
export { PdfString };
