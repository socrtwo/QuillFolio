/** Protect tab: encryption and permissions, redaction, hidden information and sanitizing, mark as final. */
import { def } from './registry';
import type { App } from '../app';
import { openDialog, toast, confirmDialog, promptDialog } from '../ui/dialog';
import { h } from '../ui/dom';
import { permissionsOf, type Permissions } from '../pdf/crypt';
import { PdfString } from '../pdf/objects';
import { addRedactMark, applyRedactions } from '../pdf/ops/annots';
import { hiddenInformation, sanitize, type SanitizeOptions } from '../pdf/ops/optimize';
import { pageAnnotations, addAttachment, readAttachments } from '../pdf/structure';
import { replaceWithBytes } from './file';
import { askPages, pageOf, selectedText, esc, viewer, type Rect } from './util';

const PERMS: { key: keyof Permissions; label: string }[] = [
  { key: 'print', label: 'Printing' }, { key: 'printHigh', label: 'High-quality printing' }, { key: 'copy', label: 'Copying text and images' }, { key: 'accessibility', label: 'Text access for screen readers' },
  { key: 'modify', label: 'Changing the document' }, { key: 'annotate', label: 'Commenting' }, { key: 'fillForms', label: 'Filling form fields' }, { key: 'assemble', label: 'Inserting, deleting and rotating pages' },
];

/** The audit log kept with the tab (saved into review packages and the redaction log attachment). */
export function audit(app: App, text: string): void {
  const t = app.tab as any;
  (t.audit ||= []).push({ when: Date.now(), text, user: app.prefs.author });
}

async function encryptDialog(app: App, permissionsOnly = false): Promise<void> {
  const cur = app.doc.securityInfo;
  const perms = cur?.permissions || permissionsOf(-1);
  const r = await openDialog({ title: permissionsOnly ? 'Permissions' : 'Encrypt with Password', wide: true, fields: [
    ...(permissionsOnly ? [] : [
      { key: 'h1', type: 'heading' as const, label: 'Passwords (AES-256)' },
      { key: 'user', label: 'Password to open (leave empty to open without one)', type: 'password' as const, half: true },
      { key: 'user2', label: 'Confirm', type: 'password' as const, half: true },
    ]),
    { key: 'owner', label: 'Permissions password (needed to change these settings later)', type: 'password', half: true },
    { key: 'owner2', label: 'Confirm', type: 'password', half: true },
    { key: 'h2', type: 'heading', label: 'What readers without the permissions password may do' },
    ...PERMS.map((p) => ({ key: p.key, label: p.label, type: 'checkbox' as const, value: (perms as any)[p.key] !== false, half: true })),
    { key: 'meta', label: 'Encrypt the metadata too', type: 'checkbox', value: cur ? cur.encryptMetadata : true },
    { key: 'i', type: 'info', html: '<p class="ql-help">Permissions are advisory: readers that honor the standard respect them, but anyone with the open password can read the bytes. The document is rewritten in memory; Save writes the encrypted file.</p>' },
  ], validate: (v) => (!permissionsOnly && v.user !== v.user2 ? 'The open passwords do not match.' : v.owner !== v.owner2 ? 'The permissions passwords do not match.' : !v.owner && !v.user ? 'Enter at least one password.' : null), ok: 'Encrypt' });
  if (!r) return;
  const permissions: Partial<Permissions> = {};
  for (const p of PERMS) permissions[p.key] = !!r[p.key];
  const userPassword = permissionsOnly ? (app.tab.password || '') : String(r.user || '');
  const ownerPassword = String(r.owner || '') || userPassword || Math.random().toString(36).slice(2);
  const bytes = app.doc.save({ incremental: false, encrypt: { userPassword, ownerPassword, permissions, encryptMetadata: !!r.meta } });
  replaceWithBytes(app, app.tab, bytes, userPassword);
  app.tab.clearHistory();
  audit(app, permissionsOnly ? 'Permissions changed' : 'Encrypted with AES-256');
  toast('Encrypted. Save to write the protected file.');
}

async function securityInfoDialog(app: App): Promise<void> {
  const s = app.doc.securityInfo;
  const rows = s ? [
    ['Method', `${s.method.toUpperCase()} (strings: ${s.stringMethod.toUpperCase()}), ${s.keyLength}-bit, revision ${s.revision}`],
    ['Opened with', s.ownerAccess ? 'the permissions (owner) password: everything is allowed' : app.tab.password ? 'the open (user) password' : 'no password (empty user password)'],
    ['Metadata', s.encryptMetadata ? 'encrypted' : 'not encrypted'],
    ...PERMS.map((p) => [p.label, (s.permissions as any)[p.key] ? 'allowed' : 'not allowed']),
  ] : [['Security', 'None: the document is not encrypted.']];
  await openDialog({ title: 'Security Settings', ok: 'Close', cancel: false, content: h('table', { class: 'ql-table' }, rows.map((rw) => h('tr', null, h('th', { style: 'text-align:left;padding-right:12px' }, rw[0]), h('td', null, rw[1])))), buttons: [
    { label: s ? 'Change…' : 'Encrypt…', onClick: (_v, ctl) => { ctl.close(null); app.exec('protect.encrypt'); } },
    ...(s ? [{ label: 'Remove Security', onClick: (_v: any, ctl: any) => { ctl.close(null); app.exec('protect.removeSecurity'); } }] : []),
  ] });
}

/** Rectangles of every occurrence of a text on a page (through the renderer's text items). */
export async function findRects(app: App, page: number, needle: string, opts: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean }): Promise<Rect[]> {
  const items = await viewer(app).items(page);
  const out: Rect[] = [];
  let re: RegExp;
  try { re = new RegExp(opts.regex ? needle : (opts.wholeWord ? '\\b' : '') + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (opts.wholeWord ? '\\b' : ''), opts.caseSensitive ? 'g' : 'gi'); } catch { return out; }
  for (const it of items) {
    if (!it.str) continue;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(it.str))) {
      if (!m[0]) { re.lastIndex++; continue; }
      const cw = it.w / Math.max(1, it.str.length);
      out.push([it.x + m.index * cw, it.y - it.h * 0.2, it.x + (m.index + m[0].length) * cw, it.y + it.h * 0.8]);
    }
  }
  return out;
}

export const PII_PATTERNS: { label: string; re: string }[] = [
  { label: 'Email addresses', re: '[\\w.+-]+@[\\w-]+\\.[\\w.-]+' },
  { label: 'Phone numbers', re: '(?:\\+?\\d{1,3}[ .-]?)?\\(?\\d{3}\\)?[ .-]?\\d{3}[ .-]?\\d{4}' },
  { label: 'US Social Security numbers', re: '\\b\\d{3}-\\d{2}-\\d{4}\\b' },
  { label: 'Credit card numbers', re: '\\b(?:\\d[ -]?){13,19}\\b' },
  { label: 'Dates', re: '\\b\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}\\b' },
  { label: 'IP addresses', re: '\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b' },
];

def([
  { id: 'protect.encrypt', label: 'Encrypt…', icon: 'enhanced_encryption', tab: 'Protect', group: 'Security', popular: true, tip: 'AES-256 with an open password and/or a permissions password', run: (app) => encryptDialog(app) },
  { id: 'protect.permissions', label: 'Permissions…', icon: 'admin_panel_settings', tab: 'Protect', group: 'Security', tip: 'Restrict printing, copying and changes without an open password', run: (app) => encryptDialog(app, true) },
  {
    id: 'protect.removeSecurity', label: 'Remove Security', icon: 'no_encryption', tab: 'Protect', group: 'Security', isEnabled: (app) => !!app.doc?.security,
    run: async (app) => {
      const s = app.doc.securityInfo;
      if (!s) { toast('The document is not encrypted.'); return; }
      if (!s.ownerAccess) {
        const pw = await promptDialog('Permissions Password', 'Enter the permissions (owner) password to remove the security:', '', { type: 'password' });
        if (pw == null) return;
        const ok = app.doc.security!.authenticate(pw, (o) => app.doc.resolve(o));
        if (!ok || !app.doc.security!.ownerAccess) { toast('That is not the permissions password.'); return; }
      }
      const bytes = app.doc.save({ incremental: false, removeSecurity: true });
      replaceWithBytes(app, app.tab, bytes, '');
      app.tab.clearHistory();
      audit(app, 'Security removed');
      toast('Security removed. Save to write the unprotected file.');
    },
  },
  { id: 'protect.securityInfo', label: 'Security Settings', icon: 'shield', tab: 'Protect', group: 'Security', edits: false, noRecord: true, run: securityInfoDialog },
  {
    id: 'protect.redactArea', label: 'Mark Area', icon: 'block', tab: 'Protect', group: 'Redact', kind: 'toggle', noRecord: true,
    tip: 'Drag rectangles over content to redact; Apply Redactions removes it for good',
    isActive: (app) => app.tab?.ui?.tool === 'redact' && !app.viewer.toolOpts?.text,
    run: (app) => { app.tab.ui.setTool('redact', {}); app.focus(); },
  },
  {
    id: 'protect.redactText', label: 'Mark Text', icon: 'format_strikethrough', tab: 'Protect', group: 'Redact', kind: 'toggle', noRecord: true,
    tip: 'Mark the selected text for redaction, or drag over text with the tool',
    isActive: (app) => app.tab?.ui?.tool === 'redact' && !!app.viewer.toolOpts?.text,
    run: (app) => {
      const sr = app.viewer.selectionRects;
      if (sr && sr.rects.length) { const p = pageOf(app, sr.page); app.edit('Mark for Redaction', (doc) => addRedactMark(doc, p, sr.rects, { author: app.prefs.author })); app.viewer.clearSelection(); return; }
      app.tab.ui.setTool('redact', { text: true }); app.focus();
    },
  },
  {
    id: 'protect.redactSearch', label: 'Mark by Search…', icon: 'find_replace', tab: 'Protect', group: 'Redact', popular: true,
    tip: 'Mark every occurrence of a word, phrase, pattern or kind of personal data',
    run: async (app) => {
      const r = await openDialog({ title: 'Mark by Search', wide: true, fields: [
        { key: 'q', label: 'Text or regular expression', type: 'text', value: selectedText(app).slice(0, 60), autofocus: true },
        { key: 'regex', label: 'Regular expression', type: 'checkbox', value: false, half: true },
        { key: 'cs', label: 'Match case', type: 'checkbox', value: false, half: true },
        { key: 'ww', label: 'Whole words', type: 'checkbox', value: false, half: true },
        { key: 'pii', label: 'Also mark', type: 'list', multiple: true, rows: 6, options: PII_PATTERNS.map((p, i) => ({ value: String(i), label: p.label })), value: [] },
        { key: 'overlay', label: 'Overlay text after redaction (optional)', type: 'text', value: '' },
        { key: 'pages', label: 'Pages (blank = all)', type: 'text', value: '' },
      ], ok: 'Mark' });
      if (!r) return;
      const { pagesFromRange } = await import('./util');
      const pages = r.pages ? pagesFromRange(app, r.pages) : app.doc.pages.map((_, i) => i);
      const patterns: { re: string; regex: boolean }[] = [];
      if (String(r.q).trim()) patterns.push({ re: r.q, regex: r.regex });
      for (const i of r.pii as string[]) patterns.push({ re: PII_PATTERNS[+i].re, regex: true });
      if (!patterns.length) { toast('Enter text or choose a kind of data.'); return; }
      const found = new Map<number, Rect[]>();
      for (const i of pages) for (const pt of patterns) { const rects = await findRects(app, i, pt.re, { caseSensitive: r.cs, wholeWord: r.ww, regex: pt.regex }); if (rects.length) found.set(i, [...(found.get(i) || []), ...rects]); }
      const total = [...found.values()].reduce((n, x) => n + x.length, 0);
      if (!total) { toast('Nothing matched.'); return; }
      app.edit('Mark by Search', (doc) => { for (const [i, rects] of found) addRedactMark(doc, doc.pages[i], rects, { author: app.prefs.author, overlayText: r.overlay || undefined, contents: String(r.q || 'pattern') }); });
      toast(`${total} match(es) marked on ${found.size} page(s). Use Apply Redactions to remove them.`, { ms: 6000 });
    },
  },
  {
    id: 'protect.redactPages', label: 'Mark Pages', icon: 'crop_free', tab: 'Protect', group: 'Redact', tip: 'Mark whole pages for redaction',
    run: async (app) => { const r = await askPages(app, 'Mark Pages for Redaction', [], 'Mark'); if (!r) return; app.edit('Mark Pages', (doc) => { for (const i of r.pages) { const p = doc.pages[i]; addRedactMark(doc, p, [p.mediaBox], { author: app.prefs.author }); } }); },
  },
  {
    id: 'protect.applyRedactions', label: 'Apply Redactions', icon: 'delete_forever', tab: 'Protect', group: 'Redact', popular: true,
    tip: 'Remove the marked text and images from the page content, draw black boxes and log the action',
    run: async (app) => {
      const marks = app.doc.pages.flatMap((p) => pageAnnotations(app.doc, p).filter((a) => a.subtype === 'Redact'));
      if (!marks.length) { toast('Nothing is marked for redaction.'); return; }
      const r = await openDialog({ title: 'Apply Redactions', fields: [{ key: 'i', type: 'info', html: `<p>${marks.length} mark(s) on ${new Set(marks.map((m) => m.page)).size} page(s) will be applied. Text and images under them are removed from the file, not just covered. <b>This cannot be undone after you save.</b></p>` }, { key: 'sanitize', label: 'Also remove metadata, comments and hidden information afterwards', type: 'checkbox', value: true }, { key: 'log', label: 'Attach a redaction log to the document', type: 'checkbox', value: true }], ok: 'Apply' });
      if (!r) return;
      const res = app.edit('Apply Redactions', (doc) => {
        const result = applyRedactions(doc, [...new Set(marks.map((m) => m.page))]);
        if (r.sanitize) sanitize(doc, { metadata: true, comments: true, hiddenLayers: true, thumbnails: true, privateData: true });
        if (r.log) {
          const old = readAttachments(doc).find((a) => a.name === 'redaction-log.txt');
          const prev = old?.stream ? new TextDecoder().decode(doc.decoded(old.stream)) + '\n' : '';
          const line = `${new Date().toISOString()}\t${app.prefs.author}\t${marks.length} mark(s) applied: ${result.textRemoved} text run(s), ${result.imagesRemoved} image(s), ${result.areas} area(s) on page(s) ${[...new Set(marks.map((m) => m.page + 1))].join(', ')}`;
          if (old) { const { removeAttachment } = requireStructure(); removeAttachment(doc, old); }
          addAttachment(doc, 'redaction-log.txt', new TextEncoder().encode(prev + line), { description: 'QuillFolio redaction log', mime: 'text/plain' });
        }
        return result;
      });
      if (!res) return;
      audit(app, `Redactions applied: ${res.textRemoved} text run(s), ${res.imagesRemoved} image(s), ${res.areas} area(s)`);
      app.tab.ui.selectedAnnot = null;
      toast(`Redacted: ${res.textRemoved} text run(s) and ${res.imagesRemoved} image(s) removed in ${res.areas} area(s). Saving now rewrites the whole file, so the removed content does not survive in an earlier version inside it.`, { ms: 8000, action: 'Save', onAction: () => app.exec('file.save') });
    },
  },
  {
    id: 'protect.redactLog', label: 'Redaction Log', icon: 'receipt_long', tab: 'Protect', group: 'Redact', edits: false, noRecord: true,
    run: async (app) => {
      const att = readAttachments(app.doc).find((a) => a.name === 'redaction-log.txt');
      const text = att?.stream ? new TextDecoder().decode(app.doc.decoded(att.stream)) : '';
      const mem = ((app.tab as any).audit || []).map((l: any) => `${new Date(l.when).toLocaleString()}\t${l.text}`).join('\n');
      await openDialog({ title: 'Redaction and Audit Log', wide: true, ok: 'Close', cancel: false, content: h('pre', { class: 'ql-notices' }, [text ? `Redaction log attached to the document:\n${text}` : 'No redaction log is attached to the document.', mem ? `\nThis session:\n${mem}` : ''].join('\n')) });
    },
  },
  {
    id: 'protect.hiddenInfo', label: 'Hidden Information', icon: 'policy', tab: 'Protect', group: 'Hidden Information', edits: false, noRecord: true, popular: true,
    tip: 'What the file carries besides its pages: metadata, comments, attachments, scripts, hidden layers, earlier versions',
    run: (app) => {
      const rep = hiddenInformation(app.doc);
      const items = rep.items.map((it) => ({ level: 'info' as const, text: `${it.kind}: ${it.count}${it.detail ? ` — ${it.detail}` : ''}` }));
      app.ui.openPane('report', { title: 'Hidden Information', items: items.length ? items : [{ level: 'info', text: 'Nothing hidden was found.' }], actions: [{ label: 'Sanitize…', run: () => app.exec('protect.sanitize') }] });
    },
  },
  {
    id: 'protect.sanitize', label: 'Sanitize…', icon: 'cleaning_services', tab: 'Protect', group: 'Hidden Information',
    tip: 'Remove the chosen kinds of hidden information in one step',
    run: async (app) => {
      const rep = hiddenInformation(app.doc);
      const has = (k: string) => rep.items.some((i) => i.kind.toLowerCase().startsWith(k));
      const opts: { key: keyof SanitizeOptions; label: string; on: boolean }[] = [
        { key: 'metadata', label: 'Document metadata and XMP', on: true }, { key: 'attachments', label: 'Attachments', on: has('attach') }, { key: 'javascript', label: 'JavaScript and actions', on: true },
        { key: 'comments', label: 'Comments and markup', on: false }, { key: 'forms', label: 'Form fields', on: false }, { key: 'links', label: 'Links', on: false },
        { key: 'hiddenLayers', label: 'Hidden layers (their content)', on: has('hidden layers') }, { key: 'bookmarks', label: 'Bookmarks', on: false }, { key: 'thumbnails', label: 'Embedded page thumbnails', on: true }, { key: 'privateData', label: 'Private application data', on: true },
      ];
      const r = await openDialog({ title: 'Sanitize Document', fields: [...opts.map((o) => ({ key: o.key, label: o.label, type: 'checkbox' as const, value: o.on, half: true })), { key: 'i', type: 'info', html: '<p class="ql-help">Earlier versions kept by incremental updates go away when you Save As a rewritten PDF.</p>' }], ok: 'Remove' });
      if (!r) return;
      const o: SanitizeOptions = {}; for (const x of opts) (o as any)[x.key] = !!r[x.key];
      const done = app.edit('Sanitize', (doc) => sanitize(doc, o));
      audit(app, `Sanitized: ${(done || []).join(', ') || 'nothing'}`);
      toast(done?.length ? `Removed: ${done.join(', ')}.` : 'Nothing to remove.', { ms: 6000 });
    },
  },
  { id: 'protect.removeMetadata', label: 'Remove Metadata', icon: 'label_off', tab: 'Protect', group: 'Hidden Information', run: (app) => { app.edit('Remove Metadata', (doc) => sanitize(doc, { metadata: true })); audit(app, 'Metadata removed'); toast('Metadata removed.'); } },
  { id: 'protect.removeAttachments', label: 'Remove Attachments', icon: 'attachment', tab: 'Protect', group: 'Hidden Information', run: async (app) => { const n = readAttachments(app.doc).length; if (!n) { toast('There are no attachments.'); return; } if (await confirmDialog('Remove Attachments', `Remove ${n} attachment(s)?`, 'Remove')) { app.edit('Remove Attachments', (doc) => sanitize(doc, { attachments: true })); audit(app, `${n} attachment(s) removed`); } } },
  { id: 'protect.removeJavaScript', label: 'Remove JavaScript', icon: 'code_off', tab: 'Protect', group: 'Hidden Information', tip: 'Strip scripts and actions (QuillFolio never runs them anyway)', run: (app) => { const d = app.edit('Remove JavaScript', (doc) => sanitize(doc, { javascript: true })); toast(d?.length ? 'Scripts and actions removed.' : 'The document has no scripts.'); } },
  {
    id: 'protect.markFinal', label: 'Mark as Final', icon: 'verified', tab: 'Protect', group: 'Final', kind: 'toggle', noRecord: true, edits: false,
    tip: 'Make the document read-only in this window so nothing changes by accident (not a security feature)',
    isActive: (app) => !!app.tab?.readOnly,
    run: (app) => { app.tab.readOnly = !app.tab.readOnly; app.refresh(); toast(app.tab.readOnly ? 'Marked as final: editing is turned off here.' : 'Editing is allowed again.'); },
  },
  {
    id: 'protect.watermarkConfidential', label: 'Confidential Watermark', icon: 'water_drop', tab: 'Protect', group: 'Final', tip: 'A diagonal CONFIDENTIAL watermark on every page',
    run: async (app) => { const { addWatermark } = await import('../pdf/ops/pages'); app.edit('Confidential Watermark', (doc) => addWatermark(doc, doc.pages.map((_, i) => i), 'CONFIDENTIAL', { size: 72, opacity: 0.15, color: [0.8, 0, 0], rotate: 45 })); },
  },
  {
    id: 'protect.setOpenPassword', label: 'Change Open Password…', icon: 'password', tab: 'Protect', group: 'Security', isEnabled: (app) => !!app.doc?.security,
    run: async (app) => {
      const s = app.doc.securityInfo; if (!s) return;
      if (!s.ownerAccess) { toast('Open the document with its permissions password first (Remove Security asks for it).'); return; }
      const r = await openDialog({ title: 'Change Open Password', fields: [{ key: 'p1', label: 'New open password', type: 'password' }, { key: 'p2', label: 'Confirm', type: 'password' }], validate: (v) => (v.p1 !== v.p2 ? 'The passwords do not match.' : null) });
      if (!r) return;
      const bytes = app.doc.save({ incremental: false, encrypt: { userPassword: String(r.p1), ownerPassword: Math.random().toString(36).slice(2) + String(r.p1), permissions: s.permissions, encryptMetadata: s.encryptMetadata } });
      replaceWithBytes(app, app.tab, bytes, String(r.p1));
      toast('Open password changed. Save to write the file.');
    },
  },
]);

import * as structureMod from '../pdf/structure';
function requireStructure() { return structureMod; }
export { esc, PdfString };
