/**
 * AI tab: setup, providers, several AIs, and the document features (summaries, questions, extraction,
 * translation, comment help, OCR clean-up, alt text, redaction suggestions, bookmarks, assistant).
 * Only the text a command needs is sent, answers are previewed, and changes apply as one undoable step.
 */
import { def, type MenuEntry } from './registry';
import type { App } from '../app';
import { aiSettings, saveAiSettings, resolveProvider } from '../ai/store';
import { providerById } from '../ai/providers';
import { chat, activeEnsemble, type ChatMessage, type ContentPart } from '../ai/client';
import { outcomeLine, type EnsembleMode } from '../ai/ensemble';
import { FOLIO_SYSTEM, TASKS, cleanText, linesOf, parseJsonLoose } from '../ai/folio';
import { openDialog, toast, confirmDialog, promptDialog } from '../ui/dialog';
import { h } from '../ui/dom';
import { readFields, readOutlines, writeOutlines, outlinesToInput, type OutlineInput } from '../pdf/structure';
import { setFieldProps } from '../pdf/ops/forms';
import { setAnnotationProps, addReply, addNote, addRedactMark } from '../pdf/ops/annots';
import { listImages } from '../pdf/ops/optimize';
import { PdfString } from '../pdf/objects';
import { selectedText, selectedAnnotation, viewer, pageOf, saveBytes, baseName, esc } from './util';

// ------------------------------------------------------------------------------------------
// Readiness, privacy, requests

const cloudId = (id: string) => { const p = providerById(id); return !!p && p.kind !== 'local' && p.kind !== 'builtin'; };
function aiRecipients(): string[] {
  const plan = activeEnsemble();
  if (!plan) { const a = aiSettings().active; return a ? [a] : []; }
  return [...new Set([...plan.members.map((m) => m.provider), plan.master.provider])];
}
const names = (ids: string[]) => { const n = ids.map((id) => providerById(id)?.name || id); return n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`; };

export async function ensureAiReady(app: App, reason = 'This command needs an AI provider. Choose one below; free options, including one that runs on this device, are at the top.'): Promise<boolean> {
  const s = aiSettings();
  if (!s.enabled) { toast('AI features are turned off (AI ▸ AI Settings).', { action: 'Settings', onAction: () => app.exec('ai.settings') }); return false; }
  if (!(s.active && (await resolveProvider()))) {
    const { openAiSetup } = await import('../ui/aiWizard');
    if (!(await openAiSetup(app, { reason }))) return false;
  }
  const ids = aiRecipients().filter((id) => cloudId(id) && !aiSettings().privacyAck.includes(id));
  if (!ids.length) return true;
  const free = ids.some((id) => providerById(id)?.free === 'free');
  const ok = await confirmDialog('Sending Text to an AI Service', `AI commands send only the page text they need directly from this device to ${names(ids)}. Anne's Folio has no server and keeps no copy. The service's terms and privacy policy apply${free ? ', and free tiers may use what you send to improve their models' : ''}. For confidential documents, use the on-device model. Continue?`, 'Continue', 'Cancel');
  if (ok) saveAiSettings((x) => { for (const id of ids) if (!x.privacyAck.includes(id)) x.privacyAck.push(id); });
  return ok;
}

let controller: AbortController | null = null;

function system(): string {
  const s = aiSettings();
  return [FOLIO_SYSTEM, s.language && s.language !== 'auto' ? `Write in ${s.language}.` : '', s.styleGuide ? `Style guide: ${s.styleGuide}` : ''].filter(Boolean).join('\n');
}

/** Sends a prompt and returns the answer text (with a status line while waiting). */
export async function ask(app: App, prompt: string | ContentPart[], opts: { tier?: 'fast' | 'quality'; maxTokens?: number } = {}): Promise<string | null> {
  if (!(await ensureAiReady(app))) return null;
  controller?.abort();
  controller = new AbortController();
  const ctl = controller;
  app.ui.status?.('● AI is working… (AI ▸ Stop AI to cancel)');
  try {
    const messages: ChatMessage[] = [{ role: 'system', content: system() }, { role: 'user', content: prompt }];
    const r = await chat({ messages, tier: opts.tier || 'quality', maxTokens: opts.maxTokens || 2000, signal: ctl.signal, onStatus: (t) => app.ui.status?.(`● ${t}`) });
    if (r.ensemble && aiSettings().ensemble.showDeliberation) toast(outcomeLine(r.ensemble, (id) => providerById(id)?.name || id), { ms: 8000 });
    if (r.truncated) toast('The AI answer was cut short; the result may be incomplete.');
    return r.text;
  } catch (e: any) {
    if (e?.code === 'aborted' || ctl.signal.aborted) toast('AI stopped.');
    else toast(`AI: ${e?.message || e}`, { ms: 7000 });
    return null;
  } finally {
    if (controller === ctl) controller = null;
    app.ui.status?.('');
  }
}

/** The document's text, page by page, with page markers (truncated to maxChars). */
async function docText(app: App, maxChars = 24000, pages?: number[]): Promise<string> {
  const v = viewer(app);
  const idx = pages || app.doc.pages.map((_, i) => i);
  const parts: string[] = [];
  let n = 0;
  for (const i of idx) { const t = (await v.pageText(i)).trim(); if (!t) continue; const chunk = `[Page ${i + 1}]\n${t}`; n += chunk.length; parts.push(chunk); if (n > maxChars) break; }
  const out = parts.join('\n\n');
  if (out.length > maxChars) toast(`The document is long; only the first ${Math.round(maxChars / 1000)}k characters were sent.`);
  return out.slice(0, maxChars);
}

/** Shows an answer with ways to keep it: copy, save, add as a note, append as pages. */
async function showResult(app: App, title: string, text: string, opts: { notePage?: number; csv?: boolean } = {}): Promise<void> {
  const page = opts.notePage ?? app.page;
  await openDialog({ title, wide: true, ok: 'Close', cancel: false, fields: [{ key: 't', label: 'Result (you can edit it)', type: 'textarea', rows: Math.min(20, Math.max(6, text.split('\n').length + 1)), value: text }], buttons: [
    { label: 'Copy', onClick: (v) => { navigator.clipboard?.writeText(String(v.t)); toast('Copied'); } },
    { label: opts.csv ? 'Save CSV…' : 'Save as Text…', onClick: (v) => { void saveBytes(String(v.t), `${baseName(app)} ${title.toLowerCase()}.${opts.csv ? 'csv' : 'txt'}`, opts.csv ? 'text/csv' : 'text/plain'); } },
    { label: 'Add as Note', onClick: (v, ctl) => { ctl.close(null); const p = pageOf(app, page); app.edit(title, (doc) => addNote(doc, p, p.cropBox[0] + 24, p.cropBox[3] - 24, { contents: String(v.t), author: `${app.prefs.author} (AI)`, color: [0.75, 0.85, 1] })); } },
    { label: 'Append as Pages', onClick: async (v, ctl) => { ctl.close(null); const { addTextPages } = await import('../pdf/build'); app.edit(title, (doc) => addTextPages(doc, `# ${title}\n\n${v.t}`, { font: 'Helvetica', size: 11 })); } },
  ] });
}

// ------------------------------------------------------------------------------------------

const ENSEMBLE_MODES: { value: EnsembleMode; label: string }[] = [
  { value: 'single', label: 'Single AI' },
  { value: 'master', label: 'Master Combines Answers' },
  { value: 'consensus', label: 'Quaker Consensus' },
];

async function setEnsembleMode(app: App, mode?: string): Promise<void> {
  const pick = ENSEMBLE_MODES.find((o) => o.value === mode);
  const { openAiSettings } = await import('../ui/aiWizard');
  if (!pick) { await openAiSettings(app, { section: 'ensemble' }); return; }
  if (pick.value !== 'single' && Object.keys(aiSettings().providers).length < 2) {
    toast('Set up at least two AI providers to use several AIs.', { action: 'Set Up AI', onAction: () => app.exec('ai.setup'), ms: 7000 });
    return;
  }
  saveAiSettings((s) => { s.ensemble.mode = pick.value; });
  if (pick.value !== 'single' && (aiSettings().ensemble.members?.length || 0) < 2) await openAiSettings(app, { section: 'ensemble', mode: pick.value });
  app.ui.refresh?.();
  toast(pick.value === 'single' ? 'AI: one AI answers (the active provider)' : `AI: ${pick.label}`);
}

def([
  {
    id: 'ai.setup', label: 'Set Up AI', icon: 'auto_awesome', tab: 'AI', group: 'Setup', popular: true, noRecord: true, edits: false,
    tip: 'Choose a free or paid AI: on this device, free cloud tiers, your own computer, or a paid key', keywords: 'api key openai anthropic gemini mistral groq openrouter ollama wizard',
    run: async (app) => { const { openAiSetup } = await import('../ui/aiWizard'); await openAiSetup(app); },
  },
  { id: 'ai.providers', label: 'Providers & Models', icon: 'tune', tab: 'AI', group: 'Setup', noRecord: true, edits: false, tip: 'Switch AI provider, choose models, test or remove keys', run: async (app) => { const { openAiProviders } = await import('../ui/aiWizard'); await openAiProviders(app); } },
  {
    id: 'ai.active', label: 'Active AI', icon: 'swap_horiz', tab: 'AI', group: 'Setup', kind: 'menu', noRecord: true, edits: false, tip: 'Switch between the AI providers you have set up',
    run: async (app, id?: string) => {
      if (!id) { const { openAiProviders } = await import('../ui/aiWizard'); await openAiProviders(app); return; }
      if (!aiSettings().providers[id]) return;
      saveAiSettings((s) => { s.active = id; });
      toast(`AI: ${providerById(id)?.name}`);
    },
    menu: () => { const s = aiSettings(); const items: MenuEntry[] = Object.keys(s.providers).map((id) => ({ id: 'ai.active', arg: id, label: `${providerById(id)?.name || id} · ${s.providers[id].model}`, checked: s.active === id })); return [...items, ...(items.length ? [{ separator: true }] : []), { id: 'ai.setup', label: 'Add a Provider…' }]; },
  },
  { id: 'ai.settings', label: 'AI Settings', icon: 'settings_suggest', tab: 'AI', group: 'Setup', noRecord: true, edits: false, tip: 'Turn AI on or off, language for generated text, style guide, usage', run: async (app) => { const { openAiSettings } = await import('../ui/aiWizard'); await openAiSettings(app); } },
  {
    id: 'ai.privacy', label: 'AI & Privacy', icon: 'shield', tab: 'AI', group: 'Setup', noRecord: true, edits: false, tip: 'Where your text goes when you use AI',
    run: async () => {
      const p = providerById(aiSettings().active || '');
      await openDialog({ title: 'AI & Privacy', ok: 'Close', cancel: false, fields: [{ key: 'i', type: 'info', html: [
        '<p><b>Anne\'s Folio has no server.</b> AI requests go directly from this device to the provider you choose, using your own key. Nothing is sent until you run an AI command.</p>',
        `<p><b>Active provider:</b> ${p ? esc(p.name) : 'none'}${p && (p.kind === 'local' || p.kind === 'builtin') ? ' — runs on this device; your document does not leave it.' : p ? ' — the text a command needs (the selection, the page, or the document text for whole-document commands) is sent to this service; its terms apply.' : ''}</p>`,
        activeEnsemble() ? `<p><b>Several AIs are on.</b> Each AI command sends the same text to every one of these services: ${esc(names(aiRecipients()))}.</p>` : '',
        '<p><b>Pictures</b> are sent only by Generate Alt Text, and only the pictures on the page you choose.</p>',
        '<p><b>Keys</b> are stored on this device only. They are never placed in documents, drafts or exported settings.</p>',
        '<p><b>Changes are previewed</b> and applied as one step you can undo.</p>',
      ].join('') }] });
    },
  },
  { id: 'ai.stop', label: 'Stop AI', icon: 'stop_circle', tab: 'AI', group: 'Setup', noRecord: true, edits: false, isEnabled: () => !!controller, tip: 'Stop the AI request in progress', run: () => { controller?.abort(); controller = null; } },
  {
    id: 'ai.deleteModels', label: 'Delete Downloaded Models', icon: 'delete_sweep', tab: 'AI', group: 'Setup', noRecord: true, edits: false, tip: 'Free the storage used by the on-device AI model',
    run: async () => { const { clearLocalModels, localStorageEstimate } = await import('../ai/local'); if (!(await confirmDialog('Delete Downloaded Models', `Delete the on-device AI model files? (${await localStorageEstimate()}). They download again the next time you use the on-device model.`, 'Delete'))) return; const n = await clearLocalModels(); toast(`Deleted ${n} cached file(s).`); },
  },
  {
    id: 'ai.ensembleMode', label: 'Several AIs', icon: 'groups', tab: 'AI', group: 'Several AIs', kind: 'menu', edits: false,
    tip: 'Ask one AI, or several at once: one AI combines their answers (master), or they deliberate until they agree (Quaker consensus)',
    run: (app, mode?: string) => setEnsembleMode(app, mode),
    menu: () => { const e = aiSettings().ensemble; return [...ENSEMBLE_MODES.map((o) => ({ id: 'ai.ensembleMode', arg: o.value, label: o.label, checked: e.mode === o.value })), { separator: true }, { id: 'ai.ensembleMembers', label: 'Choose AIs…' }, { id: 'ai.showDeliberation', label: 'Show AI Discussion', checked: e.showDeliberation }]; },
    isActive: () => aiSettings().ensemble.mode !== 'single',
  },
  { id: 'ai.ensembleMembers', label: 'Choose AIs', icon: 'checklist', tab: 'AI', group: 'Several AIs', noRecord: true, edits: false, tip: 'Choose which AIs answer together, the master or clerk, and the rounds of discussion', run: async (app) => { const { openAiSettings } = await import('../ui/aiWizard'); await openAiSettings(app, { section: 'ensemble' }); } },
  { id: 'ai.showDeliberation', label: 'Show AI Discussion', icon: 'forum', tab: 'AI', group: 'Several AIs', kind: 'toggle', edits: false, tip: 'Show the outcome of the discussion when several AIs answer', run: (app, on?: boolean) => { saveAiSettings((s) => { s.ensemble.showDeliberation = typeof on === 'boolean' ? on : !s.ensemble.showDeliberation; }); app.ui.refresh?.(); }, isActive: () => aiSettings().ensemble.showDeliberation },

  // Understand -------------------------------------------------------------------------------
  { id: 'ai.summarize', label: 'Summarize Document', icon: 'summarize', tab: 'AI', group: 'Understand', popular: true, edits: false, run: async (app) => { const t = await docText(app); if (!t) { toast('The document has no text (run OCR on scans first).'); return; } const a = await ask(app, TASKS.summarize(t), { maxTokens: 1200 }); if (a != null) await showResult(app, 'Summary', cleanText(a), { notePage: 0 }); } },
  { id: 'ai.summarizePage', label: 'Summarize Page', icon: 'short_text', tab: 'AI', group: 'Understand', edits: false, run: async (app) => { const t = (await viewer(app).pageText(app.page)).trim(); if (!t) { toast('This page has no text.'); return; } const a = await ask(app, TASKS.summarizePage(t), { tier: 'fast', maxTokens: 400 }); if (a != null) await showResult(app, `Page ${app.page + 1} Summary`, cleanText(a)); } },
  {
    id: 'ai.explain', label: 'Explain Selection', icon: 'lightbulb', tab: 'AI', group: 'Understand', edits: false, isEnabled: (app) => !!selectedText(app),
    run: async (app) => { const t = selectedText(app).trim(); if (!t) { toast('Select some text first.'); return; } const ctx = (await viewer(app).pageText(app.page)).slice(0, 3000); const a = await ask(app, TASKS.explain(t, ctx), { maxTokens: 600 }); if (a != null) await showResult(app, 'Explanation', cleanText(a)); },
  },
  {
    id: 'ai.askDocument', label: 'Ask the Document', icon: 'question_answer', tab: 'AI', group: 'Understand', popular: true, edits: false, tip: 'Ask a question; the pages whose text matches it best are sent with the question',
    run: async (app) => {
      const q = await promptDialog('Ask the Document', 'Your question', '');
      if (!q) return;
      // Pick the pages that share the most words with the question (a small retrieval step).
      const v = viewer(app);
      const words = q.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
      const scored: { i: number; s: number }[] = [];
      for (let i = 0; i < app.doc.pageCount; i++) { const t = (await v.pageText(i)).toLowerCase(); let s = 0; for (const w of words) if (t.includes(w)) s++; scored.push({ i, s }); }
      const best = scored.sort((a, b) => b.s - a.s || a.i - b.i).slice(0, 8).filter((x) => x.s > 0 || scored.every((y) => y.s === 0)).map((x) => x.i).sort((a, b) => a - b);
      const t = await docText(app, 20000, best.length ? best : undefined);
      const a = await ask(app, TASKS.ask(t, q), { maxTokens: 800 });
      if (a != null) await showResult(app, 'Answer', `Q: ${q}\n\n${cleanText(a)}`);
    },
  },
  { id: 'ai.keyPoints', label: 'Key Points', icon: 'checklist', tab: 'AI', group: 'Understand', edits: false, tip: 'Decisions, dates, amounts and action items with page numbers', run: async (app) => { const t = await docText(app); if (!t) return; const a = await ask(app, TASKS.keyPoints(t), { maxTokens: 1200 }); if (a != null) await showResult(app, 'Key Points', linesOf(a).join('\n')); } },

  // Extract ----------------------------------------------------------------------------------
  { id: 'ai.extractTable', label: 'Extract Table', icon: 'table', tab: 'AI', group: 'Extract', edits: false, tip: 'Rebuild the table in the selected text (or on the page) as CSV', run: async (app) => { const t = selectedText(app).trim() || (await viewer(app).pageText(app.page)); if (!t.trim()) { toast('Select the table text or go to a page with a table.'); return; } const a = await ask(app, TASKS.extractTable(t), { maxTokens: 2000 }); if (a != null) await showResult(app, 'Table', cleanText(a), { csv: true }); } },
  { id: 'ai.extractEntities', label: 'Extract Entities', icon: 'person_search', tab: 'AI', group: 'Extract', edits: false, tip: 'People, organizations, places, dates and amounts in the selection or page', run: async (app) => { const t = selectedText(app).trim() || (await viewer(app).pageText(app.page)); if (!t.trim()) return; const a = await ask(app, TASKS.entities(t), { maxTokens: 1200 }); if (a == null) return; const j = parseJsonLoose<Record<string, string[]>>(a); await showResult(app, 'Entities', j ? Object.entries(j).map(([k, v]) => `${k}: ${(v || []).join('; ')}`).join('\n') : cleanText(a)); } },
  {
    id: 'ai.classifyFields', label: 'Label Form Fields', icon: 'ballot', tab: 'AI', group: 'Extract', tip: 'Suggest readable tooltips for the form fields from the text around them, then apply the ones you keep',
    run: async (app) => {
      const fields = readFields(app.doc).filter((f) => f.type !== 'button');
      if (!fields.length) { toast('The document has no form fields.'); return; }
      const pages = [...new Set(fields.flatMap((f) => f.widgets.map((w) => w.page)))].slice(0, 6);
      const t = await docText(app, 12000, pages);
      const list = fields.map((f) => `${f.name}\t${f.type}\t${f.tooltip || ''}`).join('\n');
      const a = await ask(app, TASKS.classifyFields(t, list), { maxTokens: 1500 });
      if (a == null) return;
      const j = parseJsonLoose<{ name: string; tooltip: string; kind?: string }[]>(a);
      if (!Array.isArray(j) || !j.length) { toast('The AI answer was not a list of fields.'); return; }
      const r = await openDialog({ title: 'Label Form Fields', fields: [{ key: 'f', label: 'Apply these tooltips', type: 'list', multiple: true, rows: 12, options: j.filter((x) => x?.name && x.tooltip).map((x, i) => ({ value: String(i), label: `${x.name} → ${x.tooltip}${x.kind ? ` (${x.kind})` : ''}` })), value: j.map((_, i) => String(i)) }], ok: 'Apply' });
      if (!r?.f?.length) return;
      app.edit('Label Form Fields', (doc) => { const fs = readFields(doc); for (const i of r.f as string[]) { const s = j[+i]; const f = fs.find((x) => x.name === s.name); if (f) setFieldProps(doc, f, { tooltip: s.tooltip }); } });
    },
  },

  // Write ------------------------------------------------------------------------------------
  {
    id: 'ai.translate', label: 'Translate', icon: 'g_translate', tab: 'AI', group: 'Write', edits: false, tip: 'Translate the selection or the page; keep the result as a note or new pages',
    run: async (app, lang?: string) => {
      const t = selectedText(app).trim() || (await viewer(app).pageText(app.page));
      if (!t.trim()) { toast('Select text or go to a page with text.'); return; }
      if (!lang) { const r = await openDialog({ title: 'Translate', fields: [{ key: 'l', label: 'Into', type: 'combo', options: ['English', 'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Dutch', 'Polish', 'Russian', 'Ukrainian', 'Chinese (Simplified)', 'Japanese', 'Korean', 'Arabic', 'Hebrew', 'Hindi', 'Turkish', 'Greek', 'Swedish'], value: 'Spanish' }] }); if (!r) return; lang = r.l; }
      const a = await ask(app, TASKS.translate(t.slice(0, 12000), lang!), { maxTokens: 3000 });
      if (a != null) await showResult(app, `Translation (${lang})`, cleanText(a));
    },
  },
  {
    id: 'ai.rewriteComment', label: 'Rewrite Comment', icon: 'edit_note', tab: 'AI', group: 'Write', isEnabled: (app) => !!selectedAnnotation(app)?.info.contents, tip: 'Rephrase the selected comment (more polite, shorter, clearer…)',
    run: async (app) => {
      const s = selectedAnnotation(app); if (!s?.info.contents) { toast('Select a comment with text first.'); return; }
      const r = await openDialog({ title: 'Rewrite Comment', fields: [{ key: 't', label: 'Make it', type: 'combo', options: ['more polite and constructive', 'shorter', 'clearer', 'more formal', 'more direct'], value: 'more polite and constructive' }] });
      if (!r) return;
      const a = await ask(app, TASKS.rewriteComment(s.info.contents, r.t), { tier: 'fast', maxTokens: 300 });
      if (a == null) return;
      const out = await openDialog({ title: 'Rewrite Comment', fields: [{ key: 't', label: 'New text', type: 'textarea', rows: 4, value: cleanText(a) }], ok: 'Replace' });
      if (out) app.edit('Rewrite Comment', (doc) => setAnnotationProps(doc, s.page, s.ref, { contents: String(out.t) }));
    },
  },
  {
    id: 'ai.replyComment', label: 'Draft Reply', icon: 'reply', tab: 'AI', group: 'Write', isEnabled: (app) => !!selectedAnnotation(app)?.info.contents,
    run: async (app) => {
      const s = selectedAnnotation(app); if (!s?.info.contents) { toast('Select a comment first.'); return; }
      const ctx = (await viewer(app).pageText(s.page.index)).slice(0, 2000);
      const a = await ask(app, TASKS.replyComment(s.info.contents, ctx), { tier: 'fast', maxTokens: 300 });
      if (a == null) return;
      const out = await openDialog({ title: 'Reply', fields: [{ key: 't', label: 'Reply', type: 'textarea', rows: 4, value: cleanText(a) }], ok: 'Post Reply' });
      if (out) app.edit('Reply', (doc) => addReply(doc, s.page, s.ref, String(out.t), app.prefs.author));
    },
  },
  {
    id: 'ai.cleanOcr', label: 'Clean OCR Text', icon: 'spellcheck', tab: 'AI', group: 'Write', tip: 'Correct recognition errors in the current page\'s recognized text layer',
    run: async (app) => {
      const { invisibleRuns } = await import('./scan');
      const { replaceRunText } = await import('../pdf/ops/textedit');
      const p = pageOf(app, app.page);
      const runs = invisibleRuns(app.doc, p);
      if (!runs.length) { toast('This page has no recognized text layer (Scan/OCR ▸ Recognize Text).'); return; }
      const a = await ask(app, TASKS.cleanOcr(runs.map((r) => r.text).join('\n')), { maxTokens: 3000 });
      if (a == null) return;
      const lines = cleanText(a).split(/\r?\n/);
      if (lines.length !== runs.length) { toast(`The AI returned ${lines.length} lines for ${runs.length} words; nothing changed. Try Scan/OCR ▸ OCR Cleanup.`); return; }
      const changes = runs.map((r, i) => ({ r, to: lines[i].trim() })).filter((x) => x.to && x.to !== x.r.text);
      if (!changes.length) { toast('No corrections suggested.'); return; }
      const r = await openDialog({ title: 'Clean OCR Text', fields: [{ key: 'c', label: `${changes.length} correction(s)`, type: 'list', multiple: true, rows: 12, options: changes.map((c, i) => ({ value: String(i), label: `${c.r.text} → ${c.to}` })), value: changes.map((_, i) => String(i)) }], ok: 'Apply' });
      if (!r?.c?.length) return;
      app.edit('Clean OCR Text', (doc) => { for (const i of r.c as string[]) replaceRunText(doc, p, changes[+i].r, changes[+i].to); });
    },
  },
  {
    id: 'ai.altText', label: 'Alt Text for Images', icon: 'image_search', tab: 'AI', group: 'Write', tip: 'Describe the pictures on this page (the pictures are sent to a vision-capable provider; others get the nearby text only); stored on each image object',
    run: async (app) => {
      const imgs = listImages(app.doc).filter((im) => im.page === app.page && im.ref);
      if (!imgs.length) { toast('No images on this page.'); return; }
      const ctx = (await viewer(app).pageText(app.page)).slice(0, 1500);
      const results: { im: typeof imgs[number]; alt: string }[] = [];
      for (const im of imgs.slice(0, 6)) {
        let content: string | ContentPart[] = TASKS.altText(ctx);
        try { const { extractImage, rawToRgba } = await import('../pdf/ops/extract'); const ex = extractImage(app.doc, im); let url = ''; if (ex.kind === 'jpeg') url = `data:image/jpeg;base64,${btoa(String.fromCharCode(...ex.data.subarray(0, 2000000)))}`; else { const rgba = rawToRgba(app.doc, ex); if (rgba) { const c = document.createElement('canvas'); const s = Math.min(1, 800 / Math.max(ex.width, ex.height)); c.width = Math.max(1, Math.round(ex.width * s)); c.height = Math.max(1, Math.round(ex.height * s)); const bmp = await createImageBitmap(new ImageData(rgba as any, ex.width, ex.height)); c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height); url = c.toDataURL('image/jpeg', 0.8); } } if (url) content = [{ type: 'text', text: TASKS.altText(ctx) }, { type: 'image', dataUrl: url }]; } catch { /* text only */ }
        const a = await ask(app, content, { tier: 'fast', maxTokens: 120 });
        if (a == null) return;
        results.push({ im, alt: cleanText(a).replace(/^"|"$/g, '') });
      }
      const r = await openDialog({ title: 'Alt Text', wide: true, fields: results.map((x, i) => ({ key: String(i), label: `${x.im.name} (${x.im.width}×${x.im.height})`, type: 'text' as const, value: x.alt })), ok: 'Store', help: 'Stored as /Alt on each image object. Screen readers use structure tags, which Anne\'s Folio cannot create for existing content; the text is kept for tools that read it from the image.' });
      if (!r) return;
      app.edit('Alt Text', (doc) => { results.forEach((x, i) => { if (!r[String(i)]) return; const s = doc.resolve(x.im.ref!) as any; if (s?.dict) { s.dict.set('Alt', PdfString.fromText(String(r[String(i)]))); doc.update(x.im.ref!, s); } }); });
    },
  },

  // Review -----------------------------------------------------------------------------------
  {
    id: 'ai.suggestRedactions', label: 'Suggest Redactions', icon: 'policy', tab: 'AI', group: 'Review', tip: 'Pattern matching (emails, phones, IDs) plus the AI\'s reading of the pages; you choose what to mark',
    run: async (app) => {
      const { PII_PATTERNS, findRects } = await import('./protect');
      const pages = app.doc.pages.map((_, i) => i).slice(0, 60);
      const found = new Map<string, Set<number>>();
      const v = viewer(app);
      for (const i of pages) { const t = await v.pageText(i); for (const pat of PII_PATTERNS) { const re = new RegExp(pat.re, 'g'); let m; while ((m = re.exec(t))) { if (!m[0]) { re.lastIndex++; continue; } const k = m[0].trim(); if (!found.has(k)) found.set(k, new Set()); found.get(k)!.add(i); } } }
      const t = await docText(app, 16000, pages);
      const a = t ? await ask(app, TASKS.suggestRedactions(t), { maxTokens: 1500 }) : null;
      const ai = (a && parseJsonLoose<string[]>(a)) || [];
      for (const s of ai) if (typeof s === 'string' && s.trim().length > 2) { const k = s.trim(); if (!found.has(k)) found.set(k, new Set()); }
      if (!found.size) { toast('Nothing sensitive was found.'); return; }
      const list = [...found.keys()].slice(0, 200);
      const r = await openDialog({ title: 'Suggested Redactions', fields: [{ key: 's', label: `${list.length} candidate(s); mark these`, type: 'list', multiple: true, rows: 14, options: list.map((k, i) => ({ value: String(i), label: `${k}${found.get(k)!.size ? ` (p. ${[...found.get(k)!].map((x) => x + 1).join(', ')})` : ''}` })), value: list.map((_, i) => String(i)) }], ok: 'Mark for Redaction' });
      if (!r?.s?.length) return;
      const marks = new Map<number, [number, number, number, number][]>();
      for (const i of r.s as string[]) { const needle = list[+i]; for (const pg of pages) { const rects = await findRects(app, pg, needle, { caseSensitive: true }); if (rects.length) marks.set(pg, [...(marks.get(pg) || []), ...rects]); } }
      const total = [...marks.values()].reduce((n, x) => n + x.length, 0);
      if (!total) { toast('The strings could not be located on the pages.'); return; }
      app.edit('Suggest Redactions', (doc) => { for (const [pg, rects] of marks) addRedactMark(doc, doc.pages[pg], rects, { author: `${app.prefs.author} (AI)` }); });
      toast(`${total} area(s) marked on ${marks.size} page(s). Protect ▸ Apply Redactions removes them.`, { ms: 7000 });
    },
  },
  { id: 'ai.describePage', label: 'Describe Page', icon: 'description', tab: 'AI', group: 'Review', edits: false, tip: 'A description of the page for readers who cannot see it', run: async (app) => { const t = (await viewer(app).pageText(app.page)).trim(); const a = await ask(app, TASKS.describePage(t || '(the page has no text; it is probably an image or a scan)'), { tier: 'fast', maxTokens: 400 }); if (a != null) await showResult(app, `Page ${app.page + 1} Description`, cleanText(a)); } },
  {
    id: 'ai.suggestBookmarks', label: 'Suggest Bookmarks', icon: 'bookmark_add', tab: 'AI', group: 'Review', tip: 'An outline proposed from the first lines of each page',
    run: async (app) => {
      const v = viewer(app);
      const lines: string[] = [];
      for (let i = 0; i < Math.min(app.doc.pageCount, 150); i++) { const t = (await v.pageText(i)).trim().split('\n').filter((l) => l.trim()).slice(0, 4).join(' | '); lines.push(`Page ${i + 1}: ${t.slice(0, 200)}`); }
      const a = await ask(app, TASKS.suggestBookmarks(lines.join('\n')), { maxTokens: 2000 });
      if (a == null) return;
      const j = parseJsonLoose<{ title: string; page: number; level?: number }[]>(a);
      if (!Array.isArray(j) || !j.length) { toast('The AI answer was not an outline.'); return; }
      const items = j.filter((x) => x?.title && x.page >= 1 && x.page <= app.doc.pageCount);
      const r = await openDialog({ title: 'Suggested Bookmarks', fields: [{ key: 'b', label: 'Keep', type: 'list', multiple: true, rows: 12, options: items.map((x, i) => ({ value: String(i), label: `${'   '.repeat(x.level || 0)}${x.title} (p. ${x.page})` })), value: items.map((_, i) => String(i)) }, { key: 'replace', label: 'Replace the existing bookmarks', type: 'checkbox', value: !readOutlines(app.doc).length }], ok: 'Add' });
      if (!r?.b?.length) return;
      app.edit('Suggest Bookmarks', (doc) => {
        const out: OutlineInput[] = r.replace ? [] : outlinesToInput(readOutlines(doc));
        let last: OutlineInput | null = null;
        for (const i of r.b as string[]) { const x = items[+i]; const node: OutlineInput = { title: x.title, page: x.page - 1, children: [] }; if ((x.level || 0) > 0 && last) (last.children ||= []).push(node); else { out.push(node); last = node; } }
        writeOutlines(doc, out);
      });
      if (!app.ui.paneOpen('bookmarks')) app.ui.openPane('bookmarks');
    },
  },

  // More -------------------------------------------------------------------------------------
  {
    id: 'ai.assistant', label: 'AI Assistant', icon: 'chat', tab: 'AI', group: 'More', edits: false, noRecord: true,
    tip: 'A conversation about this document (its text is sent with your first question)',
    run: async (app) => {
      const log = h('div', { class: 'ql-ai-log', style: 'max-height:45vh;overflow:auto;white-space:pre-wrap;min-width:min(80vw,640px)' });
      const history: ChatMessage[] = [];
      const ctx = await docText(app, 16000);
      for (;;) {
        const r = await openDialog({ title: 'AI Assistant', wide: true, content: log, ok: 'Ask', cancel: 'Close', fields: [{ key: 'q', label: 'Your question', type: 'textarea', rows: 3, value: '' }] });
        if (!r || !String(r.q).trim()) return;
        const q = String(r.q).trim();
        const prompt = history.length ? q : `Document text:\n"""\n${ctx}\n"""\n\nQuestion: ${q}`;
        const ans = await ask(app, history.length ? [{ type: 'text', text: `${history.map((m) => `${m.role === 'user' ? 'Q' : 'A'}: ${typeof m.content === 'string' ? m.content : ''}`).join('\n')}\nQ: ${prompt}` }] : prompt);
        if (ans == null) return;
        history.push({ role: 'user', content: prompt }, { role: 'assistant', content: ans });
        log.append(h('p', null, h('b', null, 'You: '), q), h('p', null, h('b', null, 'AI: '), cleanText(ans)));
      }
    },
  },
  {
    id: 'ai.prompts', label: 'Prompt Library', icon: 'library_books', tab: 'AI', group: 'More', kind: 'menu', edits: false,
    tip: 'Run one of your saved prompts on the selection, the page or the document',
    run: async (app, id?: string) => {
      const s = aiSettings();
      if (id === '__new') {
        const r = await openDialog({ title: 'New Prompt', fields: [{ key: 'name', label: 'Name', type: 'text', value: '' }, { key: 'prompt', label: 'Prompt (the text is added after it)', type: 'textarea', rows: 5, value: '' }, { key: 'input', label: 'Text to send', type: 'select', options: [{ value: 'selection', label: 'The selection (or the page)' }, { value: 'document', label: 'The whole document' }, { value: 'none', label: 'Nothing' }], value: 'selection' }] });
        if (!r?.name || !r.prompt) return;
        saveAiSettings((x) => { x.prompts.push({ id: `pr${Date.now().toString(36)}`, name: r.name, prompt: r.prompt, input: r.input, output: 'pane' } as any); });
        return;
      }
      const p = s.prompts.find((x) => x.id === id);
      if (!p) return;
      const input = p.input === 'none' ? '' : p.input === 'document' ? await docText(app) : selectedText(app).trim() || (await viewer(app).pageText(app.page));
      const ans = await ask(app, input ? `${p.prompt}\n"""\n${input}\n"""` : p.prompt);
      if (ans != null) await showResult(app, p.name, cleanText(ans));
    },
    menu: () => [...aiSettings().prompts.map((p) => ({ id: 'ai.prompts', arg: p.id, label: p.name })), ...(aiSettings().prompts.length ? [{ separator: true }] : []), { id: 'ai.prompts', arg: '__new', label: 'New Prompt…' }],
  },
]);
