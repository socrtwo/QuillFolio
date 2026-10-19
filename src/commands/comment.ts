/**
 * Comment tab: text markup, notes, text boxes, drawing, stamps, attachments, measurements, and the
 * management of annotations (properties, replies, status, delete, flatten, XFDF). Also the dispatcher
 * for every drawing tool: the viewer reports a finished gesture as comment.toolDone.
 */
import { def, type MenuEntry } from './registry';
import type { App, Tool } from '../app';
import { openDialog, toast, confirmDialog, promptDialog, colorMenu, HIGHLIGHT_COLORS, STANDARD_COLORS } from '../ui/dialog';
import { pickFile } from '../ui/dom';
import { pageAnnotations, allAnnotations, type AnnotInfo } from '../pdf/structure';
import { Dict, Ref } from '../pdf/objects';
import {
  addTextMarkup, addNote, addFreeText, addShape, addInk, STAMP_TEXTS, addTextStamp, addImageStamp, addLink, addFileAttachmentAnnot, addRedactMark,
  setAnnotationProps, addReply, deleteAnnotation, flattenAnnotations, exportXfdf, importXfdf, type MarkupKind, type ShapeKind,
} from '../pdf/ops/annots';
import { addField, type NewField } from '../pdf/ops/forms';
import { formatLength } from '../view/viewer';
import { viewer, pageOf, selectedAnnotation, hasAnnotSelected, selectedText, saveBytes, baseName, hexToRgb, rgbToHex, imageRefFromFile, fitBox, esc, FONT_OPTIONS, type Rect, type RGB } from './util';
import { annotLabel } from '../ui/panes';

const author = (app: App) => app.prefs.author || 'Author';
const penColor = (app: App): RGB => hexToRgb(app.prefs.penColor, [0.9, 0.2, 0.2]);
const hlColor = (app: App): RGB => hexToRgb(app.prefs.highlightColor, [1, 0.92, 0.23]);

/** Tool commands: with text selected, the markup tools apply at once; otherwise they arm the tool. */
const toolCmd = (id: string, t: Tool, label: string, icon: string, group: string, extra: Record<string, unknown> = {}, opts?: (app: App) => any) => ({
  id, label, icon, tab: 'Comment', group, kind: 'toggle' as const, noRecord: true,
  isActive: (app: App) => app.tab?.ui?.tool === t && (!opts || JSON.stringify(app.viewer.toolOpts) === JSON.stringify(opts(app))),
  run: (app: App) => { app.tab.ui.setTool(t, opts ? opts(app) : {}); app.focus(); }, ...extra,
});

const markupCmd = (id: string, t: Tool, kind: MarkupKind, label: string, icon: string, keys: string[]) => ({
  id, label, icon, keys, tab: 'Comment', group: 'Text Markup', kind: 'toggle' as const, noRecord: true,
  tip: `${label} the selected text, or drag over text with the tool`,
  isActive: (app: App) => app.tab?.ui?.tool === t,
  run: (app: App) => {
    const sr = app.viewer.selectionRects;
    if (sr && sr.rects.length) { markup(app, kind, sr.page, sr.rects); app.viewer.clearSelection(); return; }
    app.tab.ui.setTool(t);
    app.focus();
  },
});

function markup(app: App, kind: MarkupKind, page: number, rects: Rect[], contents?: string): void {
  const p = pageOf(app, page);
  const color: RGB = kind === 'Highlight' ? hlColor(app) : penColor(app);
  app.edit(kind, (doc) => addTextMarkup(doc, p, kind, rects, { author: author(app), color, contents }));
}

/** Rectangles of text items inside a dragged rectangle (so a drag with a markup tool marks words, not the box). */
async function textRectsIn(app: App, page: number, rect: Rect): Promise<Rect[]> {
  const items = await viewer(app).items(page);
  const out: Rect[] = [];
  for (const it of items) {
    if (!it.str.trim()) continue;
    const r: Rect = [it.x, it.y - it.h * 0.2, it.x + it.w, it.y + it.h * 0.8];
    const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
    if (cx >= rect[0] && cx <= rect[2] && cy >= rect[1] && cy <= rect[3]) out.push(r);
  }
  return out.length ? out : [rect];
}

async function textBox(app: App, page: number, rect: Rect, callout?: Rect): Promise<void> {
  const r = await openDialog({ title: callout ? 'Callout' : 'Text Box', fields: [
    { key: 't', label: 'Text', type: 'textarea', rows: 4, autofocus: true },
    { key: 'font', label: 'Font', type: 'select', options: FONT_OPTIONS, value: 'Helvetica', half: true },
    { key: 'size', label: 'Size (pt)', type: 'number', min: 4, max: 96, value: 12, half: true },
    { key: 'color', label: 'Text color', type: 'color', value: '#000000', half: true },
    { key: 'fill', label: 'Fill', type: 'color', value: '#FFFFE0', half: true },
    { key: 'border', label: 'Border', type: 'checkbox', value: true, half: true },
    { key: 'align', label: 'Align', type: 'select', options: ['left', 'center', 'right'], value: 'left', half: true },
  ], ok: 'Add' });
  if (!r || !String(r.t).trim()) return;
  const p = pageOf(app, page);
  let box = rect;
  if (box[2] - box[0] < 20 || box[3] - box[1] < 12) box = [rect[0], rect[3] - 24 - String(r.t).split('\n').length * (+r.size || 12) * 1.2, rect[0] + 200, rect[3]];
  const co = callout ? ([callout[0], callout[1], (box[0] + box[2]) / 2, box[3], box[0], box[3]] as [number, number, number, number, number, number]) : undefined;
  app.edit(callout ? 'Callout' : 'Text Box', (doc) => addFreeText(doc, p, box, { text: String(r.t), font: r.font, size: +r.size || 12, textColor: hexToRgb(r.color), fill: hexToRgb(r.fill), border: r.border ? [0.4, 0.4, 0.4] : null, align: r.align, author: author(app), callout: co }));
}

async function noteAt(app: App, page: number, x: number, y: number): Promise<void> {
  const r = await openDialog({ title: 'Note', fields: [{ key: 't', label: 'Comment', type: 'textarea', rows: 4, autofocus: true }, { key: 'icon', label: 'Icon', type: 'select', options: ['Comment', 'Note', 'Key', 'Help', 'NewParagraph', 'Paragraph', 'Insert'], value: 'Comment', half: true }, { key: 'color', label: 'Color', type: 'color', value: app.prefs.noteColor, half: true }], ok: 'Add' });
  if (!r) return;
  const p = pageOf(app, page);
  app.edit('Note', (doc) => addNote(doc, p, x, y, { contents: String(r.t), author: author(app), icon: r.icon, color: hexToRgb(r.color) }));
}

async function linkAt(app: App, page: number, rect: Rect): Promise<void> {
  const r = await openDialog({ title: 'Link', fields: [
    { key: 'kind', label: 'Link to', type: 'radio', options: [{ value: 'url', label: 'A web address' }, { value: 'page', label: 'A page in this document' }], value: 'url' },
    { key: 'url', label: 'Address', type: 'text', value: 'https://', visibleIf: (v) => v.kind === 'url' },
    { key: 'page', label: 'Page number', type: 'number', min: 1, max: app.doc.pageCount, value: 1, visibleIf: (v) => v.kind === 'page' },
    { key: 'border', label: 'Visible border', type: 'checkbox', value: false },
  ], ok: 'Add' });
  if (!r) return;
  const p = pageOf(app, page);
  const target = r.kind === 'url' ? { url: String(r.url) } : { page: (+r.page || 1) - 1 };
  app.edit('Link', (doc) => addLink(doc, p, rect, target, { border: r.border }));
}

async function stampAt(app: App, page: number, rect: Rect, opts: { text?: string; image?: Ref; width?: number; height?: number }): Promise<void> {
  const p = pageOf(app, page);
  let box = rect;
  if (opts.image) {
    if (box[2] - box[0] < 8) { const w = Math.min(200, (opts.width || 200)); box = [rect[0], rect[3] - w * (opts.height || 1) / (opts.width || 1), rect[0] + w, rect[3]]; }
    else box = (() => { const f = fitBox(opts.width || 1, opts.height || 1, rect); return [f.x, f.y, f.x + f.w, f.y + f.h] as Rect; })();
    app.edit('Stamp', (doc) => addImageStamp(doc, p, box, opts.image!, { author: author(app), opacity: app.prefs.stampOpacity }));
    return;
  }
  const text = opts.text || 'Approved';
  if (box[2] - box[0] < 8) box = [rect[0], rect[3] - 36, rect[0] + Math.max(100, text.length * 16), rect[3]];
  app.edit('Stamp', (doc) => addTextStamp(doc, p, box, text, { author: author(app), opacity: app.prefs.stampOpacity, color: hexToRgb(app.prefs.penColor, [0.8, 0.1, 0.1]) }));
}

async function attachAt(app: App, page: number, x: number, y: number): Promise<void> {
  const [f] = await pickFile('*/*');
  if (!f) return;
  const data = new Uint8Array(await f.arrayBuffer());
  const p = pageOf(app, page);
  app.edit('Attach File', (doc) => addFileAttachmentAnnot(doc, p, x, y, f.name, data, { author: author(app), mime: f.type || 'application/octet-stream' }));
}

function measureLine(app: App, page: number, pts: [number, number][]): void {
  if (pts.length < 2) return;
  const len = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
  const label = formatLength(len, app.prefs.measureUnit, app.prefs as any);
  const p = pageOf(app, page);
  app.edit('Measure', (doc) => addShape(doc, p, 'Line', [Math.min(pts[0][0], pts[1][0]), Math.min(pts[0][1], pts[1][1]), Math.max(pts[0][0], pts[1][0]), Math.max(pts[0][1], pts[1][1])], { points: [pts[0], pts[1]], stroke: penColor(app), width: 1, author: author(app), contents: label, subject: 'Distance' }));
  toast(`Distance: ${label}`);
}

function measureArea(app: App, page: number, pts: [number, number][]): void {
  if (pts.length < 3) { toast('Click at least three corners, then double-click to finish.'); return; }
  let a = 0, per = 0;
  for (let i = 0; i < pts.length; i++) { const q = pts[i], r = pts[(i + 1) % pts.length]; a += q[0] * r[1] - r[0] * q[1]; per += Math.hypot(r[0] - q[0], r[1] - q[1]); }
  a = Math.abs(a) / 2;
  const scale = (app.prefs as any).measureScale || 1;
  const unit = (app.prefs as any).measureScaleUnit || app.prefs.measureUnit;
  const conv: Record<string, number> = { pt: 1, in: 1 / 72, mm: 25.4 / 72, cm: 2.54 / 72, ft: 1 / 864, m: 0.0254 / 72 };
  const k = conv[unit] ?? 1;
  const label = `Area ${(a * scale * scale * k * k).toFixed(2)} ${unit}², perimeter ${formatLength(per, app.prefs.measureUnit, app.prefs as any)}`;
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  const p = pageOf(app, page);
  app.edit('Measure Area', (doc) => addShape(doc, p, 'Polygon', [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], { points: pts, stroke: penColor(app), fill: null, width: 1, author: author(app), contents: label, subject: 'Area' }));
  toast(label, { ms: 5000 });
}

function fieldAt(app: App, tool: string, page: number, rect: Rect): void {
  const type = tool.slice(6) as NewField['type'] | 'date';
  const p = pageOf(app, page);
  let box = rect;
  const small = type === 'checkbox' || type === 'radio';
  if (box[2] - box[0] < 6 || box[3] - box[1] < 6) box = small ? [rect[0], rect[3] - 16, rect[0] + 16, rect[3]] : [rect[0], rect[3] - 22, rect[0] + (type === 'signature' ? 200 : 160), rect[3]];
  const existing = new Set(app.doc.pages.flatMap((pg) => pageAnnotations(app.doc, pg)).map((a) => a.fieldType ? a.name : ''));
  let n = 1;
  const base = type === 'date' ? 'Date' : type[0].toUpperCase() + type.slice(1);
  while (existing.has(`${base}${n}`)) n++;
  const spec: NewField = { name: `${base}${n}`, type: type === 'date' ? 'text' : type, page, rect: box, border: [0.5, 0.5, 0.5], tooltip: type === 'date' ? 'Date (YYYY-MM-DD)' : undefined, options: type === 'combo' || type === 'list' ? ['Option 1', 'Option 2'] : undefined, value: type === 'button' ? 'Button' : undefined };
  const ref = app.edit('Add Field', (doc) => addField(doc, spec));
  if (ref) { app.tab.ui.selectedAnnot = { page, num: ref.num }; setTimeout(() => app.exec('forms.properties'), 50); }
  void p;
}

/** The viewer finished a gesture with the current tool. */
async function toolDone(app: App, a: { tool: Tool; page: number; start: [number, number]; end: [number, number]; rect: Rect; pts: [number, number][]; click: boolean; opts: any }): Promise<void> {
  const t = a.tool;
  const { page, rect } = a;
  const p = pageOf(app, page);
  switch (t) {
    case 'highlight': case 'underline': case 'strikeout': case 'squiggly': {
      if (a.click) return;
      const kind: MarkupKind = t === 'highlight' ? 'Highlight' : t === 'underline' ? 'Underline' : t === 'strikeout' ? 'StrikeOut' : 'Squiggly';
      markup(app, kind, page, await textRectsIn(app, page, rect));
      return;
    }
    case 'note': return noteAt(app, page, a.end[0], a.end[1]);
    case 'freetext': return textBox(app, page, rect);
    case 'callout': return textBox(app, page, [a.end[0], a.end[1] - 48, a.end[0] + 180, a.end[1]], [a.start[0], a.start[1], 0, 0]);
    case 'square': case 'circle': {
      if (a.opts?.erase) { const { eraseRect } = await import('./edit'); return eraseRect(app, page, rect); }
      if (rect[2] - rect[0] < 2) return;
      app.edit(t === 'square' ? 'Rectangle' : 'Ellipse', (doc) => addShape(doc, p, t === 'square' ? 'Square' : 'Circle', rect, { stroke: penColor(app), width: app.prefs.penWidth, fill: a.opts?.fill ? hexToRgb(a.opts.fill) : null, author: author(app) }));
      return;
    }
    case 'line': case 'arrow': {
      if (a.click) return;
      app.edit(t === 'arrow' ? 'Arrow' : 'Line', (doc) => addShape(doc, p, 'Line', rect, { points: [a.start, a.end], arrow: t === 'arrow', stroke: penColor(app), width: app.prefs.penWidth, author: author(app) }));
      return;
    }
    case 'polygon': case 'polyline': case 'cloud': {
      if (a.pts.length < 2) return;
      if (a.opts?.measureArea) return measureArea(app, page, a.pts);
      const kind: ShapeKind = t === 'polygon' ? 'Polygon' : t === 'polyline' ? 'PolyLine' : 'Cloud';
      app.edit(kind, (doc) => addShape(doc, p, kind, rect, { points: a.pts, stroke: penColor(app), width: app.prefs.penWidth, author: author(app) }));
      return;
    }
    case 'ink': case 'highlighter': {
      if (a.pts.length < 2) return;
      app.edit(t === 'ink' ? 'Pen' : 'Highlighter', (doc) => addInk(doc, p, [a.pts], { color: t === 'ink' ? penColor(app) : hlColor(app), width: t === 'ink' ? app.prefs.penWidth : Math.max(8, app.prefs.penWidth * 5), highlighter: t === 'highlighter', author: author(app) }));
      return;
    }
    case 'eraser': {
      // Delete ink annotations the stroke touches.
      const hits = pageAnnotations(app.doc, p).filter((an) => an.subtype === 'Ink' && an.ref && a.pts.some((q) => q[0] >= an.rect[0] && q[0] <= an.rect[2] && q[1] >= an.rect[1] && q[1] <= an.rect[3]));
      if (!hits.length) return;
      app.edit('Erase Ink', (doc) => { for (const an of hits) deleteAnnotation(doc, p, an.ref!); });
      return;
    }
    case 'stamp': {
      if (a.opts?.mark) { const { placeMark } = await import('./sign'); return placeMark(app, page, a.end[0], a.end[1] - 14, a.opts.mark); }
      if (a.opts?.date) { const { insertText } = await import('../pdf/ops/textedit'); app.edit('Date', (doc) => insertText(doc, p, a.end[0], a.end[1] - 10, new Date().toLocaleDateString(), { size: 11, color: [0.06, 0.16, 0.42] })); return; }
      return stampAt(app, page, rect, a.opts || {});
    }
    case 'sign': return stampAt(app, page, rect, a.opts || {});
    case 'link': { if (rect[2] - rect[0] < 4) return; return linkAt(app, page, rect); }
    case 'attach': return attachAt(app, page, a.end[0], a.end[1]);
    case 'redact': {
      if (a.click) return;
      const rects = a.opts?.text ? await textRectsIn(app, page, rect) : [rect];
      app.edit('Mark for Redaction', (doc) => addRedactMark(doc, p, rects, { author: author(app), overlayText: a.opts?.overlayText }));
      return;
    }
    case 'measure': return measureLine(app, page, [a.start, a.end]);
    case 'measureArea': return measureArea(app, page, a.pts);
    case 'zoom': { const { zoomToRect } = await import('./home'); return zoomToRect(app, page, rect, a.click, !!a.opts?.out); }
    case 'snapshot': { const { snapshotRect } = await import('./home'); return snapshotRect(app, page, rect); }
    case 'image': { const { placeImage } = await import('./edit'); return placeImage(app, page, rect, a.opts); }
    case 'text': { const { addTextAt } = await import('./edit'); return addTextAt(app, page, a.end[0], a.end[1], a.click ? undefined : rect); }
    case 'erase': { const { eraseRect } = await import('./edit'); return eraseRect(app, page, rect); }
    case 'crop': {
      if (rect[2] - rect[0] < 8 || rect[3] - rect[1] < 8) return;
      const { setPageBox } = await import('../pdf/ops/pages');
      app.edit('Crop Page', (doc) => setPageBox(doc, [page], 'CropBox', rect));
      app.tab.ui.setTool('select');
      return;
    }
    default:
      if (t.startsWith('field-')) return fieldAt(app, t, page, rect);
  }
}

// ------------------------------------------------------------------------------------------
// Properties and management

async function properties(app: App): Promise<void> {
  const s = selectedAnnotation(app);
  if (!s) { toast('Select an annotation first.'); return; }
  if (s.info.subtype === 'Widget') { app.exec(app.tab.fillMode ? 'forms.fillValue' : 'forms.properties'); return; }
  const i = s.info;
  const r = await openDialog({ title: `${annotLabel(i)} Properties`, fields: [
    { key: 'contents', label: 'Comment', type: 'textarea', rows: 4, value: i.contents },
    { key: 'author', label: 'Author', type: 'text', value: i.author, half: true },
    { key: 'subject', label: 'Subject', type: 'text', value: app.doc.getText(i.dict, 'Subj'), half: true },
    { key: 'color', label: 'Color', type: 'color', value: rgbToHex(i.color, '#ffff00'), half: true },
    { key: 'opacity', label: 'Opacity', type: 'range', min: 0.05, max: 1, step: 0.05, value: i.opacity ?? 1, half: true },
    { key: 'hidden', label: 'Hidden', type: 'checkbox', value: i.hidden, half: true },
    { key: 'i', type: 'info', html: `<p class="ql-help">${esc(i.subtype)} on page ${i.page + 1}${i.date ? `, ${i.date.toLocaleString()}` : ''}. Rect ${i.rect.map((v) => v.toFixed(0)).join(', ')}.</p>` },
  ] });
  if (!r) return;
  app.edit('Annotation Properties', (doc) => setAnnotationProps(doc, s.page, s.ref, { contents: r.contents, author: r.author, subject: r.subject, color: hexToRgb(r.color), opacity: +r.opacity, hidden: r.hidden }));
}

const STATES: { label: string; model: 'Review' | 'Marked'; state: string }[] = [
  { label: 'Accepted', model: 'Review', state: 'Accepted' }, { label: 'Rejected', model: 'Review', state: 'Rejected' }, { label: 'Cancelled', model: 'Review', state: 'Cancelled' }, { label: 'Completed', model: 'Review', state: 'Completed' }, { label: 'None', model: 'Review', state: 'None' },
  { label: 'Marked', model: 'Marked', state: 'Marked' }, { label: 'Unmarked', model: 'Marked', state: 'Unmarked' },
];

/** Reorders the selected annotation within the page's /Annots array. */
function reorder(app: App, toFront: boolean): void {
  const s = selectedAnnotation(app);
  if (!s) return;
  app.edit(toFront ? 'Bring to Front' : 'Send to Back', (doc) => {
    const arr = doc.getArray(s.page.dict, 'Annots');
    if (!arr) return;
    const i = arr.findIndex((x) => x instanceof Ref && x.equals(s.ref));
    if (i < 0) return;
    const [it] = arr.splice(i, 1);
    if (toFront) arr.push(it); else arr.unshift(it);
    const ar = s.page.dict.get('Annots');
    if (ar instanceof Ref) doc.update(ar, arr); else if (s.page.ref) doc.update(s.page.ref, s.page.dict);
  });
}

function summarize(app: App): string {
  const all = allAnnotations(app.doc).filter((a) => !['Widget', 'Popup', 'Link'].includes(a.subtype));
  const lines: string[] = [`Comments in ${app.tab.displayName}`, `${all.length} annotation(s), ${new Set(all.map((a) => a.author).filter(Boolean)).size} author(s)`, ''];
  let page = -1;
  for (const a of all.sort((x, y) => x.page - y.page || y.rect[3] - x.rect[3])) {
    if (a.page !== page) { page = a.page; lines.push(`Page ${page + 1}`, '-'.repeat(12)); }
    lines.push(`${a.irt ? '  ↳ ' : ''}${annotLabel(a)}${a.author ? ` — ${a.author}` : ''}${a.date ? ` — ${a.date.toLocaleString()}` : ''}${a.state ? ` [${a.state}]` : ''}`);
    if (a.contents) lines.push(...a.contents.split('\n').map((l) => `    ${l}`));
  }
  return lines.join('\n');
}

const sel = (app: App): AnnotInfo | null => selectedAnnotation(app)?.info || null;

def([
  markupCmd('comment.highlight', 'highlight', 'Highlight', 'Highlight', 'ink_highlighter', ['Mod-Alt-h']),
  markupCmd('comment.underline', 'underline', 'Underline', 'Underline', 'format_underlined', ['Mod-Alt-u']),
  markupCmd('comment.strikeout', 'strikeout', 'StrikeOut', 'Strikethrough', 'strikethrough_s', ['Mod-Alt-s']),
  markupCmd('comment.squiggly', 'squiggly', 'Squiggly', 'Squiggly Underline', 'format_color_text', []),
  toolCmd('comment.note', 'note', 'Note', 'add_comment', 'Notes', { keys: ['Mod-Alt-n'], tip: 'Click where a sticky note goes', popular: true }),
  toolCmd('comment.freetext', 'freetext', 'Text Box', 'text_fields', 'Notes', { tip: 'Drag a box for text that shows on the page' }),
  toolCmd('comment.callout', 'callout', 'Callout', 'speaker_notes', 'Notes', { tip: 'Drag from the point of interest to where the text box goes' }),
  toolCmd('comment.pen', 'ink', 'Pen', 'draw', 'Drawing', { keys: ['Mod-Alt-p'], tip: 'Draw freehand ink' }),
  toolCmd('comment.highlighterPen', 'highlighter', 'Highlighter Pen', 'border_color', 'Drawing', { tip: 'Freehand translucent highlighter' }),
  toolCmd('comment.eraser', 'eraser', 'Ink Eraser', 'ink_eraser', 'Drawing', { tip: 'Drag over ink to delete those strokes' }),
  toolCmd('comment.line', 'line', 'Line', 'horizontal_rule', 'Drawing'),
  toolCmd('comment.arrow', 'arrow', 'Arrow', 'north_east', 'Drawing'),
  toolCmd('comment.rectangle', 'square', 'Rectangle', 'rectangle', 'Drawing', {}, () => ({})),
  toolCmd('comment.ellipse', 'circle', 'Ellipse', 'circle', 'Drawing'),
  toolCmd('comment.polygon', 'polygon', 'Polygon', 'pentagon', 'Drawing', { tip: 'Click each corner; double-click or Enter to finish' }, () => ({})),
  toolCmd('comment.polyline', 'polyline', 'Polyline', 'timeline', 'Drawing', { tip: 'Click each point; double-click or Enter to finish' }),
  toolCmd('comment.cloud', 'cloud', 'Cloud', 'cloud', 'Drawing', { tip: 'A revision cloud: click each corner, double-click to finish' }),
  {
    id: 'comment.stamp', label: 'Stamp', icon: 'approval', tab: 'Comment', group: 'Stamps', kind: 'gallery', noRecord: true,
    tip: 'Pick a stamp, then click or drag where it goes',
    menu: () => STAMP_TEXTS.map((t) => ({ id: 'comment.stamp', arg: t, label: t, preview: 'font-weight:700;color:#A6303B;border:2px solid #A6303B;border-radius:4px;padding:1px 6px' })),
    isActive: (app) => app.tab?.ui?.tool === 'stamp' && !!app.viewer.toolOpts?.text,
    run: (app, text?: string) => { app.tab.ui.setTool('stamp', { text: text || 'Approved' }); toast(`Click or drag on the page to place "${text || 'Approved'}".`, { ms: 2500 }); },
  },
  { id: 'comment.customStamp', label: 'Custom Stamp…', icon: 'new_label', tab: 'Comment', group: 'Stamps', noRecord: true, tip: 'A stamp with your own words', run: async (app) => { const t = await promptDialog('Custom Stamp', 'Stamp text', `${app.prefs.initials || ''} ${new Date().toLocaleDateString()}`.trim()); if (t) app.exec('comment.stamp', t); } },
  { id: 'comment.imageStamp', label: 'Image Stamp…', icon: 'image', tab: 'Comment', group: 'Stamps', noRecord: true, tip: 'A picture file as a stamp (a logo, a scanned signature)', run: async (app) => { const [f] = await pickFile('image/*'); if (!f) return; const im = await imageRefFromFile(app, f); app.tab.ui.setTool('stamp', { image: im.ref, width: im.width, height: im.height }); toast('Click or drag on the page to place the picture stamp.', { ms: 2500 }); } },
  toolCmd('comment.attachFile', 'attach', 'Attach File', 'attach_file', 'Attach', { tip: 'Click where a file attachment icon goes, then pick the file' }),
  {
    id: 'comment.audio', label: 'Audio Comment', icon: 'mic', tab: 'Comment', group: 'Attach', noRecord: true,
    tip: 'Record a voice note with the microphone; it is attached to the page as a file',
    run: async (app) => {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { toast('Recording is not available in this browser.'); return; }
      let stream: MediaStream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { toast('Microphone access was refused.'); return; }
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.start();
      const t0 = Date.now();
      const r = await openDialog({ title: 'Audio Comment', fields: [{ key: 'i', type: 'info', html: '<p>● Recording… Choose Stop when you are done.</p>' }], ok: 'Stop and Attach', cancel: 'Discard' });
      await new Promise<void>((res) => { rec.onstop = () => res(); rec.stop(); });
      stream.getTracks().forEach((tr) => tr.stop());
      if (!r) return;
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      const data = new Uint8Array(await blob.arrayBuffer());
      const p = pageOf(app, app.page);
      const secs = Math.round((Date.now() - t0) / 1000);
      app.edit('Audio Comment', (doc) => addFileAttachmentAnnot(doc, p, p.cropBox[0] + 24, p.cropBox[3] - 24, `voice-note-${Date.now()}.${/ogg/.test(blob.type) ? 'ogg' : 'webm'}`, data, { author: author(app), mime: blob.type, contents: `Audio comment (${secs} s)` }));
    },
  },
  toolCmd('comment.measure', 'measure', 'Measure Distance', 'straighten', 'Measure', { tip: 'Drag between two points; the distance is written on a line annotation' }),
  toolCmd('comment.measureArea', 'polygon', 'Measure Area', 'square_foot', 'Measure', { tip: 'Click the corners of an area; double-click to finish' }, () => ({ measureArea: true })),
  {
    id: 'comment.measureScale', label: 'Measurement Scale…', icon: 'architecture', tab: 'Comment', group: 'Measure', noRecord: true, edits: false,
    tip: 'Set the drawing scale (e.g. 1 in = 10 ft) and the unit shown',
    run: async (app) => {
      const p = app.prefs as any;
      const r = await openDialog({ title: 'Measurement Scale', fields: [
        { key: 'unit', label: 'Display unit', type: 'select', options: ['pt', 'in', 'mm', 'cm'], value: app.prefs.measureUnit, half: true },
        { key: 'use', label: 'Use a drawing scale', type: 'checkbox', value: !!p.measureScale && p.measureScale !== 1 },
        { key: 'pageLen', label: 'Length on the page', type: 'number', value: 1, half: true, visibleIf: (v) => v.use }, { key: 'pageUnit', label: 'Page unit', type: 'select', options: ['in', 'mm', 'cm', 'pt'], value: 'in', half: true, visibleIf: (v) => v.use },
        { key: 'realLen', label: 'Equals (real length)', type: 'number', value: 10, half: true, visibleIf: (v) => v.use }, { key: 'realUnit', label: 'Real unit', type: 'select', options: ['ft', 'm', 'in', 'mm', 'cm'], value: 'ft', half: true, visibleIf: (v) => v.use },
      ] });
      if (!r) return;
      app.prefs.measureUnit = r.unit;
      if (r.use) {
        const toPt: Record<string, number> = { pt: 1, in: 72, mm: 72 / 25.4, cm: 72 / 2.54, ft: 864, m: 72 / 0.0254 };
        const pagePts = (+r.pageLen || 1) * toPt[r.pageUnit];
        const realPts = (+r.realLen || 1) * toPt[r.realUnit];
        p.measureScale = realPts / pagePts; p.measureScaleUnit = r.realUnit;
      } else { delete p.measureScale; delete p.measureScaleUnit; }
      app.savePrefs();
    },
  },
  {
    id: 'comment.color', label: 'Color', icon: 'palette', tab: 'Comment', group: 'Style', kind: 'color', noRecord: true,
    tip: 'Color for new drawings and highlights; with an annotation selected, recolor it',
    value: (app) => app.prefs.penColor,
    run: async (app, c?: string) => {
      if (!c) { c = (await colorMenu(app.ui.anchorFor('comment.color'), { highlight: true, title: 'Annotation color' })) || undefined; if (!c) return; }
      const s = selectedAnnotation(app);
      if (s && s.info.subtype !== 'Widget') { app.edit('Annotation Color', (doc) => setAnnotationProps(doc, s.page, s.ref, { color: hexToRgb(c!) })); return; }
      if (HIGHLIGHT_COLORS.includes(c.toLowerCase()) && ['highlight', 'highlighter'].includes(app.tab.ui.tool)) app.prefs.highlightColor = c; else app.prefs.penColor = c;
      app.savePrefs(); app.refresh();
    },
    menu: () => [...HIGHLIGHT_COLORS.slice(0, 6).map((c) => ({ id: 'comment.color', arg: c, label: c, swatch: c })), { separator: true }, ...STANDARD_COLORS.map((c) => ({ id: 'comment.color', arg: c, label: c, swatch: c }))],
  },
  {
    id: 'comment.opacity', label: 'Opacity', icon: 'opacity', tab: 'Comment', group: 'Style', kind: 'menu', noRecord: true,
    menu: (app) => [100, 85, 70, 50, 30].map((o) => ({ id: 'comment.opacity', arg: o / 100, label: `${o}%`, checked: Math.round((sel(app)?.opacity ?? app.prefs.stampOpacity) * 100) === o })),
    run: (app, o?: number) => { if (o == null) return; const s = selectedAnnotation(app); if (s) app.edit('Opacity', (doc) => setAnnotationProps(doc, s.page, s.ref, { opacity: o })); else { app.prefs.stampOpacity = o; app.savePrefs(); } },
  },
  {
    id: 'comment.lineWidth', label: 'Line Width', icon: 'line_weight', tab: 'Comment', group: 'Style', kind: 'menu', noRecord: true,
    menu: (app) => [0.5, 1, 2, 3, 4, 6, 8].map((w) => ({ id: 'comment.lineWidth', arg: w, label: `${w} pt`, checked: app.prefs.penWidth === w })),
    run: (app, w?: number) => {
      if (w == null) return;
      app.prefs.penWidth = w; app.savePrefs();
      const s = selectedAnnotation(app);
      if (s && s.info.subtype !== 'Widget') app.edit('Line Width', (doc) => { const d = doc.resolve<Dict>(s.ref); const bs = doc.getDict(d, 'BS') || new Dict(); bs.set('W', w); d.set('BS', bs); doc.update(s.ref, d); });
    },
  },
  { id: 'comment.author', label: 'Author Name…', icon: 'person', tab: 'Comment', group: 'Style', noRecord: true, edits: false, tip: 'The name written on new comments', run: async (app) => { const n = await promptDialog('Author', 'Name on new comments', app.prefs.author); if (n) { app.prefs.author = n; app.savePrefs(); } } },
  { id: 'comment.properties', label: 'Properties…', icon: 'tune', tab: 'Comment', group: 'Manage', keys: ['Mod-i'], noRecord: true, isEnabled: hasAnnotSelected, run: properties },
  {
    id: 'comment.reply', label: 'Reply…', icon: 'reply', tab: 'Comment', group: 'Manage', isEnabled: hasAnnotSelected,
    run: async (app) => { const s = selectedAnnotation(app); if (!s) return; const t = await promptDialog('Reply', `Reply to ${annotLabel(s.info)}${s.info.author ? ` by ${s.info.author}` : ''}`, '', { type: 'textarea', rows: 3 } as any); if (!t) return; app.edit('Reply', (doc) => addReply(doc, s.page, s.ref, t, author(app))); },
  },
  {
    id: 'comment.setStatus', label: 'Set Status', icon: 'task_alt', tab: 'Comment', group: 'Manage', kind: 'menu', isEnabled: hasAnnotSelected,
    menu: (app) => STATES.map((st) => ({ id: 'comment.setStatus', arg: st.state, label: st.label, checked: sel(app)?.state === st.state })),
    run: (app, state?: string) => { const s = selectedAnnotation(app); const st = STATES.find((x) => x.state === state); if (!s || !st) return; app.edit('Set Status', (doc) => addReply(doc, s.page, s.ref, `${st.label} set by ${author(app)}`, author(app), { model: st.model, state: st.state })); },
  },
  { id: 'comment.hide', label: 'Hide / Show', icon: 'visibility_off', tab: 'Comment', group: 'Manage', kind: 'toggle', isEnabled: hasAnnotSelected, isActive: (app) => !!sel(app)?.hidden, run: (app) => { const s = selectedAnnotation(app); if (s) app.edit('Hide Annotation', (doc) => setAnnotationProps(doc, s.page, s.ref, { hidden: !s.info.hidden })); } },
  { id: 'comment.delete', label: 'Delete', icon: 'delete', tab: 'Comment', group: 'Manage', keys: ['Delete'], isEnabled: hasAnnotSelected, run: (app) => { const s = selectedAnnotation(app); if (!s) return; app.edit('Delete Annotation', (doc) => deleteAnnotation(doc, s.page, s.ref)); app.tab.ui.selectedAnnot = null; } },
  {
    id: 'comment.deleteAll', label: 'Delete All Comments', icon: 'comments_disabled', tab: 'Comment', group: 'Manage',
    run: async (app) => {
      const all = allAnnotations(app.doc).filter((a) => !['Widget', 'Link'].includes(a.subtype) && a.ref);
      if (!all.length) { toast('There are no comments.'); return; }
      const r = await openDialog({ title: 'Delete All Comments', fields: [{ key: 'scope', label: 'Delete', type: 'radio', options: [{ value: 'page', label: `On this page (${all.filter((a) => a.page === app.page).length})` }, { value: 'all', label: `In the whole document (${all.length})` }], value: 'page' }], ok: 'Delete' });
      if (!r) return;
      app.edit('Delete All Comments', (doc) => { for (const a of all) if (r.scope === 'all' || a.page === app.page) deleteAnnotation(doc, doc.pages[a.page], a.ref!); });
      app.tab.ui.selectedAnnot = null;
    },
  },
  {
    id: 'comment.summarize', label: 'Summarize Comments', icon: 'summarize', tab: 'Comment', group: 'Manage', edits: false, noRecord: true,
    tip: 'A list of every comment by page, to copy, save as text or add as pages at the end',
    run: async (app) => {
      const text = summarize(app);
      const r = await openDialog({ title: 'Comment Summary', wide: true, fields: [{ key: 't', type: 'textarea', rows: 18, value: text, label: 'Summary' }], ok: 'Save as Text…', cancel: 'Close', buttons: [
        { label: 'Copy', onClick: () => { navigator.clipboard?.writeText(text); toast('Copied'); } },
        { label: 'Append as Pages', onClick: async (_v, ctl) => { ctl.close(null); const { addTextPages } = await import('../pdf/build'); app.edit('Comment Summary Pages', (doc) => addTextPages(doc, text, { title: 'Comment Summary', font: 'Helvetica', size: 10 })); } },
      ] });
      if (r) await saveBytes(String(r.t), `${baseName(app)} comments.txt`, 'text/plain');
    },
  },
  {
    id: 'comment.importXfdf', label: 'Import Comments (XFDF)', icon: 'download', tab: 'Comment', group: 'Manage', tip: 'Add the annotations from an XFDF file (another reviewer\'s comments)',
    run: async (app) => { const [f] = await pickFile('.xfdf,.xml,.fdf'); if (!f) return; const xml = await f.text(); const n = app.edit('Import Comments', (doc) => importXfdf(doc, xml)); toast(`${n || 0} comment(s) imported.`); },
  },
  { id: 'comment.exportXfdf', label: 'Export Comments (XFDF)', icon: 'ios_share', tab: 'Comment', group: 'Manage', edits: false, noRecord: true, run: (app) => saveBytes(exportXfdf(app.doc, app.tab.fileName), `${baseName(app)}.xfdf`, 'application/vnd.adobe.xfdf') },
  {
    id: 'comment.flatten', label: 'Flatten Comments', icon: 'layers_clear', tab: 'Comment', group: 'Manage', tip: 'Draw every comment into the page content so any reader shows it and nobody can move it',
    run: async (app) => {
      const r = await openDialog({ title: 'Flatten Comments', fields: [{ key: 'scope', label: 'Flatten', type: 'radio', options: [{ value: 'page', label: 'This page' }, { value: 'all', label: 'All pages' }], value: 'all' }, { key: 'notes', label: 'Include sticky notes (their icons)', type: 'checkbox', value: false }], ok: 'Flatten' });
      if (!r) return;
      const n = app.edit('Flatten Comments', (doc) => { let k = 0; for (const p of doc.pages) if (r.scope === 'all' || p.index === app.page) k += flattenAnnotations(doc, p, (a) => a.subtype !== 'Widget' && a.subtype !== 'Link' && (r.notes || a.subtype !== 'Text')); return k; });
      toast(`${n || 0} annotation(s) flattened.`);
    },
  },
  { id: 'comment.flattenOne', label: 'Flatten This Annotation', icon: 'layers_clear', tab: 'Comment', group: 'Arrange', isEnabled: hasAnnotSelected, run: (app) => { const s = selectedAnnotation(app); if (!s) return; app.edit('Flatten Annotation', (doc) => flattenAnnotations(doc, s.page, (a) => !!a.ref && a.ref.equals(s.ref))); app.tab.ui.selectedAnnot = null; } },
  {
    id: 'comment.duplicate', label: 'Duplicate', icon: 'content_copy', tab: 'Comment', group: 'Arrange', keys: ['Mod-d'], isEnabled: hasAnnotSelected,
    run: (app) => {
      const s = selectedAnnotation(app);
      if (!s) return;
      const { cloneObj } = requireObjects();
      const ref = app.edit('Duplicate Annotation', (doc) => { const d = cloneObj(doc.resolve<Dict>(s.ref)) as Dict; d.delete('Popup'); d.delete('P'); const r = doc.rect(d.get('Rect')) || s.info.rect; d.set('Rect', [r[0] + 12, r[1] - 12, r[2] + 12, r[3] - 12]); const { addAnnotation } = requireStructure(); return addAnnotation(doc, s.page, d); });
      if (ref) app.tab.ui.selectedAnnot = { page: s.page.index, num: ref.num };
    },
  },
  { id: 'comment.toFront', label: 'Bring to Front', icon: 'flip_to_front', tab: 'Comment', group: 'Arrange', isEnabled: hasAnnotSelected, run: (app) => reorder(app, true) },
  { id: 'comment.toBack', label: 'Send to Back', icon: 'flip_to_back', tab: 'Comment', group: 'Arrange', isEnabled: hasAnnotSelected, run: (app) => reorder(app, false) },
  {
    id: 'comment.link', label: 'Link', icon: 'link', tab: 'Comment', group: 'Links', kind: 'toggle', noRecord: true,
    tip: 'Make the selected text a link, or drag a rectangle to link',
    isActive: (app) => app.tab?.ui?.tool === 'link',
    run: (app) => { const sr = app.viewer.selectionRects; if (sr && sr.rects.length) { const xs = sr.rects.flatMap((r) => [r[0], r[2]]), ys = sr.rects.flatMap((r) => [r[1], r[3]]); void linkAt(app, sr.page, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]); app.viewer.clearSelection(); return; } app.tab.ui.setTool('link'); },
  },
  { id: 'comment.moveAnnotation', label: 'Move Annotation', icon: 'open_with', tab: 'Comment', group: 'Arrange', internal: true, noRecord: true, run: (app, a: { page: number; num: number; rect: Rect }) => { const p = pageOf(app, a.page); const ref = new Ref(a.num, app.doc.genOf(a.num)); app.edit('Move Annotation', (doc) => setAnnotationProps(doc, p, ref, { rect: a.rect })); } },
  { id: 'comment.toolDone', label: 'Finish Tool Gesture', icon: 'done', tab: 'Comment', group: 'Manage', internal: true, noRecord: true, run: (app, a) => toolDone(app, a) },
  {
    id: 'comment.nextComment', label: 'Next Comment', icon: 'skip_next', tab: 'Comment', group: 'Manage', keys: ['Mod-Alt-ArrowRight'], noRecord: true, edits: false,
    run: (app) => step(app, 1),
  },
  { id: 'comment.prevComment', label: 'Previous Comment', icon: 'skip_previous', tab: 'Comment', group: 'Manage', keys: ['Mod-Alt-ArrowLeft'], noRecord: true, edits: false, run: (app) => step(app, -1) },
  {
    id: 'comment.markupFromText', label: 'Mark Up Selected Text with a Note', icon: 'rate_review', tab: 'Comment', group: 'Text Markup', isEnabled: (app) => !!selectedText(app),
    tip: 'Highlight the selection and attach a comment to it',
    run: async (app) => { const sr = app.viewer.selectionRects; if (!sr) return; const t = await promptDialog('Comment on Selection', `"${selectedText(app).slice(0, 60)}…"`, '', { type: 'textarea', rows: 3 } as any); if (t == null) return; markup(app, 'Highlight', sr.page, sr.rects, t); app.viewer.clearSelection(); },
  },
]);

function step(app: App, dir: 1 | -1): void {
  const all = allAnnotations(app.doc).filter((a) => a.ref && !['Widget', 'Popup', 'Link'].includes(a.subtype) && !a.irt).sort((x, y) => x.page - y.page || y.rect[3] - x.rect[3]);
  if (!all.length) { toast('There are no comments.'); return; }
  const cur = app.tab.ui.selectedAnnot;
  let i = cur ? all.findIndex((a) => a.ref!.num === cur.num) : -1;
  i = i < 0 ? (dir > 0 ? 0 : all.length - 1) : (i + dir + all.length) % all.length;
  const a = all[i];
  app.tab.ui.selectedAnnot = { page: a.page, num: a.ref!.num };
  app.tab.ui.goToPage(a.page, a.rect[3] + 40);
  app.tab.ui.refreshAnnotations();
  app.refresh();
}

import * as objectsMod from '../pdf/objects';
import * as structureMod from '../pdf/structure';
function requireObjects() { return objectsMod; }
function requireStructure() { return structureMod; }
export { toolDone, markup, confirmDialog, type MenuEntry };
