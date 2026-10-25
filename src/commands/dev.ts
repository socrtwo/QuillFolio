/** Developer tab: macros (recorded command lists), macro editor, scripts report, structure export, tags, raw objects. */
import { def } from './registry';
import type { App } from '../app';
import type { Macro } from '../prefs';
import { getCommand } from './registry';
import { openDialog, toast, confirmDialog, promptDialog } from '../ui/dialog';
import { h } from '../ui/dom';
import { Dict, PdfStream, Ref, Name, PdfString, type PdfObj } from '../pdf/objects';
import { serialize } from '../pdf/writer';
import { saveBytes, baseName, esc } from './util';

async function runMacro(app: App, name: string): Promise<void> {
  const m = app.prefs.macros.find((x) => x.name === name);
  if (!m) { toast(`No macro named "${name}".`); return; }
  for (const s of m.steps) {
    if (s.id === 'dev.runMacro' && s.arg === name) continue; // never recurse into itself
    if (!getCommand(s.id)) { toast(`Macro "${name}" stopped: the command ${s.id} no longer exists.`); return; }
    const r = app.exec(s.id, s.arg);
    if (r instanceof Promise) await r;
  }
}

function stepsLabel(m: Macro): string {
  return m.steps.map((s) => getCommand(s.id)?.label || s.id).slice(0, 6).join(' → ') + (m.steps.length > 6 ? ' …' : '');
}

/** A JSON-friendly dump of an object graph (depth-limited; streams as summaries). */
export function toJsonish(doc: App['doc'], o: PdfObj, depth: number, seen = new Set<number>()): unknown {
  if (o instanceof Ref) { if (depth <= 0 || seen.has(o.num)) return `${o.num} ${o.gen} R`; seen.add(o.num); return { $ref: `${o.num} ${o.gen} R`, value: toJsonish(doc, doc.fetch(o), depth - 1, seen) }; }
  if (o instanceof Name) return `/${o.name}`;
  if (o instanceof PdfString) return o.toText();
  if (o instanceof PdfStream) return { $stream: o.raw.length, dict: toJsonish(doc, o.dict, depth, seen) };
  if (o instanceof Dict) { const out: Record<string, unknown> = {}; for (const k of o.keys()) out[k] = depth > 0 ? toJsonish(doc, o.get(k)!, depth - 1, seen) : String(o.get(k)); return out; }
  if (Array.isArray(o)) return depth > 0 ? o.map((x) => toJsonish(doc, x, depth - 1, seen)) : `[${o.length}]`;
  return o as unknown;
}

/** Counts and lists the script/action entries Anne's Folio never runs. */
function scriptsReport(app: App): { text: string; count: number }[] {
  const doc = app.doc;
  const out: { text: string; count: number }[] = [];
  const names = doc.getDict(doc.catalog, 'Names');
  const js = names ? doc.getDict(names, 'JavaScript') : null;
  if (js) out.push({ text: 'Document-level JavaScript (Names ▸ JavaScript tree)', count: 1 });
  if (doc.catalog.has('OpenAction')) out.push({ text: `Open action: ${doc.getName(doc.getDict(doc.catalog, 'OpenAction'), 'S') || 'destination'}`, count: 1 });
  if (doc.catalog.has('AA')) out.push({ text: 'Document additional actions (AA)', count: 1 });
  let pageAA = 0, annotActs = 0, fieldActs = 0;
  for (const p of doc.pages) { if (p.dict.has('AA')) pageAA++; for (const a of doc.getArray(p.dict, 'Annots') || []) { const d = doc.resolve(a); if (d instanceof Dict) { if (d.has('AA')) annotActs++; const act = doc.getDict(d, 'A'); if (act && doc.getName(act, 'S') === 'JavaScript') annotActs++; } } }
  const af = doc.getDict(doc.catalog, 'AcroForm');
  for (const f of doc.getArray(af, 'Fields') || []) { const d = doc.resolve(f); if (d instanceof Dict && d.has('AA')) fieldActs++; }
  if (pageAA) out.push({ text: 'Pages with open/close actions', count: pageAA });
  if (annotActs) out.push({ text: 'Annotations with JavaScript or event actions', count: annotActs });
  if (fieldActs) out.push({ text: 'Form fields with calculate/format/validate scripts', count: fieldActs });
  if (af?.has('XFA')) out.push({ text: 'XFA form (XML forms architecture)', count: 1 });
  return out;
}

def([
  {
    id: 'dev.macros', label: 'Macros', icon: 'smart_button', tab: 'Developer', group: 'Code', keys: ['Alt-F8'], edits: false, noRecord: true,
    tip: 'Run, rename, delete or put a macro on the Quick Access Bar',
    run: async (app) => {
      const ms = app.prefs.macros;
      if (!ms.length) { toast('No macros yet. Use Record Macro to make one.', { action: 'Record', onAction: () => app.exec('dev.recordMacro') }); return; }
      const r = await openDialog({ title: 'Macros', fields: [
        { key: 'm', label: 'Macro', type: 'list', options: ms.map((m) => ({ value: m.name, label: `${m.name} — ${stepsLabel(m)}` })), value: ms[0].name },
        { key: 'act', label: 'Action', type: 'radio', options: [{ value: 'run', label: 'Run' }, { value: 'edit', label: 'Edit…' }, { value: 'rename', label: 'Rename…' }, { value: 'qat', label: 'Add to Quick Access Bar' }, { value: 'delete', label: 'Delete' }], value: 'run' },
      ] });
      if (!r?.m) return;
      const m = ms.find((x) => x.name === r.m)!;
      if (r.act === 'run') await runMacro(app, m.name);
      else if (r.act === 'edit') app.exec('dev.macroEditor', m.name);
      else if (r.act === 'rename') { const n = await promptDialog('Rename Macro', 'Name', m.name); if (n && !ms.some((x) => x.name === n)) { const old = m.name; m.name = n; app.prefs.qat = app.prefs.qat.map((q) => (q === `macro:${old}` ? `macro:${n}` : q)); app.savePrefs(); app.ui.renderQat(); } }
      else if (r.act === 'qat') { if (!app.prefs.qat.includes(`macro:${m.name}`)) app.prefs.qat = [...app.prefs.qat, `macro:${m.name}`]; app.savePrefs(); app.ui.renderQat(); }
      else if (r.act === 'delete' && (await confirmDialog('Delete Macro', `Delete "${m.name}"?`, 'Delete'))) { app.prefs.macros = ms.filter((x) => x !== m); app.prefs.qat = app.prefs.qat.filter((q) => q !== `macro:${m.name}`); app.savePrefs(); app.ui.renderQat(); }
    },
  },
  { id: 'dev.runMacro', label: 'Run Macro', icon: 'play_arrow', tab: 'Developer', group: 'Code', internal: true, noRecord: true, edits: false, run: (app, name: string) => runMacro(app, name) },
  {
    id: 'dev.recordMacro', label: 'Record Macro', icon: 'fiber_manual_record', tab: 'Developer', group: 'Code', kind: 'toggle', noRecord: true, edits: false,
    tip: 'Record the commands you run (page changes, marks, exports) to replay them later',
    isActive: (app) => !!app.recording,
    run: async (app) => {
      if (app.recording) { app.exec('dev.stopRecording'); return; }
      const name = await promptDialog('Record Macro', 'Macro name', `Macro${app.prefs.macros.length + 1}`);
      if (!name) return;
      if (app.prefs.macros.some((m) => m.name === name) && !(await confirmDialog('Record Macro', `Replace the macro "${name}"?`, 'Replace'))) return;
      app.recording = { name, steps: [] };
      app.recordingPaused = false;
      app.ui.status?.('● Recording macro');
    },
  },
  {
    id: 'dev.stopRecording', label: 'Stop Recording', icon: 'stop', tab: 'Developer', group: 'Code', noRecord: true, edits: false, isEnabled: (app) => !!app.recording,
    run: (app) => {
      const rec = app.recording;
      if (!rec) return;
      app.recording = null;
      app.ui.status?.('');
      if (!rec.steps.length) { toast('Nothing was recorded.'); return; }
      app.prefs.macros = [...app.prefs.macros.filter((m) => m.name !== rec.name), { name: rec.name, steps: rec.steps, created: Date.now() }];
      app.savePrefs();
      toast(`Macro "${rec.name}" saved with ${rec.steps.length} step(s).`, { action: 'Add to QAT', onAction: () => { app.prefs.qat = [...app.prefs.qat, `macro:${rec.name}`]; app.savePrefs(); app.ui.renderQat(); } });
    },
  },
  {
    id: 'dev.macroEditor', label: 'Macro Editor', icon: 'code', tab: 'Developer', group: 'Code', noRecord: true, edits: false,
    tip: 'Edit a macro\'s steps (one command per line: id and an optional JSON argument)',
    run: async (app, name?: string) => {
      const ms = app.prefs.macros;
      const m = ms.find((x) => x.name === name) || ms[0];
      const text = m ? m.steps.map((s) => (s.arg === undefined ? s.id : `${s.id} ${JSON.stringify(s.arg)}`)).join('\n') : 'organize.rotateRight\ncomment.flatten';
      const r = await openDialog({ title: m ? `Edit Macro: ${m.name}` : 'New Macro', wide: true, fields: [
        { key: 'name', label: 'Name', type: 'text', value: m?.name || `Macro${ms.length + 1}` },
        { key: 'desc', label: 'Description', type: 'text', value: m?.description || '' },
        { key: 'steps', label: 'Steps', type: 'textarea', rows: 14, value: text, help: 'Find command ids in Help ▸ Command Reference or the Customize dialogs. Macros run Anne\'s Folio commands only; they cannot reach files, the network or other apps.' },
      ], validate: (v) => {
        for (const [i, line] of String(v.steps).split('\n').entries()) {
          const t = line.trim(); if (!t || t.startsWith('#')) continue;
          const [id, ...rest] = t.split(/\s+/);
          if (!getCommand(id)) return `Line ${i + 1}: unknown command "${id}".`;
          if (rest.length) { try { JSON.parse(rest.join(' ')); } catch { return `Line ${i + 1}: the argument is not valid JSON.`; } }
        }
        return v.name ? null : 'Give the macro a name.';
      } });
      if (!r) return;
      const steps = String(r.steps).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => { const [id, ...rest] = l.split(/\s+/); return rest.length ? { id, arg: JSON.parse(rest.join(' ')) } : { id }; });
      app.prefs.macros = [...ms.filter((x) => x.name !== r.name && x !== m), { name: r.name, description: r.desc || undefined, steps, created: m?.created || Date.now() }];
      app.savePrefs();
      toast(`Saved "${r.name}".`, { action: 'Run', onAction: () => void runMacro(app, r.name) });
    },
  },
  {
    id: 'dev.macroSecurity', label: 'Macro Security', icon: 'admin_panel_settings', tab: 'Developer', group: 'Code', noRecord: true, edits: false,
    run: async () => { await openDialog({ title: 'Macro Security', ok: 'Close', cancel: false, fields: [{ key: 'i', type: 'info', html: '<p><b>Anne\'s Folio macros are lists of Anne\'s Folio commands.</b> They can do only what you could do with the ribbon: mark up, organize pages, export. They cannot run code, read or write files on their own, or use the network.</p><p><b>JavaScript inside PDF files</b> (document scripts, field calculations, link actions) is <b>never run</b> by Anne\'s Folio. Developer ▸ Scripts in This Document lists what is there; Protect ▸ Remove JavaScript strips it.</p>' }] }); },
  },
  {
    id: 'dev.javaScriptInfo', label: 'Scripts in This Document', icon: 'code_off', tab: 'Developer', group: 'Code', noRecord: true, edits: false,
    tip: 'List the JavaScript and actions the file carries (read-only; never executed)',
    run: (app) => { const items = scriptsReport(app); app.ui.openPane('report', { title: 'Scripts and Actions', items: items.length ? items.map((x) => ({ level: 'warning' as const, text: `${x.text}: ${x.count}` })) : [{ level: 'info', text: 'No scripts or actions found.' }], actions: items.length ? [{ label: 'Remove them', run: () => app.exec('protect.removeJavaScript') }] : [] }); },
  },
  {
    id: 'dev.exportStructure', label: 'Export Structure JSON', icon: 'download', tab: 'Developer', group: 'Data', noRecord: true, edits: false,
    tip: 'The trailer, catalog, page tree and page dictionaries as JSON (object numbers kept, streams summarized)',
    run: async (app) => {
      const d = app.doc;
      const dump = { file: app.tab.fileName, header: d.report.header, xrefStream: d.usesXrefStream, encrypted: !!d.security, objects: d.objectNumbers().length, trailer: toJsonish(d, d.trailer, 1), catalog: toJsonish(d, d.catalog, 3), pages: d.pages.map((p) => ({ index: p.index, ref: p.ref ? `${p.ref.num} ${p.ref.gen} R` : null, mediaBox: p.mediaBox, cropBox: p.cropBox, rotate: p.rotate, dict: toJsonish(d, p.dict, 2) })) };
      await saveBytes(JSON.stringify(dump, null, 1), `${baseName(app)} structure.json`, 'application/json');
    },
  },
  {
    id: 'dev.tags', label: 'Tag Structure', icon: 'sell', tab: 'Developer', group: 'Data', noRecord: true, edits: false,
    tip: 'Whether the document is tagged, and the structure element types it uses',
    run: async (app) => {
      const d = app.doc;
      const root = d.getDict(d.catalog, 'StructTreeRoot');
      const mi = d.getDict(d.catalog, 'MarkInfo');
      const counts = new Map<string, number>();
      let n = 0;
      const walk = (o: PdfObj | undefined, depth: number) => { if (depth > 40 || n > 20000) return; const x = d.resolve(o); if (Array.isArray(x)) { for (const k of x) walk(k, depth + 1); return; } if (!(x instanceof Dict)) return; const s = d.getName(x, 'S'); if (s) { counts.set(s, (counts.get(s) || 0) + 1); n++; } walk(x.get('K'), depth + 1); };
      if (root) walk(root.get('K'), 0);
      const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`);
      await openDialog({ title: 'Tag Structure', ok: 'Close', cancel: false, content: h('div', null, h('p', null, root ? `Tagged: ${mi && d.get(mi, 'Marked') === true ? 'yes (MarkInfo/Marked)' : 'structure tree present, MarkInfo not set'}; ${n} structure element(s).` : 'The document is not tagged (no StructTreeRoot). Anne\'s Folio cannot add tags to existing content.'), rows.length ? h('pre', { class: 'ql-notices' }, rows.join('\n')) : null, root && root.has('RoleMap') ? h('p', { class: 'ql-help' }, `Role map: ${esc(Object.entries(toJsonish(d, root.get('RoleMap')!, 1) as any).map(([k, v]) => `${k}→${v}`).join(', '))}`) : null) });
    },
  },
  {
    id: 'dev.rawObject', label: 'Raw Object…', icon: 'data_object', tab: 'Developer', group: 'Data', noRecord: true, edits: false,
    tip: 'Show any object by number as PDF syntax (and a stream\'s decoded bytes)',
    run: async (app, num?: number) => {
      const d = app.doc;
      let n = num;
      if (n == null) { const r = await promptDialog('Raw Object', `Object number (1–${d.size - 1}; the catalog is ${d.catalogRef.num})`, String(d.catalogRef.num)); if (!r) return; n = parseInt(r, 10); }
      if (!Number.isFinite(n!)) return;
      const ref = new Ref(n!, d.genOf(n!));
      let obj: PdfObj;
      try { obj = d.fetch(ref); } catch (e: any) { toast(`Object ${n}: ${e?.message || e}`); return; }
      let text = new TextDecoder('latin1').decode(serialize(obj instanceof PdfStream ? obj.dict : obj));
      if (obj instanceof PdfStream) { let body = ''; try { const dec = d.decoded(obj); body = new TextDecoder('latin1').decode(dec.subarray(0, 60000)) + (dec.length > 60000 ? `\n… (${dec.length} bytes)` : ''); } catch (e: any) { body = `(could not decode: ${e?.message || e})`; } text += `\nstream (${obj.raw.length} raw bytes)\n${body}\nendstream`; }
      await openDialog({ title: `Object ${n} ${ref.gen}`, wide: true, ok: 'Close', cancel: false, content: h('pre', { class: 'ql-notices', style: 'max-height:60vh;overflow:auto;font-size:12px;white-space:pre-wrap' }, text), buttons: [{ label: 'Copy', onClick: () => { navigator.clipboard?.writeText(text); toast('Copied'); } }] });
    },
  },
]);
