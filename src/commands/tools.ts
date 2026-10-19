/** Tools tab: optimize, extract, inspect, bookmarks, attachments, batch, convert, XMP. */
import { def } from './registry';
import type { App } from '../app';
import { PdfDocument } from '../pdf/document';
import { openDialog, toast, confirmDialog, promptDialog } from '../ui/dialog';
import { pickFile, h } from '../ui/dom';
import { Dict, Name, PdfStream, Ref, PdfString } from '../pdf/objects';
import { readOutlines, writeOutlines, outlinesToInput, readAttachments, addAttachment, removeAttachment, readMetadata, writeMetadata, type OutlineItem, type OutlineInput, type Attachment } from '../pdf/structure';
import { listImages, listFonts, sanitize, archivalCheck } from '../pdf/ops/optimize';
import { extractImage, rawToRgba, imageName, pageTextRuns, tablesFromRuns, toCsv, textToMarkdown, linesFromRuns } from '../pdf/ops/extract';
import { addWatermark, addBates } from '../pdf/ops/pages';
import { flattenAnnotations } from '../pdf/ops/annots';
import { flattenForm } from '../pdf/ops/forms';
import { openAsPdf } from '../io';
import { replaceWithBytes } from './file';
import { saveBytes, baseName, zipOf, pageOf, viewer, esc, docCopy, askPages, hexToRgb } from './util';
import { remember } from './nav';
import { openExternal } from '../platform/native';

/** Image bytes (JPEG as stored, else PNG through a canvas) for every image, for extraction. */
async function imageFiles(app: App, pages?: Set<number>): Promise<{ name: string; data: Uint8Array }[]> {
  const out: { name: string; data: Uint8Array }[] = [];
  const imgs = listImages(app.doc).filter((im) => !pages || pages.has(im.page));
  for (const [i, im] of imgs.entries()) {
    try {
      const ex = extractImage(app.doc, im);
      if (ex.kind === 'jpeg' || ex.kind === 'jp2') { out.push({ name: imageName(im, i), data: ex.data }); continue; }
      const rgba = rawToRgba(app.doc, ex);
      if (!rgba) continue;
      const c = document.createElement('canvas'); c.width = ex.width; c.height = ex.height;
      c.getContext('2d')!.putImageData(new ImageData(rgba as any, ex.width, ex.height), 0, 0);
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
      if (blob) out.push({ name: imageName(im, i), data: new Uint8Array(await blob.arrayBuffer()) });
    } catch (e) { console.warn('extract image', e); }
  }
  return out;
}

/** Downsamples every raster image larger than maxPx on its longest side to JPEG (in place). */
async function downsampleImages(app: App, doc: PdfDocument, maxPx: number, quality: number): Promise<number> {
  const { imageXObject, jpegInfo } = await import('../pdf/build');
  let n = 0;
  for (const im of listImages(doc)) {
    if (!im.ref || im.hasMask || Math.max(im.width, im.height) <= maxPx) continue;
    try {
      const ex = extractImage(doc, im);
      let bmp: ImageBitmap;
      if (ex.kind === 'jpeg') bmp = await createImageBitmap(new Blob([ex.data as BlobPart], { type: 'image/jpeg' }));
      else { const rgba = rawToRgba(doc, ex); if (!rgba) continue; bmp = await createImageBitmap(new ImageData(rgba as any, ex.width, ex.height)); }
      const s = maxPx / Math.max(bmp.width, bmp.height);
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
      const ctx = c.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(bmp, 0, 0, c.width, c.height);
      const jpeg = new Uint8Array(await (await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', quality)))!.arrayBuffer());
      const info = jpegInfo(jpeg); if (!info || jpeg.length >= im.bytes) continue;
      const nr = imageXObject(doc, { kind: 'jpeg', data: jpeg, width: info.width, height: info.height, gray: info.components === 1 });
      doc.update(im.ref, doc.resolve(nr)); doc.remove(nr); n++;
    } catch (e) { console.warn('downsample', e); }
  }
  void app;
  return n;
}

async function optimize(app: App, preset?: { images?: number; quality?: number; sanitize?: boolean }): Promise<void> {
  const before = app.tab.bytes.length;
  let r: any = preset ? { unused: true, recompress: true, objstm: true, images: preset.images ? 'yes' : 'no', maxPx: preset.images || 1500, q: preset.quality || 0.75, meta: !!preset.sanitize, thumbs: true } : null;
  if (!r) {
    r = await openDialog({ title: 'Optimize PDF', fields: [
      { key: 'i', type: 'info', html: `<p class="ql-help">Current size: ${(before / 1024).toFixed(0)} KB. The document is rewritten in memory; Save writes the result.</p>` },
      { key: 'unused', label: 'Drop unused objects and earlier versions', type: 'checkbox', value: true, half: true },
      { key: 'recompress', label: 'Recompress content streams', type: 'checkbox', value: true, half: true },
      { key: 'objstm', label: 'Pack objects into object streams', type: 'checkbox', value: true, half: true },
      { key: 'thumbs', label: 'Remove embedded page thumbnails', type: 'checkbox', value: true, half: true },
      { key: 'images', label: 'Downsample large images', type: 'select', options: [{ value: 'no', label: 'Keep images as they are' }, { value: 'yes', label: 'Downsample to a longest side of…' }], value: 'no', half: true },
      { key: 'maxPx', label: 'Pixels', type: 'number', min: 200, max: 8000, value: 1500, half: true, visibleIf: (v) => v.images === 'yes' },
      { key: 'q', label: 'JPEG quality', type: 'range', min: 0.3, max: 0.95, step: 0.05, value: 0.75, visibleIf: (v) => v.images === 'yes' },
      { key: 'meta', label: 'Remove metadata and private application data', type: 'checkbox', value: false },
    ], ok: 'Optimize' });
    if (!r) return;
  }
  app.ui.status?.('● Optimizing…');
  const copy = PdfDocument.load(app.tab.bytes, { password: app.tab.password || undefined });
  let imgs = 0;
  if (r.images === 'yes') imgs = await downsampleImages(app, copy, +r.maxPx || 1500, +r.q || 0.75);
  if (r.thumbs || r.meta) sanitize(copy, { thumbnails: !!r.thumbs, metadata: !!r.meta, privateData: !!r.meta });
  const bytes = copy.save({ incremental: false, recompress: !!r.recompress, objectStreams: !!r.objstm, keepUnused: !r.unused });
  app.ui.status?.('');
  replaceWithBytes(app, app.tab, bytes);
  app.tab.clearHistory();
  toast(`Optimized: ${(before / 1024).toFixed(0)} KB → ${(bytes.length / 1024).toFixed(0)} KB${imgs ? `, ${imgs} image(s) downsampled` : ''}. Save to keep it.`, { ms: 8000 });
}

/** Finds an outline item by its object reference in a tree. */
function findItem(items: OutlineItem[], ref: Ref | null): { list: OutlineItem[]; index: number } | null {
  if (!ref) return null;
  for (let i = 0; i < items.length; i++) { if (items[i].ref?.equals(ref)) return { list: items, index: i }; const r = findItem(items[i].children, ref); if (r) return r; }
  return null;
}

/** Heading candidates from font sizes: lines noticeably larger than the page's common size. */
export function headingsFromText(doc: PdfDocument): { title: string; page: number; y: number; level: number }[] {
  const out: { title: string; page: number; y: number; size: number }[] = [];
  const sizes: number[] = [];
  doc.pages.forEach((_, i) => { const runs = pageTextRuns(doc, i); for (const r of runs) if (r.text.trim()) sizes.push(Math.round(r.size)); });
  if (!sizes.length) return [];
  const counts = new Map<number, number>(); for (const s of sizes) counts.set(s, (counts.get(s) || 0) + 1);
  const body = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  doc.pages.forEach((_, i) => {
    const runs = pageTextRuns(doc, i).filter((r) => r.text.trim() && r.size >= body * 1.2 && r.text.trim().length > 2 && r.text.trim().length < 120);
    // Merge runs on the same line.
    const lines: { y: number; size: number; parts: { x: number; text: string }[] }[] = [];
    for (const r of runs) { const l = lines.find((x) => Math.abs(x.y - r.y) < r.size * 0.5); if (l) l.parts.push({ x: r.x, text: r.text }); else lines.push({ y: r.y, size: r.size, parts: [{ x: r.x, text: r.text }] }); }
    for (const l of lines) out.push({ title: l.parts.sort((a, b) => a.x - b.x).map((p) => p.text).join(' ').replace(/\s+/g, ' ').trim(), page: i, y: l.y + l.size, size: l.size });
  });
  const distinct = [...new Set(out.map((o) => Math.round(o.size)))].sort((a, b) => b - a);
  return out.map((o) => ({ title: o.title, page: o.page, y: o.y, level: Math.min(2, distinct.indexOf(Math.round(o.size))) }));
}

/** Word shingles for a document-similarity estimate. */
function shingles(text: string, k = 5): Set<string> {
  const w = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const s = new Set<string>();
  for (let i = 0; i + k <= w.length; i++) s.add(w.slice(i, i + k).join(' '));
  return s;
}

def([
  { id: 'tools.optimize', label: 'Optimize…', icon: 'tune', tab: 'Tools', group: 'Optimize', popular: true, tip: 'Rewrite the file smaller: drop unused objects, recompress, pack object streams, downsample images', run: (app) => optimize(app) },
  {
    id: 'tools.reduceSize', label: 'Reduce File Size', icon: 'compress', tab: 'Tools', group: 'Optimize', kind: 'menu',
    menu: () => [{ id: 'tools.reduceSize', arg: 'screen', label: 'Smallest (screen: images 1000 px, quality 0.6)' }, { id: 'tools.reduceSize', arg: 'ebook', label: 'E-book (images 1500 px, quality 0.75)' }, { id: 'tools.reduceSize', arg: 'print', label: 'Print (images 3000 px, quality 0.85)' }, { id: 'tools.reduceSize', arg: 'lossless', label: 'Lossless (structure only)' }],
    run: (app, preset?: string) => optimize(app, preset === 'screen' ? { images: 1000, quality: 0.6 } : preset === 'ebook' ? { images: 1500, quality: 0.75 } : preset === 'print' ? { images: 3000, quality: 0.85 } : {}),
  },
  {
    id: 'tools.compressImages', label: 'Compress Images…', icon: 'photo_size_select_small', tab: 'Tools', group: 'Optimize', tip: 'Downsample and re-encode the pictures in the document (page content stays as it is)',
    run: async (app) => {
      const imgs = listImages(app.doc);
      if (!imgs.length) { toast('The document has no images.'); return; }
      const r = await openDialog({ title: 'Compress Images', fields: [{ key: 'i', type: 'info', html: `<p class="ql-help">${imgs.length} image(s), ${(imgs.reduce((n, x) => n + x.bytes, 0) / 1024).toFixed(0)} KB. Largest: ${Math.max(...imgs.map((x) => Math.max(x.width, x.height)))} px.</p>` }, { key: 'maxPx', label: 'Longest side (px)', type: 'number', min: 200, max: 8000, value: 1500, half: true }, { key: 'q', label: 'JPEG quality', type: 'range', min: 0.3, max: 0.95, step: 0.05, value: 0.75, half: true }], ok: 'Compress' });
      if (!r) return;
      app.ui.status?.('● Compressing images…');
      const copy = PdfDocument.load(app.tab.bytes, { password: app.tab.password || undefined });
      const n = await downsampleImages(app, copy, +r.maxPx || 1500, +r.q || 0.75);
      app.ui.status?.('');
      if (!n) { toast('No image was larger than that.'); return; }
      const bytes = copy.save({ incremental: false, recompress: false, keepUnused: false });
      replaceWithBytes(app, app.tab, bytes); app.tab.clearHistory();
      toast(`${n} image(s) compressed; the file is now ${(bytes.length / 1024).toFixed(0)} KB. Save to keep it.`);
    },
  },
  { id: 'tools.rewrite', label: 'Rewrite File', icon: 'cleaning_services', tab: 'Tools', group: 'Optimize', tip: 'A clean full rewrite in memory (renumbered objects, no earlier versions); Save writes it', run: (app) => { const before = app.tab.bytes.length; const bytes = app.doc.save({ incremental: false }); replaceWithBytes(app, app.tab, bytes); app.tab.clearHistory(); toast(`Rewritten: ${(before / 1024).toFixed(0)} KB → ${(bytes.length / 1024).toFixed(0)} KB.`); } },
  {
    id: 'tools.extractText', label: 'Extract Text…', icon: 'notes', tab: 'Tools', group: 'Extract', edits: false, noRecord: true, tip: 'Plain text or Markdown of the chosen pages, from the document (engine) or the renderer',
    run: async (app) => {
      const r = await askPages(app, 'Extract Text', [{ key: 'fmt', label: 'Format', type: 'radio', options: [{ value: 'txt', label: 'Plain text' }, { value: 'md', label: 'Markdown (headings from font sizes)' }], value: 'txt' }, { key: 'layout', label: 'Keep the layout (lines by position, from the engine)', type: 'checkbox', value: false }], 'Extract');
      if (!r) return;
      let text: string;
      if (r.values.fmt === 'md') text = textToMarkdown(r.pages.map((i) => pageTextRuns(app.doc, i)));
      else if (r.values.layout) text = r.pages.map((i) => linesFromRuns(pageTextRuns(app.doc, i)).join('\n')).join('\n\n\f\n');
      else { const v = viewer(app); const parts: string[] = []; for (const i of r.pages) parts.push(await v.pageText(i)); text = parts.join('\n\n'); }
      await saveBytes(text, `${baseName(app)}.${r.values.fmt}`, r.values.fmt === 'md' ? 'text/markdown' : 'text/plain');
    },
  },
  {
    id: 'tools.extractImages', label: 'Extract Images', icon: 'photo_library', tab: 'Tools', group: 'Extract', edits: false, noRecord: true, tip: 'Every embedded picture as a file (JPEG as stored; others as PNG)',
    run: async (app) => {
      const r = await askPages(app, 'Extract Images', [], 'Extract');
      if (!r) return;
      app.ui.status?.('● Extracting images…');
      const files = await imageFiles(app, new Set(r.pages));
      app.ui.status?.('');
      if (!files.length) { toast('No extractable images on those pages (JBIG2 and CCITT images cannot be decoded yet).'); return; }
      if (files.length === 1) { await saveBytes(files[0].data, `${baseName(app)} ${files[0].name}`, files[0].name.endsWith('.jpg') ? 'image/jpeg' : 'image/png'); return; }
      await saveBytes(await zipOf(files), `${baseName(app)} images.zip`, 'application/zip');
    },
  },
  {
    id: 'tools.extractTables', label: 'Extract Tables', icon: 'table', tab: 'Tools', group: 'Extract', edits: false, noRecord: true, popular: true, tip: 'Tables detected from text positions, as CSV (one file per table, zipped when several)',
    run: async (app) => {
      const r = await askPages(app, 'Extract Tables', [], 'Extract');
      if (!r) return;
      const files: { name: string; data: string }[] = [];
      for (const i of r.pages) { const tables = tablesFromRuns(pageTextRuns(app.doc, i)); tables.forEach((t, k) => files.push({ name: `${baseName(app)} page ${i + 1} table ${k + 1}.csv`, data: toCsv(t) })); }
      if (!files.length) { toast('No tables were detected on those pages. Try AI ▸ Extract Table for free-form layouts.'); return; }
      if (files.length === 1) { await saveBytes(files[0].data, files[0].name, 'text/csv'); return; }
      await saveBytes(await zipOf(files), `${baseName(app)} tables.zip`, 'application/zip');
    },
  },
  {
    id: 'tools.extractAttachments', label: 'Extract Attachments', icon: 'attach_file', tab: 'Tools', group: 'Extract', edits: false, noRecord: true,
    run: async (app) => {
      const att = readAttachments(app.doc).filter((a) => a.stream);
      if (!att.length) { toast('The document has no attachments.'); return; }
      if (att.length === 1) { await saveBytes(app.doc.decoded(att[0].stream!), att[0].name, att[0].mime || 'application/octet-stream'); return; }
      await saveBytes(await zipOf(att.map((a) => ({ name: a.name, data: app.doc.decoded(a.stream!) }))), `${baseName(app)} attachments.zip`, 'application/zip');
    },
  },
  {
    id: 'tools.pageInfo', label: 'Page Info', icon: 'info', tab: 'Tools', group: 'Inspect', edits: false, noRecord: true,
    run: async (app) => {
      const p = pageOf(app, app.page);
      const res = p.resources;
      const names = (k: string) => { const d = res ? app.doc.getDict(res, k) : null; return d ? d.keys().join(', ') : '—'; };
      const box = (k: string) => { const b = app.doc.rect(p.dict.get(k)); return b ? b.map((v) => +v.toFixed(2)).join(' ') : '—'; };
      const rows: [string, string][] = [['Page', `${p.index + 1} of ${app.doc.pageCount}${p.ref ? ` (object ${p.ref.num})` : ''}`], ['Size', `${p.width.toFixed(2)} × ${p.height.toFixed(2)} pt (${(p.width / 72).toFixed(2)} × ${(p.height / 72).toFixed(2)} in, ${(p.width / 72 * 25.4).toFixed(0)} × ${(p.height / 72 * 25.4).toFixed(0)} mm)`], ['Rotation', `${p.rotate}°`], ['MediaBox', box('MediaBox')], ['CropBox', box('CropBox')], ['TrimBox', box('TrimBox')], ['BleedBox', box('BleedBox')], ['ArtBox', box('ArtBox')], ['Content', `${app.doc.pageContent(p).length} bytes`], ['Fonts', names('Font')], ['XObjects', names('XObject')], ['Annotations', String((app.doc.getArray(p.dict, 'Annots') || []).length)], ['Recognized text', p.dict.has('QuillFolioOCR') ? app.doc.getText(p.dict, 'QuillFolioOCR') : 'no']];
      await openDialog({ title: 'Page Info', ok: 'Close', cancel: false, content: h('table', { class: 'ql-table' }, rows.map((rw) => h('tr', null, h('th', { style: 'text-align:left;padding-right:12px;white-space:nowrap' }, rw[0]), h('td', null, rw[1])))) });
    },
  },
  {
    id: 'tools.similar', label: 'Similar Documents', icon: 'difference', tab: 'Tools', group: 'Inspect', edits: false, noRecord: true, tip: 'How much the open documents overlap in wording (shingle similarity)',
    run: async (app) => {
      if (app.docs.length < 2) { toast('Open two or more documents to compare them.'); return; }
      const sets: { name: string; s: Set<string> }[] = [];
      for (const d of app.docs) { const text = (await (d.ui as any).allText?.(300))?.join('\n') || ''; sets.push({ name: d.displayName, s: shingles(text) }); }
      const rows: string[] = [];
      for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) { const a = sets[i].s, b = sets[j].s; let inter = 0; for (const x of a) if (b.has(x)) inter++; const union = a.size + b.size - inter; rows.push(`${sets[i].name} ↔ ${sets[j].name}: ${union ? ((100 * inter) / union).toFixed(1) : '0'}% shared phrases`); }
      await openDialog({ title: 'Similar Documents', ok: 'Close', cancel: false, content: h('ul', null, rows.map((r) => h('li', null, r))) });
    },
  },
  {
    id: 'tools.addBookmark', label: 'Add Bookmark', icon: 'bookmark_add', tab: 'Tools', group: 'Bookmarks', keys: ['Mod-Shift-d'], popular: true, tip: 'A bookmark to the current page (titled with the selected text, if any)',
    run: async (app) => {
      const title = await promptDialog('Add Bookmark', 'Title', (app.tab.ui.selectedText || '').trim().slice(0, 80) || `Page ${app.page + 1}`);
      if (!title) return;
      const page = app.page;
      app.edit('Add Bookmark', (doc) => { const items = outlinesToInput(readOutlines(doc)); items.push({ title, page }); writeOutlines(doc, items); });
      if (!app.ui.paneOpen('bookmarks')) app.ui.openPane('bookmarks');
    },
  },
  {
    id: 'tools.editBookmark', label: 'Edit Bookmark…', icon: 'edit', tab: 'Tools', group: 'Bookmarks',
    run: async (app, it?: OutlineItem) => {
      const items = readOutlines(app.doc);
      let target = it;
      if (!target) { const flat: OutlineItem[] = []; const walk = (l: OutlineItem[]) => { for (const x of l) { flat.push(x); walk(x.children); } }; walk(items); if (!flat.length) { toast('No bookmarks.'); return; } const r = await openDialog({ title: 'Edit Bookmark', fields: [{ key: 'b', label: 'Bookmark', type: 'select', options: flat.map((x, i) => ({ value: String(i), label: x.title })), value: '0' }] }); if (!r) return; target = flat[+r.b]; }
      const r = await openDialog({ title: 'Edit Bookmark', fields: [{ key: 'title', label: 'Title', type: 'text', value: target.title }, { key: 'page', label: 'Page', type: 'number', min: 1, max: app.doc.pageCount, value: (target.dest?.page ?? app.page) + 1, half: true }, { key: 'url', label: 'Or a web address', type: 'text', value: target.url || '', half: true }, { key: 'open', label: 'Expanded', type: 'checkbox', value: target.open }] });
      if (!r) return;
      app.edit('Edit Bookmark', (doc) => {
        const tree = readOutlines(doc);
        const found = findItem(tree, target!.ref);
        if (!found) return;
        const x = found.list[found.index];
        x.title = r.title; x.open = !!r.open;
        if (r.url) { x.url = r.url; x.dest = null; } else { x.url = undefined; x.dest = { page: (+r.page || 1) - 1, kind: 'XYZ' }; }
        writeOutlines(doc, outlinesToInput(tree));
      });
    },
  },
  {
    id: 'tools.deleteBookmark', label: 'Delete Bookmark', icon: 'bookmark_remove', tab: 'Tools', group: 'Bookmarks',
    run: async (app, it?: OutlineItem) => {
      if (!it) { app.exec('tools.editBookmark'); return; }
      app.edit('Delete Bookmark', (doc) => { const tree = readOutlines(doc); const f = findItem(tree, it.ref); if (!f) return; f.list.splice(f.index, 1); writeOutlines(doc, outlinesToInput(tree)); });
    },
  },
  {
    id: 'tools.bookmarksFromHeadings', label: 'Bookmarks from Headings', icon: 'auto_fix_high', tab: 'Tools', group: 'Bookmarks', tip: 'Make bookmarks from the lines set in larger type than the body text',
    run: async (app) => {
      const heads = headingsFromText(app.doc);
      if (!heads.length) { toast('No headings were detected (the text is all one size, or the pages are images).'); return; }
      const r = await openDialog({ title: 'Bookmarks from Headings', fields: [{ key: 'h', label: `${heads.length} heading(s) found; keep`, type: 'list', multiple: true, rows: 12, options: heads.map((x, i) => ({ value: String(i), label: `${'   '.repeat(x.level)}${x.title} (p. ${x.page + 1})` })), value: heads.map((_, i) => String(i)) }, { key: 'replace', label: 'Replace the existing bookmarks', type: 'checkbox', value: !readOutlines(app.doc).length }], ok: 'Add' });
      if (!r?.h?.length) return;
      const keep = (r.h as string[]).map((i) => heads[+i]);
      app.edit('Bookmarks from Headings', (doc) => {
        const items: OutlineInput[] = r.replace ? [] : outlinesToInput(readOutlines(doc));
        const stack: OutlineInput[][] = [items];
        for (const hd of keep) { const lvl = Math.min(hd.level, stack.length - 1); stack.length = lvl + 1; const node: OutlineInput = { title: hd.title, page: hd.page, y: hd.y, children: [] }; stack[lvl].push(node); stack.push(node.children!); }
        writeOutlines(doc, items);
      });
      if (!app.ui.paneOpen('bookmarks')) app.ui.openPane('bookmarks');
    },
  },
  { id: 'tools.deleteBookmarks', label: 'Delete All Bookmarks', icon: 'bookmarks', tab: 'Tools', group: 'Bookmarks', run: async (app) => { if (!readOutlines(app.doc).length) { toast('There are no bookmarks.'); return; } if (await confirmDialog('Delete Bookmarks', 'Remove every bookmark?', 'Delete')) app.edit('Delete Bookmarks', (doc) => writeOutlines(doc, [])); } },
  {
    id: 'tools.addAttachment', label: 'Attach File…', icon: 'attach_file', tab: 'Tools', group: 'Attachments', tip: 'Embed a file in the document (document level; Comment ▸ Attach File pins one to a page)',
    run: async (app) => {
      const files = await pickFile('*/*', true);
      if (!files.length) return;
      const data = await Promise.all(files.map(async (f) => ({ name: f.name, mime: f.type || 'application/octet-stream', bytes: new Uint8Array(await f.arrayBuffer()) })));
      app.edit('Attach File', (doc) => { for (const d of data) addAttachment(doc, d.name, d.bytes, { mime: d.mime }); });
      if (!app.ui.paneOpen('attachments')) app.ui.openPane('attachments');
    },
  },
  {
    id: 'tools.openAttachment', label: 'Open Attachment', icon: 'open_in_new', tab: 'Tools', group: 'Attachments', edits: false, noRecord: true, tip: 'Open an attached PDF in a new tab, or save other files',
    run: async (app, a?: Attachment) => {
      const att = a || (await pickAttachment(app));
      if (!att?.stream) return;
      const data = app.doc.decoded(att.stream);
      if (/\.pdf$/i.test(att.name) || /pdf/i.test(att.mime)) { try { const res = await openAsPdf(data, att.name); const t = app.createTab(res.doc, { title: att.name.replace(/\.pdf$/i, ''), fileName: att.name }, res.bytes); t.dirty = false; return; } catch (e: any) { toast(`Could not open ${att.name}: ${e?.message || e}`); } }
      if (/^(image|text)\//.test(att.mime) || /\.(png|jpe?g|gif|webp|txt|md|html?)$/i.test(att.name)) { const url = URL.createObjectURL(new Blob([data as BlobPart], { type: att.mime })); openExternal(url); return; }
      await saveBytes(data, att.name, att.mime || 'application/octet-stream');
    },
  },
  { id: 'tools.saveAttachment', label: 'Save Attachment', icon: 'download', tab: 'Tools', group: 'Attachments', edits: false, noRecord: true, run: async (app, a?: Attachment) => { const att = a || (await pickAttachment(app)); if (att?.stream) await saveBytes(app.doc.decoded(att.stream), att.name, att.mime || 'application/octet-stream'); } },
  { id: 'tools.removeAttachment', label: 'Remove Attachment', icon: 'delete', tab: 'Tools', group: 'Attachments', run: async (app, a?: Attachment) => { const att = a || (await pickAttachment(app)); if (!att) return; if (await confirmDialog('Remove Attachment', `Remove ${att.name}?`, 'Remove')) app.edit('Remove Attachment', (doc) => removeAttachment(doc, readAttachments(doc).find((x) => x.name === att.name && x.where === att.where)!)); } },
  {
    id: 'tools.batch', label: 'Batch Process…', icon: 'dynamic_feed', tab: 'Tools', group: 'Batch', noRecord: true, edits: false, popular: true,
    tip: 'Run one operation over several files picked at once; the results come back as a ZIP',
    run: async (app) => {
      const files = await pickFile('.pdf,image/*', true);
      if (!files.length) return;
      const r = await openDialog({ title: `Batch: ${files.length} file(s)`, fields: [
        { key: 'op', label: 'Operation', type: 'select', options: [{ value: 'optimize', label: 'Optimize (rewrite, recompress, object streams)' }, { value: 'flatten', label: 'Flatten comments and forms' }, { value: 'watermark', label: 'Add a watermark' }, { value: 'bates', label: 'Bates numbering across all files' }, { value: 'encrypt', label: 'Encrypt (AES-256)' }, { value: 'sanitize', label: 'Remove metadata, scripts and attachments' }, { value: 'text', label: 'Extract text (.txt per file)' }, { value: 'merge', label: 'Merge into one PDF' }], value: 'optimize' },
        { key: 'text', label: 'Watermark text', type: 'text', value: 'DRAFT', visibleIf: (v) => v.op === 'watermark' },
        { key: 'prefix', label: 'Bates prefix', type: 'text', value: 'DOC', visibleIf: (v) => v.op === 'bates', half: true }, { key: 'start', label: 'Start at', type: 'number', value: 1, visibleIf: (v) => v.op === 'bates', half: true },
        { key: 'pw', label: 'Open password', type: 'password', visibleIf: (v) => v.op === 'encrypt', half: true }, { key: 'opw', label: 'Permissions password', type: 'password', visibleIf: (v) => v.op === 'encrypt', half: true },
      ], ok: 'Run' });
      if (!r) return;
      const out: { name: string; data: Uint8Array | string }[] = [];
      const log: string[] = [];
      let bates = +r.start || 1;
      const merged = r.op === 'merge' ? PdfDocument.create() : null;
      for (const f of files) {
        try {
          app.ui.status?.(`● ${f.name}…`);
          const res = await openAsPdf(new Uint8Array(await f.arrayBuffer()), f.name);
          const d = res.doc; const base = f.name.replace(/\.[^.]+$/, '');
          const all = d.pages.map((_, i) => i);
          if (r.op === 'text') { const { pageText } = await import('../pdf/ops/extract'); out.push({ name: `${base}.txt`, data: all.map((i) => pageText(d, i)).join('\n\n') }); }
          else if (r.op === 'merge') { const { importPages } = await import('../pdf/ops/pages'); importPages(d, merged!, all, undefined, { keepAnnots: true }); }
          else {
            if (r.op === 'flatten') { flattenForm(d); for (const p of d.pages) flattenAnnotations(d, p); }
            if (r.op === 'watermark') addWatermark(d, all, r.text || 'DRAFT', { size: 72, opacity: 0.2, color: [0.8, 0.1, 0.1], rotate: 45 });
            if (r.op === 'bates') { addBates(d, all, { prefix: r.prefix, start: bates, digits: 6, position: 'bottom-right' }); bates += all.length; }
            if (r.op === 'sanitize') sanitize(d, { metadata: true, javascript: true, attachments: true, privateData: true, thumbnails: true });
            const bytes = r.op === 'encrypt' ? d.save({ incremental: false, encrypt: { userPassword: String(r.pw || ''), ownerPassword: String(r.opw || r.pw || 'owner'), permissions: {} } }) : d.save({ incremental: false, recompress: r.op === 'optimize', objectStreams: r.op === 'optimize' });
            out.push({ name: `${base}.pdf`, data: bytes });
          }
          log.push(`${f.name}: ok${res.repair ? ' (repaired)' : ''}`);
        } catch (e: any) { log.push(`${f.name}: ${e?.message || e}`); }
      }
      app.ui.status?.('');
      if (merged) { const bytes = merged.save({ incremental: false }); const t = app.createTab(PdfDocument.load(bytes), { title: 'Merged', fileName: 'Merged.pdf' }, bytes); t.dirty = true; toast(`${files.length} file(s) merged.`); return; }
      out.push({ name: 'batch-log.txt', data: log.join('\n') });
      await saveBytes(await zipOf(out), `batch ${r.op}.zip`, 'application/zip');
    },
  },
  {
    id: 'tools.toArchival', label: 'Prepare for Archiving', icon: 'inventory', tab: 'Tools', group: 'Convert', tip: 'Apply what QuillFolio can toward an archival PDF: remove encryption and scripts, write XMP with a title and language (no font embedding or color profiles yet)',
    run: async (app) => {
      const issues = archivalCheck(app.doc);
      const m = readMetadata(app.doc);
      const r = await openDialog({ title: 'Prepare for Archiving', fields: [{ key: 'i', type: 'info', html: `<p class="ql-help">${issues.length} finding(s) from the archival check. This step cannot embed fonts or add color profiles, so the result is "archival-ready" rather than conforming PDF/A.</p>` }, { key: 'title', label: 'Title', type: 'text', value: m.title || app.tab.title }, { key: 'lang', label: 'Language', type: 'text', value: m.language || 'en-US' }, { key: 'strip', label: 'Remove scripts, layers and transparency-related extended graphics states where possible', type: 'checkbox', value: true }], ok: 'Prepare' });
      if (!r) return;
      if (app.doc.security) { toast('Remove the security first (Protect ▸ Remove Security).'); return; }
      app.edit('Prepare for Archiving', (doc) => { writeMetadata(doc, { title: r.title, language: r.lang }); if (r.strip) sanitize(doc, { javascript: true, hiddenLayers: true }); const vp = doc.getDict(doc.catalog, 'ViewerPreferences') || new Dict(); vp.set('DisplayDocTitle', true); doc.catalog.set('ViewerPreferences', vp); doc.update(doc.catalogRef, doc.catalog); });
      app.exec('review.archivalCheck');
    },
  },
  {
    id: 'tools.editXmp', label: 'Edit XMP Metadata…', icon: 'data_object', tab: 'Tools', group: 'Convert', tip: 'The XMP packet as XML',
    run: async (app) => {
      const m = readMetadata(app.doc);
      const r = await openDialog({ title: 'XMP Metadata', wide: true, fields: [{ key: 'x', label: 'XMP packet (XML)', type: 'textarea', rows: 18, value: m.xmp || '' }], ok: 'Save', buttons: [{ label: 'Generate from Properties', onClick: (_v, ctl) => { ctl.close(null); app.edit('Write XMP', (doc) => writeMetadata(doc, {})); } }] });
      if (!r) return;
      const xml = String(r.x);
      if (xml.trim() && !/<x:xmpmeta|<rdf:RDF/.test(xml)) { toast('That does not look like an XMP packet (no x:xmpmeta or rdf:RDF element).'); return; }
      app.edit('XMP Metadata', (doc) => {
        if (!xml.trim()) { doc.catalog.delete('Metadata'); doc.update(doc.catalogRef, doc.catalog); return; }
        const s = new PdfStream(new Dict({ Type: Name.get('Metadata'), Subtype: Name.get('XML') }), new TextEncoder().encode(xml));
        s.dict.set('Length', s.raw.length);
        const old = doc.catalog.get('Metadata');
        if (old instanceof Ref) doc.update(old, s); else { doc.catalog.set('Metadata', doc.register(s)); doc.update(doc.catalogRef, doc.catalog); }
      });
    },
  },
  {
    id: 'tools.goToBookmark', label: 'Go to Bookmark', icon: 'bookmark', tab: 'Tools', group: 'Bookmarks', kind: 'menu', edits: false, noRecord: true,
    menu: (app) => { const flat: { title: string; page: number }[] = []; const walk = (l: OutlineItem[], d: number) => { for (const x of l) { if (x.dest) flat.push({ title: `${'  '.repeat(d)}${x.title}`, page: x.dest.page }); walk(x.children, d + 1); } }; walk(readOutlines(app.doc), 0); return flat.length ? flat.slice(0, 40).map((f) => ({ id: 'tools.goToBookmark', arg: f.page, label: f.title })) : [{ label: '(no bookmarks)' }]; },
    run: (app, page?: number) => { if (page == null) { app.ui.openPane('bookmarks'); return; } remember(app); app.tab.ui.goToPage(page); },
  },
  { id: 'tools.fontsReport', label: 'Fonts Report (Text)', icon: 'font_download', tab: 'Tools', group: 'Inspect', edits: false, noRecord: true, run: async (app) => { const f = listFonts(app.doc); await saveBytes(f.map((x) => `${x.name}\t${x.subtype}\t${x.encoding}\t${x.embedded ? 'embedded' : 'not embedded'}\tpages ${x.pages.map((p) => p + 1).join(',')}`).join('\n'), `${baseName(app)} fonts.tsv`, 'text/tab-separated-values'); } },
]);

async function pickAttachment(app: App): Promise<Attachment | null> {
  const att = readAttachments(app.doc);
  if (!att.length) { toast('The document has no attachments.'); return null; }
  const r = await openDialog({ title: 'Attachment', fields: [{ key: 'a', label: 'File', type: 'select', options: att.map((a, i) => ({ value: String(i), label: `${a.name} (${(a.size / 1024).toFixed(1)} KB)` })), value: '0' }] });
  return r ? att[+r.a] : null;
}

export { esc, docCopy, PdfString, hexToRgb };
