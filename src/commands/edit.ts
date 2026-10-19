/** Edit tab: undo/redo, clipboard, find, page content editing (text runs and images). */
import { def } from './registry';
import type { App } from '../app';
import { openDialog, toast, confirmDialog } from '../ui/dialog';
import { pickFile } from '../ui/dom';
import { writeClipboardText, readClipboardText } from '../platform/native';
import { pageRuns, replaceRunText, eraseArea, insertText, insertImage, moveImage, deleteImage } from '../pdf/ops/textedit';
import { analyzeContent, parseContent } from '../pdf/content';
import { pageAnnotations, removeAnnotation } from '../pdf/structure';
import { viewer, pageOf, selectedText, saveBytes, baseName, imageRefFromFile, fitBox, FONT_OPTIONS, hexToRgb, askPages, type Rect } from './util';

const hasSel = (app: App) => !!selectedText(app);
const imageSel = (app: App) => app.tab?.selection?.kind === 'image';
const runSel = (app: App) => app.tab?.selection?.kind === 'run';

/** Finds the text run or image under a point on a page. */
export function contentAt(app: App, page: number, x: number, y: number): { kind: 'run' | 'image'; index: number; box: Rect; text?: string; editable?: boolean; name?: string } | null {
  const p = pageOf(app, page);
  const runs = pageRuns(app.doc, p);
  const hitRun = [...runs].reverse().find((r) => x >= r.box[0] - 1 && x <= r.box[2] + 1 && y >= r.box[1] - 1 && y <= r.box[3] + 1);
  if (hitRun) return { kind: 'run', index: hitRun.opIndex, box: hitRun.box, text: hitRun.text, editable: hitRun.editable };
  const info = analyzeContent(app.doc, parseContent(app.doc.pageContent(p)), p.resources);
  const im = [...info.images].reverse().find((i) => x >= i.box[0] && x <= i.box[2] && y >= i.box[1] && y <= i.box[3]);
  if (im) return { kind: 'image', index: im.opIndex, box: im.box, name: im.name };
  return null;
}

async function editRun(app: App, page: number, index: number): Promise<void> {
  const p = pageOf(app, page);
  const run = pageRuns(app.doc, p).find((r) => r.opIndex === index);
  if (!run) { toast('That text is no longer there.'); return; }
  const r = await openDialog({ title: 'Edit Text', fields: [
    { key: 't', label: 'Text', type: 'textarea', rows: 3, value: run.text, autofocus: true },
    { key: 'i', type: 'info', html: `<p class="ql-help">Font ${run.font}, ${run.size.toFixed(1)} pt. ${run.editable ? 'The text is re-encoded in the same font.' : 'This font cannot encode new text: the old text is covered and the new text is drawn in Helvetica.'}</p>` },
  ], ok: 'Replace' });
  if (!r || r.t === run.text) return;
  const res = app.edit('Edit Text', (doc) => replaceRunText(doc, p, run, String(r.t)));
  if (res) toast(res.mode === 'reencoded' ? 'Text replaced.' : 'Text replaced with an overlay (the original font could not encode it).');
  app.tab.selection = null;
}

export async function pickAt(app: App, arg: { page: number; x: number; y: number }): Promise<void> {
  const hit = contentAt(app, arg.page, arg.x, arg.y);
  if (!hit) { app.tab.selection = null; viewer(app).refreshAnnotations(); app.refresh(); return; }
  app.tab.selection = { kind: hit.kind, page: arg.page, index: hit.index, box: hit.box, text: hit.text };
  app.refresh();
  if (hit.kind === 'run') await editRun(app, arg.page, hit.index);
  else toast('Image selected: Edit ▸ Move/Resize, Delete or Extract Image.', { ms: 3000 });
}

export async function addTextAt(app: App, page: number, x: number, y: number, rect?: Rect): Promise<void> {
  const r = await openDialog({ title: 'Add Text', fields: [
    { key: 't', label: 'Text', type: 'textarea', rows: 4, autofocus: true },
    { key: 'font', label: 'Font', type: 'select', options: FONT_OPTIONS, value: 'Helvetica', half: true },
    { key: 'size', label: 'Size (pt)', type: 'number', min: 4, max: 144, value: 12, half: true },
    { key: 'color', label: 'Color', type: 'color', value: '#000000', half: true },
  ], ok: 'Add' });
  if (!r || !String(r.t).trim()) return;
  const p = pageOf(app, page);
  const top = rect && rect[3] - rect[1] > 4 ? rect[3] : y;
  const left = rect && rect[2] - rect[0] > 4 ? rect[0] : x;
  app.edit('Add Text', (doc) => insertText(doc, p, left, top - (+r.size || 12), String(r.t), { font: r.font, size: +r.size || 12, color: hexToRgb(r.color), maxWidth: rect ? rect[2] - rect[0] : undefined }));
}

export async function placeImage(app: App, page: number, rect: Rect, opts: { ref: any; width: number; height: number }): Promise<void> {
  const p = pageOf(app, page);
  let box: { x: number; y: number; w: number; h: number };
  if (rect[2] - rect[0] > 8 && rect[3] - rect[1] > 8) box = fitBox(opts.width, opts.height, rect);
  else { const w = Math.min(opts.width * 0.75, (p.cropBox[2] - p.cropBox[0]) * 0.6); const hh = w * opts.height / opts.width; box = { x: rect[0], y: rect[3] - hh, w, h: hh }; }
  app.edit('Add Image', (doc) => insertImage(doc, p, opts.ref, box));
  app.tab.ui.setTool('select');
}

def([
  { id: 'edit.undo', label: 'Undo', icon: 'undo', tab: 'Home', group: 'Undo', keys: ['Mod-z'], popular: true, noRecord: true, edits: false, isEnabled: (app) => !!app.tab?.canUndo, tip: 'Undo the last change to the document', run: (app) => { if (!app.tab.undo()) toast('Nothing to undo'); } },
  { id: 'edit.redo', label: 'Redo', icon: 'redo', tab: 'Home', group: 'Undo', keys: ['Mod-y', 'Mod-Shift-z'], popular: true, noRecord: true, edits: false, isEnabled: (app) => !!app.tab?.canRedo, run: (app) => { if (!app.tab.redo()) toast('Nothing to redo'); } },
  {
    id: 'edit.copy', label: 'Copy', icon: 'content_copy', tab: 'Home', group: 'Clipboard', keys: ['Mod-c', 'Mod-Insert'], popular: true, noRecord: true, edits: false,
    tip: 'Copy the selected text (or the selected image)',
    run: async (app) => {
      const t = selectedText(app);
      if (t) { app.clip = { text: t }; if (await writeClipboardText(t)) toast('Copied'); return; }
      if (imageSel(app)) return app.exec('edit.copyImage');
      toast('Select some text first.');
    },
  },
  {
    id: 'edit.copyImage', label: 'Copy as Picture', icon: 'image', tab: 'Home', group: 'Clipboard', noRecord: true, edits: false,
    tip: 'Copy the selected image, or a picture of the selected text area',
    run: async (app) => {
      const v = viewer(app);
      let page = app.page, rect: Rect | null = null;
      const s = app.tab.selection;
      if (s?.kind === 'image') { page = s.page; rect = s.box; }
      else { const sr = v.selectionRects; if (sr) { page = sr.page; const xs = sr.rects.flatMap((r) => [r[0], r[2]]), ys = sr.rects.flatMap((r) => [r[1], r[3]]); rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; } }
      if (!rect) { toast('Select text or an image first (Edit ▸ Select Image).'); return; }
      const blob = await v.renderRegion(page, rect, 200);
      app.clip = { image: { data: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png', width: 0, height: 0 } };
      try { await (navigator.clipboard as any).write?.([new (window as any).ClipboardItem({ 'image/png': blob })]); toast('Picture copied'); } catch { toast('Picture kept for Edit ▸ Paste (the system clipboard does not accept images here).'); }
    },
  },
  {
    id: 'edit.copyAsMarkdown', label: 'Copy as Markdown', icon: 'markdown', tab: 'Home', group: 'Clipboard', noRecord: true, edits: false, isEnabled: hasSel,
    tip: 'Copy the selected text with blank lines between paragraphs and headings guessed from the layout',
    run: async (app) => { const t = selectedText(app).replace(/\r?\n(?=\S)/g, ' ').replace(/ {2,}/g, ' ').replace(/\n\s*\n/g, '\n\n'); app.clip = { text: t }; if (await writeClipboardText(t)) toast('Copied as Markdown'); },
  },
  {
    id: 'edit.paste', label: 'Paste', icon: 'content_paste', tab: 'Home', group: 'Clipboard', keys: ['Mod-v', 'Shift-Insert'], popular: true, noRecord: true,
    tip: 'Paste a picture or text onto the current page',
    run: async (app) => {
      let image: Blob | null = null;
      try { const items = await (navigator.clipboard as any).read?.(); for (const it of items || []) { const t = it.types.find((x: string) => x.startsWith('image/')); if (t) { image = await it.getType(t); break; } } } catch { /* */ }
      if (!image && app.clip?.image) image = new Blob([app.clip.image.data as BlobPart], { type: app.clip.image.mime });
      const p = pageOf(app, app.page);
      if (image) {
        const im = await imageRefFromFile(app, image);
        const cw = p.cropBox[2] - p.cropBox[0], chh = p.cropBox[3] - p.cropBox[1];
        const box = fitBox(im.width, im.height, [p.cropBox[0] + cw * 0.2, p.cropBox[1] + chh * 0.2, p.cropBox[2] - cw * 0.2, p.cropBox[3] - chh * 0.2]);
        app.edit('Paste Picture', (doc) => insertImage(doc, p, im.ref, box));
        return;
      }
      const text = (await readClipboardText()) || app.clip?.text || '';
      if (!text) { toast('The clipboard has nothing QuillFolio can paste.'); return; }
      await addTextAt(app, app.page, p.cropBox[0] + 72, p.cropBox[3] - 72);
    },
  },
  {
    id: 'edit.selectAll', label: 'Select All', icon: 'select_all', tab: 'Home', group: 'Clipboard', keys: ['Mod-a'], noRecord: true, edits: false,
    tip: 'Select all the text on the current page (in Organize view: all pages)',
    run: (app) => {
      const v = viewer(app);
      if (v.gridMode) { v.selectAllPages(); return; }
      const layer = v.el.querySelector<HTMLElement>(`.qf-page[data-i="${app.page}"] .textLayer`);
      if (!layer) return;
      const range = document.createRange(); range.selectNodeContents(layer);
      const sel = document.getSelection(); sel?.removeAllRanges(); sel?.addRange(range);
      app.refresh();
    },
  },
  {
    id: 'edit.find', label: 'Find', icon: 'search', tab: 'Home', group: 'Find', keys: ['Mod-f', 'F3'], popular: true, noRecord: true, edits: false,
    tip: 'Find text on every page',
    run: (app) => { app.ui.openPane('search', { q: selectedText(app).slice(0, 80) }); },
  },
  { id: 'edit.findNext', label: 'Find Next', icon: 'arrow_downward', tab: 'Home', group: 'Find', keys: ['Mod-ArrowDown'], noRecord: true, edits: false, run: (app) => { if (!app.viewer.searchHits.length) app.exec('edit.find'); else app.tab.ui.findNext(1); } },
  { id: 'edit.findPrev', label: 'Find Previous', icon: 'arrow_upward', tab: 'Home', group: 'Find', keys: ['Mod-ArrowUp'], noRecord: true, edits: false, run: (app) => { if (!app.viewer.searchHits.length) app.exec('edit.find'); else app.tab.ui.findNext(-1); } },
  {
    id: 'edit.editText', label: 'Edit Text', icon: 'edit_note', tab: 'Edit', group: 'Text', kind: 'toggle', noRecord: true,
    tip: 'Click a line of text to change it. Simple fonts are re-encoded in place; text in other fonts is covered and redrawn in Helvetica.',
    isActive: (app) => app.tab?.ui?.tool === 'edit',
    run: (app) => { app.tab.ui.setTool('edit'); toast('Click text to edit it, or an image to select it.', { ms: 2500 }); },
  },
  { id: 'edit.pickAt', label: 'Pick Content', icon: 'ads_click', tab: 'Edit', group: 'Text', internal: true, noRecord: true, edits: false, run: (app, arg) => pickAt(app, arg) },
  { id: 'edit.addText', label: 'Add Text', icon: 'text_fields', tab: 'Edit', group: 'Text', kind: 'toggle', noRecord: true, tip: 'Click or drag where new text goes (drawn into the page, not a comment)', isActive: (app) => app.tab?.ui?.tool === 'text', run: (app) => app.tab.ui.setTool('text') },
  { id: 'edit.eraseArea', label: 'Erase Area', icon: 'ink_eraser', tab: 'Edit', group: 'Text', kind: 'toggle', noRecord: true, tip: 'Drag over page content to remove it (text and images inside the area are deleted and the area painted white)', isActive: (app) => app.tab?.ui?.tool === 'erase', run: (app) => app.tab.ui.setTool('erase') },
  {
    id: 'edit.addImage', label: 'Add Image', icon: 'add_photo_alternate', tab: 'Edit', group: 'Images', noRecord: true,
    tip: 'Pick a picture, then click or drag where it goes',
    run: async (app) => {
      const [f] = await pickFile('image/*');
      if (!f) return;
      const im = await imageRefFromFile(app, f);
      app.tab.ui.setTool('image', im);
      toast('Click or drag on the page to place the picture.', { ms: 3000 });
    },
  },
  { id: 'edit.selectImage', label: 'Select Image', icon: 'highlight_alt', tab: 'Edit', group: 'Images', kind: 'toggle', noRecord: true, edits: false, tip: 'Click a picture on the page to select it', isActive: (app) => app.tab?.ui?.tool === 'edit', run: (app) => { app.tab.ui.setTool('edit'); toast('Click a picture to select it.', { ms: 2500 }); } },
  {
    id: 'edit.moveImage', label: 'Move / Resize Image', icon: 'open_with', tab: 'Edit', group: 'Images', isEnabled: imageSel,
    run: async (app) => {
      const s = app.tab.selection!;
      const b = s.box;
      const r = await openDialog({ title: 'Move / Resize Image', fields: [
        { key: 'x', label: 'Left (pt)', type: 'number', value: +b[0].toFixed(1), half: true }, { key: 'y', label: 'Bottom (pt)', type: 'number', value: +b[1].toFixed(1), half: true },
        { key: 'w', label: 'Width (pt)', type: 'number', value: +(b[2] - b[0]).toFixed(1), half: true }, { key: 'h', label: 'Height (pt)', type: 'number', value: +(b[3] - b[1]).toFixed(1), half: true },
        { key: 'keep', label: 'Keep proportions when the width changes', type: 'checkbox', value: true },
      ], onChange: (v, ctl, k) => { if (k === 'w' && v.keep) ctl.set('h', +(+v.w * (b[3] - b[1]) / (b[2] - b[0])).toFixed(1)); } });
      if (!r) return;
      const p = pageOf(app, s.page);
      const box = { x: +r.x, y: +r.y, w: Math.max(1, +r.w), h: Math.max(1, +r.h) };
      const ok = app.edit('Move Image', (doc) => moveImage(doc, p, s.index, box));
      if (ok) app.tab.selection = { ...s, box: [box.x, box.y, box.x + box.w, box.y + box.h] };
    },
  },
  { id: 'edit.deleteImage', label: 'Delete Image', icon: 'hide_image', tab: 'Edit', group: 'Images', isEnabled: imageSel, run: (app) => { const s = app.tab.selection!; const p = pageOf(app, s.page); if (app.edit('Delete Image', (doc) => deleteImage(doc, p, s.index))) app.tab.selection = null; } },
  {
    id: 'edit.extractImage', label: 'Extract Image', icon: 'download', tab: 'Edit', group: 'Images', edits: false, isEnabled: imageSel,
    tip: 'Save the selected picture as a file (JPEG as embedded, others as PNG)',
    run: async (app) => {
      const s = app.tab.selection!;
      const p = pageOf(app, s.page);
      const info = analyzeContent(app.doc, parseContent(app.doc.pageContent(p)), p.resources).images.find((i) => i.opIndex === s.index);
      if (!info || info.inline) { toast('Inline images cannot be extracted; use Copy as Picture.'); return; }
      const { listImages } = await import('../pdf/ops/optimize');
      const im = listImages(app.doc).find((i) => i.page === s.page && i.name === info.name);
      if (!im) { toast('The image could not be found in the page resources.'); return; }
      const { extractImage, rawToRgba, imageName } = await import('../pdf/ops/extract');
      const ex = extractImage(app.doc, im);
      if (ex.kind === 'jpeg' || ex.kind === 'jp2') { await saveBytes(ex.data, `${baseName(app)} ${imageName(im, 0)}`, ex.kind === 'jpeg' ? 'image/jpeg' : 'image/jp2'); return; }
      const rgba = rawToRgba(app.doc, ex);
      if (!rgba) { toast('This image uses a compression QuillFolio cannot decode (JBIG2 or CCITT); use Copy as Picture for a rendered copy.'); return; }
      const c = document.createElement('canvas'); c.width = ex.width; c.height = ex.height;
      c.getContext('2d')!.putImageData(new ImageData(rgba as any, ex.width, ex.height), 0, 0);
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
      if (blob) await saveBytes(new Uint8Array(await blob.arrayBuffer()), `${baseName(app)} ${imageName(im, 0)}`, 'image/png');
    },
  },
  {
    id: 'edit.removeLinks', label: 'Remove Links', icon: 'link_off', tab: 'Edit', group: 'Links', tip: 'Delete the link annotations on the chosen pages',
    run: async (app) => {
      const r = await askPages(app, 'Remove Links', [], 'Remove');
      if (!r) return;
      const n = app.edit('Remove Links', (doc) => { let k = 0; for (const i of r.pages) { const p = doc.pages[i]; for (const a of pageAnnotations(doc, p)) if (a.subtype === 'Link' && a.ref) { removeAnnotation(doc, p, a.ref); k++; } } return k; });
      toast(`${n || 0} link(s) removed.`);
    },
  },
  {
    id: 'edit.repeat', label: 'Repeat Last Command', icon: 'repeat', tab: 'Home', group: 'Undo', keys: ['F4', 'Mod-Shift-y'], noRecord: true, edits: false,
    isEnabled: (app) => !!app.lastCommand, run: (app) => { const l = app.lastCommand; if (l) app.exec(l.id, l.arg); },
  },
  { id: 'edit.eraseRange', label: 'Erase Page Area…', icon: 'ink_eraser', tab: 'Edit', group: 'Text', tip: 'Erase a rectangle given in points (for exact areas; Erase Area drags one)', run: async (app) => { const p = pageOf(app, app.page); const r = await openDialog({ title: 'Erase Page Area', fields: [{ key: 'x0', label: 'Left', type: 'number', value: 72, half: true }, { key: 'y0', label: 'Bottom', type: 'number', value: Math.round(p.cropBox[3] - 144), half: true }, { key: 'x1', label: 'Right', type: 'number', value: Math.round(p.cropBox[2] - 72), half: true }, { key: 'y1', label: 'Top', type: 'number', value: Math.round(p.cropBox[3] - 72), half: true }, { key: 'white', label: 'Paint the area white', type: 'checkbox', value: true }], ok: 'Erase' }); if (!r) return; const n = app.edit('Erase Area', (doc) => eraseArea(doc, p, [+r.x0, +r.y0, +r.x1, +r.y1], r.white)); toast(`${n || 0} item(s) erased.`); } },
]);

export async function eraseRect(app: App, page: number, rect: Rect): Promise<void> {
  if (rect[2] - rect[0] < 2 || rect[3] - rect[1] < 2) return;
  const p = pageOf(app, page);
  const n = app.edit('Erase Area', (doc) => eraseArea(doc, p, rect, true));
  toast(`${n || 0} item(s) erased.`);
}

export { confirmDialog };
