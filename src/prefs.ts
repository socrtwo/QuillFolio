/** Application preferences (per device), persisted to localStorage. */

export interface CustomGroup { id: string; label: string; items: string[] }
export interface CustomTab { id: string; label: string; groups: CustomGroup[]; hidden?: boolean }
export interface RecentEntry { key: string; name: string; when: number; uri?: string; format?: string; pinned?: boolean }
export interface Macro { name: string; steps: { id: string; arg?: any }[]; description?: string; key?: string; created: number }

export const DEFAULT_REPLACEMENTS: Record<string, string> = {
  '(c)': '©', '(r)': '®', '(tm)': '™', '...': '…', '->': '→', '<-': '←', '=>': '⇒', '<=>': '⇔', '+-': '±', '!=': '≠', '--': '–',
  teh: 'the', adn: 'and', recieve: 'receive', seperate: 'separate', occured: 'occurred', untill: 'until', wich: 'which', thier: 'their', accomodate: 'accommodate', definately: 'definitely',
};

export interface Prefs {
  author: string;
  initials: string;
  qat: string[];
  qatPosition: 'top' | 'below' | 'bottom';
  qatLabels: boolean;
  qatHidden: boolean;
  customTabs: CustomTab[];
  hiddenTabs: string[];
  tabOrder: string[];
  keymap: Record<string, string>;
  autosave: boolean;
  autosaveSeconds: number;
  replacements: Record<string, string>;
  autoCorrect: boolean;
  /** Capitalize the first letter of sentences and of placeholder text. */
  autoCapitalize: boolean;
  smartQuotes: boolean;
  /** Automatic bulleted and numbered lists when a paragraph starts with "* " or "1. ". */
  autoLists: boolean;
  theme: 'system' | 'light' | 'dark';
  ribbon: 'full' | 'tabs' | 'hidden';
  spellcheck: boolean;
  recent: RecentEntry[];
  macros: Macro[];
  dictionary: string[];
  ignoredWords: string[];
  language: string;
  spellDialect: 'any' | 'document' | 'en-US' | 'en-GB' | 'en-CA' | 'en-AU';
  confirmClose: boolean;
  defaultSaveFormat: string;
  readAloudRate: number;
  highContrastUI: boolean;
  uiScale: number;
  pinnedCommands: string[];
  firstRun: boolean;
  touchMode: boolean;
  miniToolbar: boolean;
  /** Viewing */
  viewMode: 'continuous' | 'single' | 'facing' | 'book';
  defaultZoom: 'fit-width' | 'fit-page' | 'actual';
  showThumbnails: boolean;
  smoothScroll: boolean;
  nightMode: boolean;
  grayscale: boolean;
  renderDpiCap: number;
  /** Editing */
  highlightColor: string;
  penColor: string;
  penWidth: number;
  noteColor: string;
  stampOpacity: number;
  measureUnit: 'pt' | 'in' | 'mm' | 'cm';
  /** Drawing scale for measurements: real-world units per point, and the unit's name. */
  measureScale?: number;
  measureScaleUnit?: string;
  /** Forms */
  highlightFields: boolean;
  /** Saving */
  saveMode: 'incremental' | 'rewrite';
  /** OCR */
  ocrLanguage: string;
  /** Print */
  printDpi: number;
}

export const DEFAULT_QAT = ['file.save', 'edit.undo', 'edit.redo', 'home.select', 'comment.highlight', 'view.cmdSearch'];

/**
 * The Quick Access Bar drop-down checklist: the union of the choices desktop office programs have
 * offered in their Quick Access Toolbar drop-down (docs/QAT.md), with the PDF equivalent of
 * "Present from Beginning" (Read Mode from the first page), then PDF extras.
 */
export const QAT_STANDARD = ['file.autosave', 'file.new', 'file.open', 'file.save', 'file.email', 'file.quickPrint', 'file.print', 'review.spelling', 'edit.undo', 'edit.redo', 'view.readMode', 'view.touchMode', 'file.openRecent'];
export const QAT_EXTRAS = ['home.select', 'home.hand', 'comment.highlight', 'comment.note', 'organize.rotateRight', 'file.saveAs', 'file.share', 'file.export.images', 'edit.find', 'forms.fillMode', 'view.cmdSearch'];
export const QAT_CHOICES = [...QAT_STANDARD, ...QAT_EXTRAS];
/** Kept first, in this order, by addAllQatChoices. */
export const QAT_PINNED_FIRST = ['file.save', 'file.print'];

/**
 * Adds every drop-down choice to the bar: Save and Print first, then the remaining choices sorted by
 * label (case-insensitive), then anything else already on the bar, in its existing order.
 */
export function addAllQatChoices(current: string[], labelOf: (id: string) => string | undefined, choices: string[] = QAT_CHOICES): string[] {
  const known = choices.filter((id) => labelOf(id) !== undefined);
  const first = QAT_PINNED_FIRST.filter((id) => known.includes(id));
  const rest = known.filter((id) => !first.includes(id))
    .sort((a, b) => labelOf(a)!.localeCompare(labelOf(b)!, undefined, { sensitivity: 'base' }));
  const head = [...first, ...rest];
  return [...head, ...current.filter((id) => id === '|' || !head.includes(id))];
}

export function defaultPrefs(): Prefs {
  return {
    author: 'Author', initials: 'A',
    qat: [...DEFAULT_QAT], qatPosition: 'top', qatLabels: false, qatHidden: false,
    customTabs: [], hiddenTabs: [], tabOrder: [], keymap: {},
    autosave: true, autosaveSeconds: 10,
    replacements: { ...DEFAULT_REPLACEMENTS }, autoCorrect: true, autoCapitalize: true, smartQuotes: true, autoLists: true,
    theme: 'system', ribbon: 'full', spellcheck: true,
    recent: [], macros: [], dictionary: [], ignoredWords: [],
    language: 'en-US', spellDialect: 'any', confirmClose: true, defaultSaveFormat: 'pdf', readAloudRate: 1,
    highContrastUI: false, uiScale: 1, pinnedCommands: [], firstRun: true, touchMode: false, miniToolbar: true,
    viewMode: 'continuous', defaultZoom: 'fit-width', showThumbnails: false, smoothScroll: true, nightMode: false, grayscale: false, renderDpiCap: 3,
    highlightColor: '#FFEB3B', penColor: '#E53935', penWidth: 2, noteColor: '#FFD54F', stampOpacity: 0.85, measureUnit: 'in',
    highlightFields: true, saveMode: 'incremental', ocrLanguage: 'eng', printDpi: 150,
  };
}

const KEY = 'quillfolio.prefs.v1';

export function loadPrefs(): Prefs {
  const d = defaultPrefs();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const p = sanitizePrefs(JSON.parse(raw));
    return { ...d, ...p, replacements: p.replacements || d.replacements };
  } catch {
    return d;
  }
}

const ENUMS: Partial<Record<keyof Prefs, readonly string[]>> = {
  qatPosition: ['top', 'below', 'bottom'], theme: ['system', 'light', 'dark'], ribbon: ['full', 'tabs', 'hidden'],
  spellDialect: ['any', 'document', 'en-US', 'en-GB', 'en-CA', 'en-AU'], viewMode: ['continuous', 'single', 'facing', 'book'], defaultZoom: ['fit-width', 'fit-page', 'actual'], saveMode: ['incremental', 'rewrite'], measureUnit: ['pt', 'in', 'mm', 'cm'],
};
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Keeps only preferences of the expected shape (stored, or pasted into Import Settings). Unknown keys are dropped. */
export function sanitizePrefs(raw: unknown): Partial<Prefs> {
  if (!isObj(raw)) return {};
  const d = defaultPrefs() as Record<string, any>;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in d)) continue;
    const def = d[k];
    if (Array.isArray(def) ? Array.isArray(v) : isObj(def) ? isObj(v) : typeof v === typeof def && (typeof v !== 'number' || Number.isFinite(v))) out[k] = v;
  }
  for (const [k, ok] of Object.entries(ENUMS)) if (k in out && !ok!.includes(out[k])) delete out[k];
  for (const k of ['qat', 'hiddenTabs', 'tabOrder', 'dictionary', 'ignoredWords', 'pinnedCommands']) if (k in out) out[k] = strings(out[k]);
  for (const k of ['keymap', 'replacements']) if (k in out) out[k] = Object.fromEntries(Object.entries(out[k]).filter(([, x]) => typeof x === 'string'));
  if (out.customTabs) {
    out.customTabs = out.customTabs.filter((t: any) => isObj(t) && typeof t.id === 'string' && Array.isArray(t.groups))
      .map((t: any) => ({ ...t, label: String(t.label ?? t.id), groups: t.groups.filter(isObj).map((g: any) => ({ ...g, id: String(g.id ?? ''), label: String(g.label ?? ''), items: strings(g.items) })) }));
  }
  if (out.recent) out.recent = out.recent.filter((r: any) => isObj(r) && typeof r.key === 'string' && typeof r.name === 'string');
  if (out.macros) out.macros = out.macros.filter((m: any) => isObj(m) && typeof m.name === 'string' && Array.isArray(m.steps) && m.steps.every((s: any) => isObj(s) && typeof s.id === 'string'));
  return out as Partial<Prefs>;
}

export function savePrefs(p: Prefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage full or unavailable */ }
}
