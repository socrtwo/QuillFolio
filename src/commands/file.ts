/** File (backstage) commands: new, open, save, export, print, share, info, versions, options. */
import { def } from './registry';
import type { App, DocTab } from '../app';
import { PdfDocument } from '../pdf/document';
import { PasswordNeeded } from '../pdf/crypt';
import { FORMATS, formatById, formatFromName, openAsPdf, imageSpecFromBytes } from '../io';
import { openDocument, saveAs, writeBack, shareFile, readUri, OPEN_ACCEPT, OPEN_MIMES, isDesktop, readClipboardText } from '../platform/native';
import { openDialog, toast, confirmDialog, choiceDialog, promptDialog } from '../ui/dialog';
import { kvGet, kvSet, kvKeys, kvDel } from '../util/store';
import { TEMPLATES } from '../templates';
import { showRecoveryReport, showManualRecovery, recoverySummary } from '../ui/recovery';
import { sanitizePrefs } from '../prefs';
import { readMetadata, writeMetadata } from '../pdf/structure';
import { PdfString, Name } from '../pdf/objects';
import { baseName, saveBytes, toBlob, pageImage, docCopy, zipOf, pagesFromRange, rangeField, esc } from './util';

/** Key for a document's cached copy, Recent entry and snapshots. */
export function docKey(tab: DocTab): string {
  return (tab.uri && !tab.uri.startsWith('fsa:') ? tab.uri : '') || tab.key || `doc:${tab.id}`;
}

export function localKey(name: string, data: ArrayBuffer | Uint8Array): string {
  const b = data instanceof Uint8Array ? data : new Uint8Array(data);
  let hh = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) hh = Math.imul(hh ^ b[i], 0x01000193);
  return `doc:${name}:${b.length.toString(36)}.${(hh >>> 0).toString(36)}`;
}

/** An untouched new document can be replaced by the next file opened. */
function isPristine(tab: DocTab): boolean {
  return !tab.dirty && !tab.uri && !tab.fileName && !tab.canUndo && tab.doc.pageCount <= 1 && tab.doc.pageContent(tab.doc.pages[0]).length < 4;
}

export interface OpenOptions { repair?: boolean; key?: string; password?: string; title?: string }

export async function openBuffer(app: App, data: ArrayBuffer | Uint8Array, name: string, uri: string | null, opts: OpenOptions = {}): Promise<DocTab | null> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  try {
    if (opts.repair) toast(`Repairing ${name}…`);
    let res;
    try {
      res = await openAsPdf(bytes, name, { repair: opts.repair, password: opts.password });
    } catch (e) {
      if (e instanceof PasswordNeeded) {
        const pw = await promptDialog('Password', `${name} is encrypted. Enter its password:`, '', { type: 'password' });
        if (pw == null) return null;
        return openBuffer(app, bytes, name, uri, { ...opts, password: pw });
      }
      throw e;
    }
    const { doc, format, repair, warnings } = res;
    const fmt = formatById(format) || formatFromName(name);
    const cur = app.tab;
    const base = name.replace(/\.[^.]+$/, '');
    const keepsFile = format === 'pdf' && !repair;
    const meta: Partial<DocTab> = repair
      ? { title: `${base} (Recovered)`, fileName: `${base} (Recovered).pdf`, format: 'pdf', uri: null, key: '' }
      : { title: opts.title || base, fileName: keepsFile ? name : `${base}.pdf`, format: 'pdf', uri: keepsFile ? uri : null, key: uri && !uri.startsWith('fsa:') ? '' : opts.key || localKey(name, bytes) };
    meta.password = opts.password || '';
    let tab: DocTab;
    if (cur && isPristine(cur)) {
      Object.assign(cur, meta);
      cur.replace(doc, res.bytes);
      tab = cur;
      await tab.ui.reload();
      app.ui.tabsChanged();
    } else tab = app.createTab(doc, meta, res.bytes);
    tab.dirty = !!repair || !keepsFile;
    tab.repair = repair || null;
    tab.readOnly = doc.info ? doc.getText(doc.info, 'QuillFolioReadOnly') === 'true' : false;
    if (keepsFile) {
      addRecent(app, tab);
      await kvSet('file:' + docKey(tab), { name, data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), uri, when: Date.now() });
    }
    app.activate(tab);
    const details = () => openDialog({ title: 'Open Notes', content: Object.assign(document.createElement('pre'), { className: 'ql-notices', textContent: (warnings || []).join('\n') }), cancel: false });
    if (repair) toast(`${name} was damaged. ${recoverySummary(repair)}`, { action: 'Details', onAction: () => app.exec('file.recoveryReport'), ms: 9000 });
    else if (warnings?.length) toast(`Opened ${name} (${warnings.length} note${warnings.length > 1 ? 's' : ''})`, { action: 'Details', onAction: details, ms: 9000 });
    else if (!keepsFile) toast(`Made a PDF from ${name}. Save it to keep it.`, { ms: 6000 });
    else toast(`Opened ${name}${fmt && fmt.id !== 'pdf' ? ` (${fmt.label})` : ''}`);
    return tab;
  } catch (e: any) {
    console.error(e);
    toast(`Could not open ${name}: ${e?.message || e}`, { action: 'Repair', onAction: () => openBuffer(app, bytes, name, uri, { repair: true }), ms: 9000 });
    return null;
  }
}

function addRecent(app: App, tab: DocTab) {
  const key = docKey(tab);
  const list = app.prefs.recent.filter((r) => r.key !== key);
  const old = app.prefs.recent.find((r) => r.key === key);
  list.unshift({ key, name: tab.displayName, when: Date.now(), uri: tab.uri || undefined, format: tab.format, pinned: old?.pinned });
  app.prefs.recent = [...list.filter((r) => r.pinned), ...list.filter((r) => !r.pinned)].slice(0, 40);
  app.savePrefs();
}

async function snapshot(tab: DocTab, label: string) {
  const b = tab.bytes;
  await kvSet(`snap:${docKey(tab)}:${Date.now()}`, { label, bytes: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), when: Date.now(), name: tab.displayName, password: tab.password });
}

export type SaveMode = 'incremental' | 'rewrite' | 'optimized' | 'flat' | 'qfr';

/** Produces the bytes for a save mode without touching the open document (flat and qfr work on a copy). */
export async function produceBytes(app: App, tab: DocTab, mode: SaveMode): Promise<{ data: Uint8Array; mime: string; ext: string }> {
  const doc = tab.doc;
  if (mode === 'incremental') return { data: doc.buf?.length && !doc.report.reconstructed ? doc.save({ incremental: true }) : doc.save({ incremental: false }), mime: 'application/pdf', ext: 'pdf' };
  if (mode === 'rewrite') return { data: doc.save({ incremental: false }), mime: 'application/pdf', ext: 'pdf' };
  if (mode === 'optimized') return { data: doc.save({ incremental: false, recompress: true, objectStreams: true }), mime: 'application/pdf', ext: 'pdf' };
  if (mode === 'flat') {
    const copy = PdfDocument.load(tab.bytes, { password: tab.password || undefined });
    const { flattenAnnotations } = await import('../pdf/ops/annots');
    const { flattenForm } = await import('../pdf/ops/forms');
    flattenForm(copy);
    for (const p of copy.pages) flattenAnnotations(copy, p);
    return { data: copy.save({ incremental: false }), mime: 'application/pdf', ext: 'pdf' };
  }
  // Review package: the PDF, its comments as XFDF, the audit log and a report.
  const { exportXfdf } = await import('../pdf/ops/annots');
  const { allAnnotations } = await import('../pdf/structure');
  const pdf = doc.save({ incremental: true });
  const annots = allAnnotations(doc).filter((a) => a.subtype !== 'Widget' && a.subtype !== 'Popup' && a.subtype !== 'Link');
  const report = { app: 'Anne\'s Folio', mimeType: 'application/x-quillfolio-review', file: tab.fileName || tab.title, exported: new Date().toISOString(), pages: doc.pageCount, comments: annots.length, authors: [...new Set(annots.map((a) => a.author).filter(Boolean))], audit: (tab as any).audit || [] };
  const data = await zipOf([
    { name: 'mimetype', data: 'application/x-quillfolio-review' },
    { name: `${baseName(app)}.pdf`, data: pdf },
    { name: `${baseName(app)}.xfdf`, data: exportXfdf(doc, tab.fileName) },
    { name: 'report.json', data: JSON.stringify(report, null, 1) },
    { name: 'audit-log.txt', data: ((tab as any).audit || []).map((l: any) => `${new Date(l.when).toISOString()}\t${l.text}`).join('\n') || 'No audited actions.' },
  ]);
  return { data, mime: 'application/x-quillfolio-review', ext: 'qfr' };
}

export async function saveTab(app: App, tab: DocTab, opts: { as?: boolean; copy?: boolean; mode?: SaveMode } = {}): Promise<boolean> {
  const mode: SaveMode = opts.mode || (app.prefs.saveMode === 'rewrite' ? 'rewrite' : 'incremental');
  const out = await produceBytes(app, tab, mode);
  const base = (tab.fileName || tab.title || 'Document').replace(/\.[^.]+$/, '');
  const name = `${base}.${out.ext}`;
  const blob = toBlob(out.data, out.mime);
  const reload = () => {
    if (out.ext !== 'pdf' || opts.copy) return;
    try { const d = PdfDocument.load(out.data, { password: tab.password || undefined }); tab.replace(d, out.data); void tab.ui.reload(); } catch (e) { console.warn('reload after save', e); }
  };
  if (!opts.as && !opts.copy && tab.uri && out.ext === 'pdf') {
    try {
      if (await writeBack(tab.uri, blob)) { reload(); markSaved(app, tab); toast(`Saved ${tab.displayName}`); await snapshot(tab, 'Saved'); return true; }
    } catch (e) { console.warn(e); }
  }
  const r = await saveAs(blob, name);
  if (!r) return false;
  if (!opts.copy && out.ext === 'pdf') {
    tab.fileName = r.name; tab.title = r.name.replace(/\.[^.]+$/, ''); tab.format = 'pdf'; tab.uri = r.uri;
    reload();
    markSaved(app, tab);
    addRecent(app, tab);
    await kvSet('file:' + docKey(tab), { name: r.name, data: out.data.buffer.slice(out.data.byteOffset, out.data.byteOffset + out.data.byteLength), uri: r.uri, when: Date.now() });
    await snapshot(tab, 'Saved');
  }
  toast(`Saved ${r.name}`);
  return true;
}

function markSaved(app: App, tab: DocTab) {
  tab.saved = Date.now();
  tab.dirty = false;
  kvDel('draft:' + tab.id);
  app.ui.tabsChanged();
  document.title = `${tab.displayName} – Anne's Folio`;
}

/** Replaces the active document with freshly written bytes (after a rewrite, encryption or optimization). */
export function replaceWithBytes(app: App, tab: DocTab, bytes: Uint8Array, password = tab.password): void {
  const d = PdfDocument.load(bytes, { password: password || undefined });
  tab.replace(d, bytes);
  tab.password = password;
  tab.dirty = true;
  app.ui.tabsChanged();
  void tab.ui.reload();
  app.refresh();
}

export async function newFromText(app: App, text: string, title: string, opts: { font?: string; size?: number; paper?: [number, number] } = {}): Promise<DocTab> {
  const { addTextPages, PAPER } = await import('../pdf/build');
  const doc = PdfDocument.create();
  addTextPages(doc, text, { title, paper: opts.paper || PAPER.letter, font: (opts.font as any) || 'Helvetica', size: opts.size || 11 });
  const bytes = doc.save({ incremental: false });
  const tab = app.createTab(PdfDocument.load(bytes), { title, fileName: `${title}.pdf` }, bytes);
  tab.dirty = true;
  return tab;
}

def([
  {
    id: 'file.new', label: 'New', icon: 'note_add', tab: 'Backstage', group: 'New', keys: ['Mod-n'], popular: true, noRecord: true,
    tip: 'A new PDF: one blank page, or a template',
    run: (app, arg) => {
      const t = TEMPLATES.find((x) => x.id === arg);
      const prev = app.tab && isPristine(app.tab) ? app.tab : null;
      if (t && t.id !== 'blank') {
        const doc = t.build();
        doc.ensureInfo().set('Author', PdfString.fromText(app.prefs.author || ''));
        const bytes = doc.save({ incremental: false });
        const tab = app.createTab(PdfDocument.load(bytes), { title: t.name, fileName: `${t.name}.pdf` }, bytes);
        tab.dirty = true;
        if (prev) app.closeTab(prev);
        app.activate(tab);
        app.ui.hideBackstage();
        return;
      }
      if (prev) { app.ui.hideBackstage(); app.focus(); return; }
      app.createTab();
      app.tab.dirty = false;
      app.ui.tabsChanged();
      app.ui.hideBackstage();
    },
  },
  { id: 'file.newFromTemplate', label: 'New from Template…', icon: 'library_books', tab: 'Backstage', group: 'New', noRecord: true, run: (app) => app.ui.showBackstage('new') },
  {
    id: 'file.newFromText', label: 'New from Text or Markdown…', icon: 'article', tab: 'Backstage', group: 'New', noRecord: true,
    tip: 'Typeset a .txt, .md or .html file (or pasted text) into pages',
    run: async (app) => {
      const r = await openDialog({ title: 'New from Text', wide: true, fields: [
        { key: 'file', label: 'File (.txt, .md, .html)', type: 'file', accept: '.txt,.md,.markdown,.html,.htm' },
        { key: 'text', label: 'Or paste text (Markdown headings and lists are typeset)', type: 'textarea', rows: 10 },
        { key: 'font', label: 'Font', type: 'select', options: ['Helvetica', 'Times-Roman', 'Courier'], value: 'Helvetica', half: true },
        { key: 'size', label: 'Size (pt)', type: 'number', min: 6, max: 36, value: 11, half: true },
        { key: 'paper', label: 'Paper', type: 'select', options: ['letter', 'a4', 'legal', 'a5'], value: 'letter', half: true },
      ], ok: 'Create' });
      if (!r) return;
      let text = String(r.text || '');
      let title = 'Text';
      const f = r.file as File | undefined;
      if (f && f.size) { text = await f.text(); title = f.name.replace(/\.[^.]+$/, ''); if (/\.html?$/i.test(f.name)) { const { htmlToText } = await import('../io'); text = htmlToText(text); } }
      if (!text.trim()) { toast('There is no text to typeset.'); return; }
      const { PAPER } = await import('../pdf/build');
      await newFromText(app, text, title, { font: r.font, size: +r.size || 11, paper: PAPER[r.paper] });
      app.ui.hideBackstage();
    },
  },
  {
    id: 'file.newFromClipboard', label: 'New from Clipboard', icon: 'content_paste', tab: 'Backstage', group: 'New', noRecord: true,
    tip: 'A PDF from the image or text on the clipboard',
    run: async (app) => {
      let image: Blob | null = null;
      try { const items = await (navigator.clipboard as any).read?.(); for (const it of items || []) { const t = it.types.find((x: string) => x.startsWith('image/')); if (t) { image = await it.getType(t); break; } } } catch { /* no image access */ }
      if (image) {
        const spec = await imageSpecFromBytes(new Uint8Array(await image.arrayBuffer()), image.type === 'image/jpeg' ? 'jpeg' : undefined);
        const { addImagePage } = await import('../pdf/build');
        const doc = PdfDocument.create();
        addImagePage(doc, spec, { paper: 'image' });
        const bytes = doc.save({ incremental: false });
        const tab = app.createTab(PdfDocument.load(bytes), { title: 'Clipboard image', fileName: 'Clipboard image.pdf' }, bytes);
        tab.dirty = true; app.ui.hideBackstage(); return;
      }
      const text = (await readClipboardText()) || app.clip?.text || '';
      if (!text.trim()) { toast('The clipboard has no image or text Anne\'s Folio can use.'); return; }
      await newFromText(app, text, 'Clipboard text');
      app.ui.hideBackstage();
    },
  },
  {
    id: 'file.open', label: 'Open', icon: 'folder_open', tab: 'Backstage', group: 'Open', keys: ['Mod-o', 'Mod-F12'], popular: true, noRecord: true,
    run: async (app) => {
      const f = await openDocument(OPEN_ACCEPT, OPEN_MIMES);
      if (!f) return;
      await openBuffer(app, f.data, f.name, f.uri);
      app.ui.hideBackstage();
    },
  },
  {
    id: 'file.openDropped', label: 'Open Dropped Files', icon: 'file_open', tab: 'Backstage', group: 'Open', internal: true, noRecord: true,
    run: async (app, files: File[]) => { for (const f of files || []) await openBuffer(app, await f.arrayBuffer(), f.name, null); },
  },
  {
    id: 'file.openRepair', label: 'Open and Repair…', icon: 'healing', tab: 'Backstage', group: 'Open', noRecord: true,
    tip: 'Open a damaged PDF: rebuild its cross-reference table, recover objects and pages, and show what was recovered',
    keywords: 'corrupt damaged recover fix broken salvage',
    run: async (app) => {
      const f = await openDocument('*/*', ['*/*']);
      if (!f) return;
      const tab = await openBuffer(app, f.data, f.name, f.uri, { repair: true });
      app.ui.hideBackstage();
      if (tab?.repair) await showRecoveryReport(tab.repair, { open: () => app.activate(tab) });
    },
  },
  {
    id: 'file.recoverAny', label: 'Recover Data from Any File…', icon: 'text_snippet', tab: 'Backstage', group: 'Open', noRecord: true,
    tip: 'Pull PDF pages and readable text out of any file, however damaged',
    keywords: 'corrupt salvage strings extract',
    run: async (app) => { await showManualRecovery({ openDoc: (doc, bytes, name, report) => { const t = app.createTab(doc, { title: name, fileName: `${name}.pdf` }, bytes); t.repair = report; t.dirty = true; } }); },
  },
  {
    id: 'file.recoveryReport', label: 'Repair Report', icon: 'fact_check', tab: 'Backstage', group: 'Open', noRecord: true,
    isEnabled: (app) => !!app.tab?.repair,
    run: async (app) => { const r = app.tab?.repair; if (!r) { toast('This document was not repaired from a damaged file.'); return; } await showRecoveryReport(r, {}); },
  },
  { id: 'file.recoveryHelp', label: 'Manual Recovery Options', icon: 'support', tab: 'Backstage', group: 'Open', noRecord: true, run: () => showManualRecovery() },
  {
    id: 'file.openRecent', label: 'Open Recent File', icon: 'history', tab: 'Backstage', group: 'Open', kind: 'menu', noRecord: true,
    run: async (app, key) => {
      if (!key) return app.ui.showBackstage('open');
      const rec = app.prefs.recent.find((r) => r.key === key);
      if (!rec) return;
      const existing = app.docs.find((d) => docKey(d) === key);
      if (existing) { app.activate(existing); app.ui.hideBackstage(); return; }
      let f = rec.uri ? await readUri(rec.uri) : null;
      if (!f) { const cached = await kvGet('file:' + key); if (cached) f = { name: cached.name, data: cached.data, uri: cached.uri }; }
      if (!f) { toast('That file is no longer available. Use Open to locate it.'); return; }
      await openBuffer(app, f.data, f.name, f.uri, { key });
      app.ui.hideBackstage();
    },
    menu: (app) => app.prefs.recent.length ? app.prefs.recent.slice(0, 12).map((r) => ({ id: 'file.openRecent', arg: r.key, label: (r.pinned ? '📌 ' : '') + r.name })) : [{ label: '(no recent documents)' }],
  },
  { id: 'file.clearRecent', label: 'Clear Unpinned Recent Documents', icon: 'delete_sweep', tab: 'Backstage', group: 'Open', noRecord: true, run: (app) => { app.prefs.recent = app.prefs.recent.filter((r) => r.pinned); app.savePrefs(); app.ui.showBackstage('open'); } },
  {
    id: 'file.openEncrypted', label: 'Open Encrypted PDF…', icon: 'lock_open', tab: 'Backstage', group: 'Open', noRecord: true,
    tip: 'Open a password-protected PDF (Open asks for the password too; this asks first)',
    run: async (app) => {
      const f = await openDocument('.pdf', ['application/pdf']);
      if (!f) return;
      const pw = await promptDialog('Password', `Password for ${f.name}:`, '', { type: 'password' });
      if (pw == null) return;
      await openBuffer(app, f.data, f.name, f.uri, { password: pw });
      app.ui.hideBackstage();
    },
  },
  { id: 'file.save', label: 'Save', icon: 'save', tab: 'Backstage', group: 'Save', keys: ['Mod-s', 'Shift-F12'], popular: true, noRecord: true, tip: 'Appends your changes to the file (the original bytes stay intact); File ▸ Options chooses a full rewrite instead', run: (app) => saveTab(app, app.tab) },
  { id: 'file.saveAs', label: 'Save As', icon: 'save_as', tab: 'Backstage', group: 'Save', keys: ['F12'], popular: true, noRecord: true, run: (app) => app.ui.showBackstage('saveas') },
  { id: 'file.saveCopy', label: 'Save a Copy…', icon: 'file_copy', tab: 'Backstage', group: 'Save', noRecord: true, run: (app) => saveTab(app, app.tab, { copy: true }) },
  { id: 'file.saveAll', label: 'Save All', icon: 'library_add_check', tab: 'Backstage', group: 'Save', noRecord: true, run: async (app) => { for (const d of app.docs) if (d.dirty) { app.activate(d); await saveTab(app, d); } } },
  {
    id: 'file.saveAsFormat', label: 'Save As Format', icon: 'save_as', tab: 'Backstage', group: 'Save', internal: true, noRecord: true,
    run: async (app, format: string) => {
      const mode: SaveMode = format === 'pdf-rewrite' ? 'rewrite' : format === 'pdf-optimized' ? 'optimized' : format === 'pdf-flat' ? 'flat' : format === 'qfr' ? 'qfr' : 'incremental';
      await saveTab(app, app.tab, { as: true, mode, copy: mode === 'flat' || mode === 'qfr' });
      app.ui.hideBackstage();
    },
  },
  { id: 'file.saveRewrite', label: 'Save As Rewritten PDF', icon: 'cleaning_services', tab: 'Backstage', group: 'Save', noRecord: true, tip: 'A clean, renumbered file without earlier versions or unused objects', run: (app) => app.exec('file.saveAsFormat', 'pdf-rewrite') },
  { id: 'file.saveFlat', label: 'Save Flattened Copy', icon: 'layers_clear', tab: 'Backstage', group: 'Save', noRecord: true, tip: 'Comments and form fields become part of the page', run: (app) => app.exec('file.saveAsFormat', 'pdf-flat') },
  { id: 'file.saveReviewPackage', label: 'Save Review Package (.qfr)', icon: 'inventory_2', tab: 'Backstage', group: 'Save', noRecord: true, tip: 'The PDF with its comments, audit log and report in one ZIP', run: (app) => app.exec('file.saveAsFormat', 'qfr') },
  { id: 'file.autosave', label: 'AutoSave', icon: 'autorenew', tab: 'Backstage', group: 'Save', kind: 'toggle', noRecord: true, run: (app) => { app.prefs.autosave = !app.prefs.autosave; app.savePrefs(); toast(app.prefs.autosave ? 'AutoSave on (drafts saved automatically)' : 'AutoSave off'); }, isActive: (app) => app.prefs.autosave },
  {
    id: 'file.revert', label: 'Revert to Saved', icon: 'settings_backup_restore', tab: 'Backstage', group: 'Info', noRecord: true,
    run: async (app) => {
      const tab = app.tab;
      const cached = await kvGet('file:' + docKey(tab));
      if (!cached) { toast('No saved version to revert to.'); return; }
      if (!(await confirmDialog('Revert', 'Discard all changes since the last save?'))) return;
      const bytes = new Uint8Array(cached.data);
      tab.replace(PdfDocument.load(bytes, { password: tab.password || undefined }), bytes);
      tab.dirty = false; app.ui.tabsChanged(); void tab.ui.reload(); app.refresh();
    },
  },
]);

// Exports -------------------------------------------------------------------------------------

async function allPageText(app: App): Promise<string[]> {
  const v = app.viewer;
  const out: string[] = [];
  for (let i = 0; i < app.doc.pageCount; i++) out.push(await v.pageText(i));
  return out;
}

def([
  {
    id: 'file.export.images', label: 'Export Pages as Images…', icon: 'image', tab: 'Backstage', group: 'Export', noRecord: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Export Pages as Images', fields: [
        { key: 'format', label: 'Format', type: 'select', options: [{ value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPEG' }], value: 'png', half: true },
        { key: 'dpi', label: 'Resolution (dpi)', type: 'number', min: 36, max: 600, value: 150, half: true },
        { key: 'which', label: 'Pages', type: 'radio', options: [{ value: 'current', label: 'Current page' }, { value: 'range', label: 'Range' }, { value: 'all', label: 'All pages (one ZIP file)' }], value: 'current' },
        { ...rangeField(app), visibleIf: (v) => v.which === 'range' },
      ], ok: 'Export' });
      if (!r) return;
      const pages = r.which === 'all' ? app.doc.pages.map((_, i) => i) : r.which === 'range' ? pagesFromRange(app, r.range) : [app.page];
      const ext = r.format === 'png' ? 'png' : 'jpg';
      if (pages.length === 1) { const b = await pageImage(app, pages[0], +r.dpi || 150, r.format); await saveBytes(new Uint8Array(await b.arrayBuffer()), `${baseName(app)} page ${pages[0] + 1}.${ext}`, b.type); return; }
      const files: { name: string; data: Uint8Array }[] = [];
      for (const i of pages) { app.ui.status?.(`● Rendering page ${i + 1}…`); const b = await pageImage(app, i, +r.dpi || 150, r.format); files.push({ name: `${baseName(app)} page ${String(i + 1).padStart(3, '0')}.${ext}`, data: new Uint8Array(await b.arrayBuffer()) }); }
      app.ui.status?.('');
      await saveBytes(await zipOf(files), `${baseName(app)} pages.zip`, 'application/zip');
    },
  },
  { id: 'file.export.text', label: 'Export Text', icon: 'notes', tab: 'Backstage', group: 'Export', noRecord: true, tip: 'The text of every page as a .txt file', run: async (app) => { const t = await allPageText(app); await saveBytes(t.map((p, i) => `${p}\n\n--- page ${i + 1} ---\n\n`).join(''), `${baseName(app)}.txt`, 'text/plain'); } },
  {
    id: 'file.export.markdown', label: 'Export Markdown', icon: 'markdown', tab: 'Backstage', group: 'Export', noRecord: true, tip: 'Headings guessed from font sizes',
    run: async (app) => { const { pageTextRuns, textToMarkdown } = await import('../pdf/ops/extract'); const pages = app.doc.pages.map((_, i) => pageTextRuns(app.doc, i)); let md = textToMarkdown(pages); if (!md.trim()) md = (await allPageText(app)).join('\n\n'); await saveBytes(md, `${baseName(app)}.md`, 'text/markdown'); },
  },
  {
    id: 'file.export.html', label: 'Export HTML', icon: 'html', tab: 'Backstage', group: 'Export', noRecord: true, tip: 'One web page with the text of every page',
    run: async (app) => {
      const t = await allPageText(app);
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(app.tab.title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:48em;margin:2em auto;padding:0 1em}section{border-top:1px solid #ccc;padding-top:1em}h2{font-size:.8em;color:#888}</style></head><body><h1>${esc(app.tab.title)}</h1>${t.map((p, i) => `<section><h2>Page ${i + 1}</h2>${p.split(/\n{2,}/).map((para) => `<p>${esc(para).replace(/\n/g, '<br>')}</p>`).join('')}</section>`).join('')}</body></html>`;
      await saveBytes(html, `${baseName(app)}.html`, 'text/html');
    },
  },
]);

// Print, share, close ------------------------------------------------------------------------

def([
  { id: 'file.print', label: 'Print…', icon: 'print', tab: 'Backstage', group: 'Print', keys: ['Mod-p'], popular: true, noRecord: true, run: async (app) => { app.ui.hideBackstage(); const { printDialog } = await import('../export/print'); await printDialog(app); } },
  { id: 'file.quickPrint', label: 'Quick Print', icon: 'print', tab: 'Backstage', group: 'Print', noRecord: true, tip: 'Print every page with the current settings, without the dialog', run: async (app) => { const { printPages } = await import('../export/print'); await printPages(app); } },
  {
    id: 'file.share', label: 'Share', icon: 'share', tab: 'Backstage', group: 'Share', popular: true, noRecord: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Share', fields: [{ key: 'mode', label: 'Send', type: 'radio', options: [{ value: 'incremental', label: 'PDF as it is (with comments and fields)' }, { value: 'flat', label: 'Flattened PDF (comments and fields baked in)' }, { value: 'optimized', label: 'Optimized PDF (smallest)' }, { value: 'qfr', label: 'Review package (.qfr)' }], value: 'incremental' }] });
      if (!r) return;
      const out = await produceBytes(app, app.tab, r.mode);
      await shareFile(toBlob(out.data, out.mime), `${baseName(app)}.${out.ext}`, app.tab.title);
    },
  },
  { id: 'file.shareFlat', label: 'Share Flattened Copy', icon: 'layers_clear', tab: 'Backstage', group: 'Share', noRecord: true, run: async (app) => { const out = await produceBytes(app, app.tab, 'flat'); await shareFile(toBlob(out.data, out.mime), `${baseName(app)} (flattened).pdf`, app.tab.title); } },
  { id: 'file.email', label: 'Email', icon: 'attach_email', tab: 'Backstage', group: 'Share', noRecord: true, tip: 'Send the PDF as an attachment (uses the system share sheet, which includes your mail app and Anne\'s Post when installed)', run: async (app) => { const out = await produceBytes(app, app.tab, 'incremental'); await shareFile(toBlob(out.data, out.mime), `${baseName(app)}.pdf`, app.tab.title); } },
  {
    id: 'file.close', label: 'Close', icon: 'close', tab: 'Backstage', group: 'Close', keys: ['Mod-w', 'Mod-F4'], popular: true, noRecord: true,
    run: async (app, arg) => {
      const tab = app.docs.find((d) => d.id === arg) || app.tab;
      if (tab.dirty && app.prefs.confirmClose) {
        const c = await choiceDialog('Save Changes?', `Save changes to "${tab.displayName}" before closing?`, ['Save', "Don't Save"]);
        if (c < 0) return;
        if (c === 0 && !(await saveTab(app, tab))) return;
      }
      app.closeTab(tab);
      app.ui.hideBackstage();
    },
  },
  { id: 'file.closeAll', label: 'Close All', icon: 'tab_close', tab: 'Backstage', group: 'Close', noRecord: true, run: async (app) => { for (const d of [...app.docs]) { app.activate(d); await app.exec('file.close', d.id); } } },
  {
    id: 'file.exit', label: 'Exit', icon: 'logout', tab: 'Backstage', group: 'Close', noRecord: true,
    run: async (app) => {
      for (const d of [...app.docs]) if (d.dirty) { app.activate(d); await app.exec('file.close', d.id); if (app.docs.includes(d)) return; }
      await app.saveDrafts();
      if (isDesktop()) { window.close(); return; }
      try { const { App: CapApp } = await import('@capacitor/app'); await CapApp.exitApp(); } catch { window.close(); }
    },
  },
]);

// Info ---------------------------------------------------------------------------------------

def([
  {
    id: 'file.properties', label: 'Properties…', icon: 'info', tab: 'Backstage', group: 'Info', noRecord: true, edits: false,
    tip: 'Title, author, subject, keywords, custom properties and the XMP metadata',
    run: async (app) => {
      const m = readMetadata(app.doc);
      const ro = app.isReadOnly();
      const r = await openDialog({ title: 'Document Properties', wide: true, fields: [
        { key: 'title', label: 'Title', type: 'text', value: m.title }, { key: 'subject', label: 'Subject', type: 'text', value: m.subject },
        { key: 'author', label: 'Author', type: 'text', value: m.author, half: true }, { key: 'keywords', label: 'Keywords', type: 'text', value: m.keywords, half: true },
        { key: 'creator', label: 'Creator (application)', type: 'text', value: m.creator, half: true }, { key: 'producer', label: 'Producer', type: 'text', value: m.producer, half: true },
        { key: 'language', label: 'Language (BCP 47, e.g. en-US)', type: 'text', value: m.language, half: true },
        { key: 'custom', label: 'Custom properties (name=value per line)', type: 'textarea', rows: 3, value: Object.entries(m.custom).map(([k, x]) => `${k}=${x}`).join('\n') },
        { key: 'stats', type: 'info', html: `<p class="ql-help">Created: ${m.created ? m.created.toLocaleString() : '—'} · Modified: ${m.modified ? m.modified.toLocaleString() : '—'} · PDF ${esc(app.doc.report.header || '?')} · ${app.doc.pageCount} page(s) · ${(app.tab.bytes.length / 1024).toFixed(0)} KB · ${app.doc.security ? 'encrypted' : 'not encrypted'}${app.doc.usesXrefStream ? ' · cross-reference stream' : ''}</p>` },
        { key: 'bx', type: 'button', label: 'Edit XMP metadata…', onClick: (_v, ctl) => { ctl.close(null); app.exec('tools.editXmp'); } },
      ], ok: ro ? false : 'Save' });
      if (!r || ro) return;
      app.edit('Properties', (doc) => writeMetadata(doc, { title: r.title, subject: r.subject, author: r.author, keywords: r.keywords, creator: r.creator, producer: r.producer, language: r.language, custom: Object.fromEntries(String(r.custom).split('\n').map((l) => l.split('=')).filter((x) => x[0]?.trim()).map(([k, ...rest]) => [k.trim(), rest.join('=').trim()])) }));
      app.tab.title = r.title || app.tab.title;
      app.ui.tabsChanged();
    },
  },
  {
    id: 'file.alwaysReadOnly', label: 'Always Open Read-Only', icon: 'lock', tab: 'Backstage', group: 'Info', kind: 'toggle', noRecord: true, edits: false,
    tip: 'Mark the document so Anne\'s Folio opens it read-only (a document property; other readers ignore it)',
    isActive: (app) => !!app.doc?.info && app.doc.getText(app.doc.info, 'QuillFolioReadOnly') === 'true',
    run: (app) => {
      const on = app.doc.info ? app.doc.getText(app.doc.info, 'QuillFolioReadOnly') === 'true' : false;
      app.tab.readOnly = false;
      app.edit('Always Open Read-Only', (doc) => { const info = doc.ensureInfo(); if (on) info.delete('QuillFolioReadOnly'); else info.set('QuillFolioReadOnly', PdfString.fromText('true')); });
      app.tab.readOnly = !on;
      toast(on ? 'The document opens for editing again.' : 'The document is read-only here; File ▸ Always Open Read-Only turns it off.');
      app.refresh();
    },
  },
  { id: 'file.versions', label: 'Version History', icon: 'history', tab: 'Backstage', group: 'Info', popular: true, noRecord: true, run: (app) => { app.ui.hideBackstage(); app.ui.openPane('versions'); } },
  { id: 'file.snapshot', label: 'Take Snapshot', icon: 'add_a_photo', tab: 'Backstage', group: 'Info', keys: ['Mod-Alt-5'], noRecord: true, run: async (app) => { const label = await promptDialog('Take Snapshot', 'Snapshot name', `Snapshot ${new Date().toLocaleString()}`); if (label) { await snapshot(app.tab, label); toast('Snapshot saved'); } } },
  {
    id: 'file.recoverUnsaved', label: 'Recover Unsaved Documents', icon: 'restore_page', tab: 'Backstage', group: 'Info', noRecord: true,
    run: async (app) => {
      const keys = (await kvKeys('draft:')).filter((k) => !app.docs.some((d) => 'draft:' + d.id === k));
      if (!keys.length) { toast('No unsaved drafts found.'); return; }
      const drafts = await Promise.all(keys.map(async (k) => ({ k, d: await kvGet(k) })));
      const r = await openDialog({ title: 'Document Recovery', fields: [{ key: 'k', label: 'Available drafts', type: 'list', multiple: true, rows: 8, options: drafts.map(({ k, d }) => ({ value: k, label: `${d.fileName || d.title} — ${new Date(d.time).toLocaleString()}` })), value: keys }], buttons: [{ label: 'Discard All', onClick: async (_v, ctl) => { for (const k of keys) await kvDel(k); ctl.close(); toast('Drafts discarded'); } }], ok: 'Recover' });
      if (!r?.k?.length) return;
      for (const { k, d } of drafts.filter((x) => r.k.includes(x.k))) {
        try {
          const bytes = new Uint8Array(d.bytes);
          const tab = app.createTab(PdfDocument.load(bytes, { password: d.password || undefined }), { title: d.title, fileName: d.fileName, uri: d.uri, key: d.key || '', password: d.password || '' }, bytes);
          tab.dirty = true;
          await kvDel(k);
        } catch (e) { toast(`Could not restore ${d.title}: ${(e as Error).message}`); }
      }
    },
  },
]);

// Options ------------------------------------------------------------------------------------

def([
  {
    id: 'file.options', label: 'Options…', icon: 'settings', tab: 'Backstage', group: 'Options', popular: true, noRecord: true,
    run: async (app) => {
      const p = app.prefs;
      const { SPELL_DIALECTS } = await import('../proof/proofing');
      const r = await openDialog({ title: 'Anne\'s Folio Options', wide: true, fields: [
        { key: 'h1', type: 'heading', label: 'General' },
        { key: 'author', label: 'User name (comment author)', type: 'text', value: p.author, half: true },
        { key: 'initials', label: 'Initials', type: 'text', value: p.initials, half: true },
        { key: 'theme', label: 'App theme', type: 'select', options: ['system', 'light', 'dark'], value: p.theme, half: true },
        { key: 'uiScale', label: 'Toolbar size', type: 'select', options: [{ value: '0.85', label: 'Compact' }, { value: '1', label: 'Normal' }, { value: '1.15', label: 'Large (touch)' }], value: String(p.uiScale), half: true },
        { key: 'qatPosition', label: 'Quick Access Bar', type: 'select', options: [{ value: 'top', label: 'Above the ribbon' }, { value: 'below', label: 'Below the ribbon' }, { value: 'bottom', label: 'At the bottom (near keyboard)' }], value: p.qatPosition, half: true },
        { key: 'qatLabels', label: 'Show labels on Quick Access Bar', type: 'checkbox', value: p.qatLabels, half: true },
        { key: 'h2', type: 'heading', label: 'Viewing' },
        { key: 'viewMode', label: 'Page layout for new windows', type: 'select', options: [{ value: 'continuous', label: 'Continuous' }, { value: 'single', label: 'Single page' }, { value: 'facing', label: 'Facing pages' }, { value: 'book', label: 'Book (cover alone)' }], value: p.viewMode, half: true },
        { key: 'defaultZoom', label: 'Default zoom', type: 'select', options: [{ value: 'fit-width', label: 'Fit width' }, { value: 'fit-page', label: 'Fit page' }, { value: 'actual', label: 'Actual size' }], value: p.defaultZoom, half: true },
        { key: 'showThumbnails', label: 'Show the page thumbnails rail', type: 'checkbox', value: p.showThumbnails, half: true },
        { key: 'smoothScroll', label: 'Smooth scrolling', type: 'checkbox', value: p.smoothScroll, half: true },
        { key: 'renderDpiCap', label: 'Rendering sharpness (device pixel ratio cap)', type: 'number', min: 1, max: 4, step: 0.5, value: p.renderDpiCap, half: true },
        { key: 'highlightFields', label: 'Highlight form fields', type: 'checkbox', value: p.highlightFields, half: true },
        { key: 'h3', type: 'heading', label: 'Commenting' },
        { key: 'highlightColor', label: 'Highlight color', type: 'color', value: p.highlightColor, half: true },
        { key: 'penColor', label: 'Pen color', type: 'color', value: p.penColor, half: true },
        { key: 'penWidth', label: 'Pen width (pt)', type: 'number', min: 0.5, max: 24, step: 0.5, value: p.penWidth, half: true },
        { key: 'noteColor', label: 'Note color', type: 'color', value: p.noteColor, half: true },
        { key: 'stampOpacity', label: 'Stamp opacity', type: 'range', min: 0.1, max: 1, step: 0.05, value: p.stampOpacity, half: true },
        { key: 'measureUnit', label: 'Measurement unit', type: 'select', options: ['pt', 'in', 'mm', 'cm'], value: p.measureUnit, half: true },
        { key: 'h4', type: 'heading', label: 'Saving and printing' },
        { key: 'saveMode', label: 'Save writes', type: 'select', options: [{ value: 'incremental', label: 'An incremental update (keeps the original bytes and signatures)' }, { value: 'rewrite', label: 'A full rewrite (clean, smaller, drops earlier versions)' }], value: p.saveMode },
        { key: 'autosave', label: 'AutoSave drafts', type: 'checkbox', value: p.autosave, half: true },
        { key: 'autosaveSeconds', label: 'Every (seconds)', type: 'number', value: p.autosaveSeconds, half: true },
        { key: 'confirmClose', label: 'Ask to save when closing', type: 'checkbox', value: p.confirmClose, half: true },
        { key: 'printDpi', label: 'Print resolution (dpi)', type: 'number', min: 72, max: 600, value: p.printDpi, half: true },
        { key: 'h5', type: 'heading', label: 'Proofing and OCR' },
        { key: 'spellDialect', label: 'English spelling', type: 'select', options: SPELL_DIALECTS, value: p.spellDialect || 'any', half: true },
        { key: 'ocrLanguage', label: 'OCR language codes (e.g. eng, eng+deu)', type: 'text', value: p.ocrLanguage, half: true },
        { key: 'h6', type: 'heading', label: 'Customize' },
        { key: 'bq', type: 'button', label: 'Customize Quick Access Bar…', onClick: () => app.exec('file.customizeQat') },
        { key: 'br', type: 'button', label: 'Customize Tabs (Ribbon)…', onClick: () => app.exec('file.customizeRibbon') },
        { key: 'bk', type: 'button', label: 'Customize Keyboard…', onClick: () => app.exec('file.customizeKeyboard') },
        { key: 'bd', type: 'button', label: 'Custom Dictionary…', onClick: () => app.exec('file.customDictionary') },
        { key: 'bx', type: 'button', label: 'Export / Import All Settings…', onClick: () => app.exec('file.exportSettings') },
      ] });
      if (!r) return;
      Object.assign(p, {
        author: r.author || 'Author', initials: r.initials || (r.author || 'A')[0], theme: r.theme, uiScale: parseFloat(r.uiScale), qatPosition: r.qatPosition, qatLabels: r.qatLabels,
        viewMode: r.viewMode, defaultZoom: r.defaultZoom, showThumbnails: r.showThumbnails, smoothScroll: r.smoothScroll, renderDpiCap: Math.max(1, Math.min(4, +r.renderDpiCap || 2)), highlightFields: r.highlightFields,
        highlightColor: r.highlightColor, penColor: r.penColor, penWidth: Math.max(0.5, +r.penWidth || 2), noteColor: r.noteColor, stampOpacity: +r.stampOpacity || 0.85, measureUnit: r.measureUnit,
        saveMode: r.saveMode, autosave: r.autosave, autosaveSeconds: Math.max(3, r.autosaveSeconds || 10), confirmClose: r.confirmClose, printDpi: Math.max(72, +r.printDpi || 150),
        spellDialect: r.spellDialect, ocrLanguage: String(r.ocrLanguage || 'eng').trim() || 'eng',
      });
      app.savePrefs();
      app.ui.applyPrefs();
      for (const d of app.docs) d.ui.layout();
      app.refresh();
    },
  },
  { id: 'file.customizeQat', label: 'Customize Quick Access Bar…', icon: 'tune', tab: 'Backstage', group: 'Options', popular: true, noRecord: true, run: (app) => app.ui.customizeQat() },
  { id: 'file.customizeRibbon', label: 'Customize Tabs…', icon: 'view_quilt', tab: 'Backstage', group: 'Options', noRecord: true, run: (app) => app.ui.customizeRibbon() },
  { id: 'file.customizeKeyboard', label: 'Customize Keyboard…', icon: 'keyboard', tab: 'Backstage', group: 'Options', noRecord: true, run: (app) => app.ui.customizeKeyboard() },
  {
    id: 'file.customDictionary', label: 'Custom Dictionary…', icon: 'book', tab: 'Backstage', group: 'Options', noRecord: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Custom Dictionary', fields: [{ key: 'words', label: 'Words (one per line)', type: 'textarea', rows: 12, value: app.prefs.dictionary.join('\n') }, { key: 'ign', label: 'Ignored words (one per line)', type: 'textarea', rows: 4, value: app.prefs.ignoredWords.join('\n') }] });
      if (!r) return;
      app.prefs.dictionary = String(r.words).split('\n').map((w) => w.trim()).filter(Boolean);
      app.prefs.ignoredWords = String(r.ign).split('\n').map((w) => w.trim()).filter(Boolean);
      app.savePrefs();
    },
  },
  {
    id: 'file.exportSettings', label: 'Export / Import Settings…', icon: 'import_export', tab: 'Backstage', group: 'Options', noRecord: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Settings Transfer', help: 'Copy this text to back up your Quick Access Bar, custom tabs, shortcuts, macros and preferences. Paste settings text here and choose Import to restore. The format is shared with the other Anne\'s Office apps; settings that do not apply to Anne\'s Folio are ignored.', fields: [{ key: 'json', label: 'Settings (JSON)', type: 'textarea', rows: 12, value: JSON.stringify({ ...app.prefs, recent: [] }, null, 1) }], ok: 'Import', buttons: [{ label: 'Copy', onClick: (x) => { navigator.clipboard?.writeText(x.json); toast('Copied'); } }] });
      if (!r) return;
      let p: unknown;
      try { p = JSON.parse(r.json); } catch { /* reported below */ }
      if (!p || typeof p !== 'object' || Array.isArray(p)) { toast('That is not valid settings JSON.'); return; }
      const before = JSON.parse(JSON.stringify(app.prefs));
      Object.assign(app.prefs, sanitizePrefs(p), { recent: app.prefs.recent });
      try { app.ui.applyPrefs(); app.ui.rebuild(); } catch (e: any) {
        Object.assign(app.prefs, before); app.ui.applyPrefs(); app.ui.rebuild();
        toast(`These settings could not be applied: ${e?.message || e}`);
        return;
      }
      app.savePrefs();
      toast('Settings imported');
    },
  },
  { id: 'file.resetCustomizations', label: 'Reset All Customizations', icon: 'restart_alt', tab: 'Backstage', group: 'Options', noRecord: true, run: async (app) => { if (!(await confirmDialog('Reset', 'Reset the Quick Access Bar, custom tabs and keyboard shortcuts to defaults?'))) return; const { DEFAULT_QAT } = await import('../prefs'); app.prefs.qat = [...DEFAULT_QAT]; app.prefs.customTabs = []; app.prefs.hiddenTabs = []; app.prefs.tabOrder = []; app.prefs.keymap = {}; app.savePrefs(); app.ui.rebuild(); } },
]);

export { FORMATS, docCopy, Name };
