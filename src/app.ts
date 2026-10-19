/**
 * QuillFolio application core: document tabs, command execution, undo/redo of engine edits,
 * macro recording and draft autosave. Each tab holds one PdfDocument (the engine's object graph,
 * the document of record) and the bytes the viewer renders from.
 */
import { isSafeExternalUrl } from './util/sanitize';
import { PdfDocument } from './pdf/document';
import { cloneObj, PdfObj, Dict } from './pdf/objects';
import { getCommand, allCommands, type Command } from './commands/registry';
import { loadPrefs, savePrefs, type Prefs } from './prefs';
import { kvSet, kvDel } from './util/store';
import { toast } from './ui/dialog';
import { canonicalKey } from './util/keys';
import type { Shell } from './ui/shell';
import type { Viewer } from './view/viewer';
import type { RepairReport } from './pdf/repair';

let tabCounter = 0;

export type ViewMode = 'continuous' | 'single' | 'facing' | 'book';
export type Tool = 'hand' | 'select' | 'zoom' | 'snapshot' | 'note' | 'highlight' | 'underline' | 'strikeout' | 'squiggly' | 'freetext' | 'callout' | 'square' | 'circle' | 'line' | 'arrow' | 'polygon' | 'polyline' | 'cloud' | 'ink' | 'highlighter' | 'eraser' | 'stamp' | 'link' | 'redact' | 'measure' | 'measureArea' | 'field-text' | 'field-checkbox' | 'field-radio' | 'field-combo' | 'field-list' | 'field-button' | 'field-signature' | 'field-date' | 'image' | 'text' | 'edit' | 'sign' | 'attach' | 'erase' | 'crop';

interface Snapshot { label: string; changed: Map<number, PdfObj | null>; trailer: Dict; nextNum: number }

/** The view mounted for a tab (view/viewer.ts). */
export interface TabView {
  el: HTMLElement;
  layout(): void;
  /** Re-renders after the document bytes changed. */
  reload(): Promise<void>;
  focus(): void;
  destroy(): void;
  readonly zoom: number;
  setZoom(z: number | 'fit-width' | 'fit-page' | 'actual'): void;
  goToPage(i: number, y?: number): void;
  readonly page: number;
  readonly selectedText: string;
  readonly selectionRects: { page: number; rects: [number, number, number, number][] } | null;
  /** Selected annotation (object number) on the current page. */
  selectedAnnot: { page: number; num: number } | null;
  setTool(t: Tool, opts?: any): void;
  readonly tool: Tool;
  pageText(i: number): Promise<string>;
  search(q: string, opts?: { caseSensitive?: boolean; wholeWord?: boolean }): Promise<{ page: number; count: number }[]>;
  findNext(dir: 1 | -1): void;
  clearSearch(): void;
  renderPagePng(i: number, dpi: number): Promise<Blob>;
  refreshAnnotations(): void;
}

export class DocTab {
  id = `t${Date.now().toString(36)}${tabCounter++}`;
  title = 'Document';
  fileName = '';
  format = 'pdf';
  uri: string | null = null;
  dirty = false;
  created = Date.now();
  saved = 0;
  readOnly = false;
  key = '';
  password = '';
  view: ViewMode;
  el!: HTMLElement;
  ui!: TabView;
  repair: RepairReport | null = null;
  /** The bytes the viewer shows (original file, or the document with its edits applied). */
  bytes: Uint8Array;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  /** Form-fill mode: clicking a field opens its editor. */
  fillMode = true;
  /** Page content selected with the Edit tool: a text run or an image (content-stream operator index). */
  selection: { kind: 'run' | 'image'; page: number; index: number; box: [number, number, number, number]; text?: string } | null = null;
  constructor(public app: App, public doc: PdfDocument, bytes?: Uint8Array) {
    this.view = app.prefs.viewMode;
    this.bytes = bytes || doc.save({ incremental: false });
  }
  get displayName(): string { return this.fileName || this.title; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get undoLabel(): string { return this.undoStack[this.undoStack.length - 1]?.label || ''; }
  get redoLabel(): string { return this.redoStack[this.redoStack.length - 1]?.label || ''; }

  private snapshot(label: string): Snapshot {
    const changed = new Map<number, PdfObj | null>();
    for (const [k, v] of this.doc.changed) changed.set(k, v === null ? null : cloneObj(v));
    return { label, changed, trailer: cloneObj(this.doc.trailer) as Dict, nextNum: this.doc.size };
  }
  private restore(s: Snapshot): void {
    const d = this.doc as any;
    d.changed = s.changed;
    d.trailer = s.trailer;
    d.nextNum = s.nextNum;
    d.cache.clear(); d.objStmCache.clear(); d.pageCache = null;
    this.doc.dirty = true;
  }
  /** Runs an edit as one undoable step and refreshes the viewer bytes. */
  edit<T>(label: string, fn: () => T): T {
    const before = this.snapshot(label);
    let r: T;
    try { r = fn(); }
    catch (e) { this.restore(before); throw e; }
    this.undoStack.push(before);
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack = [];
    this.afterChange();
    return r;
  }
  undo(): boolean {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.redoStack.push(this.snapshot(s.label));
    this.restore(s);
    this.afterChange();
    return true;
  }
  redo(): boolean {
    const s = this.redoStack.pop();
    if (!s) return false;
    this.undoStack.push(this.snapshot(s.label));
    this.restore(s);
    this.afterChange();
    return true;
  }
  clearHistory(): void { this.undoStack = []; this.redoStack = []; }
  /** Rebuilds the viewer bytes from the engine and marks the tab dirty. */
  afterChange(): void {
    try { this.bytes = this.doc.save({ incremental: this.app.prefs.saveMode !== 'rewrite' || !!this.doc.security }); }
    catch (e) { console.error(e); toast(`Could not apply the change: ${(e as any)?.message || e}`); }
    this.app.docChanged(this);
  }
  /** Replaces the engine document (after a save or a rewrite). */
  replace(doc: PdfDocument, bytes: Uint8Array): void { this.doc = doc; this.bytes = bytes; this.clearHistory(); }
}

export class App {
  prefs: Prefs = loadPrefs();
  docs: DocTab[] = [];
  active!: DocTab;
  ui!: Shell;
  recording: { name: string; steps: { id: string; arg?: any }[] } | null = null;
  recordingPaused = false;
  private refreshQueued = false;
  private autosaveTimer: any = null;
  private listeners = new Set<(app: App) => void>();
  lastCommand: { id: string; arg?: any } | null = null;
  keyIndex = new Map<string, string>();
  /** Copied text or image (for Paste into a new document). */
  clip: { text?: string; image?: { data: Uint8Array; mime: string; width: number; height: number } } | null = null;

  constructor(public host: HTMLElement) { this.rebuildKeyIndex(); }

  get tab(): DocTab { return this.active; }
  get doc(): PdfDocument { return this.active.doc; }
  get viewer(): Viewer { return this.active.ui as unknown as Viewer; }
  /** Current page index. */
  get page(): number { return this.active?.ui?.page ?? 0; }

  onRefresh(fn: (app: App) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  savePrefs(): void { savePrefs(this.prefs); this.rebuildKeyIndex(); }

  rebuildKeyIndex(): void {
    this.keyIndex.clear();
    for (const c of allCommands()) for (const k of c.keys || []) this.keyIndex.set(canonicalKey(k), c.id);
    for (const [k, id] of Object.entries(this.prefs.keymap)) { if (id) this.keyIndex.set(canonicalKey(k), id); else this.keyIndex.delete(canonicalKey(k)); }
  }

  // ------------------------------------------------------------------------------------------
  // Tabs

  createTab(doc?: PdfDocument, meta: Partial<DocTab> = {}, bytes?: Uint8Array): DocTab {
    if (!doc) {
      doc = PdfDocument.create();
      const { addBlankPage } = requireBuild();
      addBlankPage(doc);
      bytes = doc.save({ incremental: false });
      doc = PdfDocument.load(bytes);
    }
    const tab = new DocTab(this, doc, bytes);
    Object.assign(tab, meta);
    this.ui.mountTab(tab);
    this.docs.push(tab);
    this.activate(tab);
    return tab;
  }

  activate(tab: DocTab): void {
    this.active = tab;
    for (const d of this.docs) d.el.classList.toggle('ql-hidden-tab', d !== tab);
    this.ui.tabsChanged();
    tab.ui.layout();
    this.refresh();
    document.title = `${tab.displayName}${tab.dirty ? ' •' : ''} – QuillFolio`;
  }

  closeTab(tab: DocTab): void {
    const i = this.docs.indexOf(tab);
    if (i < 0) return;
    tab.ui.destroy();
    tab.el.remove();
    this.docs.splice(i, 1);
    kvDel('draft:' + tab.id);
    if (!this.docs.length) this.createTab();
    else this.activate(this.docs[Math.max(0, i - 1)]);
  }

  /** Called after every edit, undo and redo. */
  docChanged(tab: DocTab): void {
    if (!tab.dirty) { tab.dirty = true; this.ui.tabsChanged(); document.title = `${tab.displayName} • – QuillFolio`; }
    this.scheduleAutosave();
    void tab.ui.reload();
    this.refresh();
  }

  /** The edit helper commands use: one undoable step on the active document. */
  edit<T>(label: string, fn: (doc: PdfDocument, tab: DocTab) => T): T | undefined {
    const t = this.active;
    if (!t) return undefined;
    if (this.isReadOnly()) { toast('This document is read-only.'); return undefined; }
    return t.edit(label, () => fn(t.doc, t));
  }

  refresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    requestAnimationFrame(() => {
      this.refreshQueued = false;
      if (!this.active) return;
      this.ui.refresh();
      for (const l of this.listeners) l(this);
    });
  }

  // ------------------------------------------------------------------------------------------
  // Commands

  handleKey(key: string): boolean {
    const id = this.keyIndex.get(canonicalKey(key));
    if (!id) return false;
    const c = getCommand(id);
    if (!c) return false;
    if (c.isEnabled && !c.isEnabled(this)) return false;
    this.exec(id);
    return true;
  }

  isReadOnly(): boolean { return !!this.tab?.readOnly; }

  exec(id: string, arg?: any): unknown {
    const c = getCommand(id);
    if (!c) { toast(`Unknown command: ${id}`); return false; }
    if (c.edits && this.isReadOnly()) { toast('This document is read-only.'); return false; }
    if (c.isEnabled && !c.isEnabled(this)) { toast(`${c.label} is not available here.`); return false; }
    if (this.recording && !c.noRecord && id !== 'dev.recordMacro' && id !== 'dev.stopRecording') this.recordStep(id, arg);
    if (!c.noRecord && id !== 'edit.repeat') this.lastCommand = { id, arg };
    try {
      const r = c.run(this, arg);
      if (r instanceof Promise) r.catch((e) => this.reportError(c, e)).finally(() => this.refresh());
      this.refresh();
      return r;
    } catch (e) {
      this.reportError(c, e);
      return false;
    }
  }

  private reportError(c: Command, e: unknown): void {
    console.error(e);
    toast(`${c.label}: ${(e as any)?.message || e}`, { ms: 6000 });
  }

  recordStep(id: string, arg?: any): void {
    if (!this.recording || this.recordingPaused) return;
    this.recording.steps.push(arg === undefined ? { id } : { id, arg: JSON.parse(JSON.stringify(arg)) });
  }

  // ------------------------------------------------------------------------------------------
  // Autosave and drafts

  scheduleAutosave(): void {
    if (!this.prefs.autosave || this.autosaveTimer) return;
    this.autosaveTimer = setTimeout(() => { this.autosaveTimer = null; void this.saveDrafts(); }, Math.max(3, this.prefs.autosaveSeconds) * 1000);
  }

  async saveDrafts(): Promise<void> {
    for (const tab of this.docs) {
      if (!tab.dirty) continue;
      try { await kvSet('draft:' + tab.id, { id: tab.id, bytes: tab.bytes.buffer.slice(tab.bytes.byteOffset, tab.bytes.byteOffset + tab.bytes.byteLength), title: tab.title, fileName: tab.fileName, uri: tab.uri, key: tab.key, time: Date.now(), password: tab.password }); }
      catch { /* storage full */ }
    }
    this.ui.status?.('Draft saved');
  }

  followLink(href: string): void {
    if (!isSafeExternalUrl(href)) { toast(`Blocked a link with an unsupported or unsafe address: ${href.slice(0, 60)}`); return; }
    import('./platform/native').then(({ openExternal }) => openExternal(href));
  }

  focus(): void { this.active?.ui.focus(); }
}

import * as buildMod from './pdf/build';
function requireBuild() { return buildMod; }
