/** Sign tab: fill & sign (drawn, typed or picture signatures, initials, date, check marks), signature fields, requests, verification. */
import { def } from './registry';
import type { App } from '../app';
import { openDialog, toast, confirmDialog } from '../ui/dialog';
import { h, pickFile } from '../ui/dom';
import { kvGet, kvSet, kvDel, kvKeys } from '../util/store';
import { readSignatures, readFields } from '../pdf/structure';
import { addField } from '../pdf/ops/forms';
import { addInk } from '../pdf/ops/annots';
import { imageRefFromFile, pageOf, esc } from './util';
import { openExternal } from '../platform/native';

interface SavedSig { name: string; png: ArrayBuffer; width: number; height: number; kind: 'signature' | 'initials'; when: number }

/** A drawing pad inside a dialog; returns a PNG blob with a transparent background. */
function drawPad(width = 480, height = 160): { el: HTMLElement; blob: () => Promise<Blob | null>; clear: () => void; isEmpty: () => boolean } {
  const c = h('canvas', { width: String(width * 2), height: String(height * 2), class: 'qf-sigpad', style: `width:${width}px;max-width:100%;height:${height}px;border:1px dashed #999;border-radius:6px;background:#fff;touch-action:none` }) as HTMLCanvasElement;
  const ctx = c.getContext('2d')!;
  ctx.scale(2, 2); ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#102a6b';
  let drawing = false, empty = true;
  const pos = (e: PointerEvent): [number, number] => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * (width / r.width), (e.clientY - r.top) * (height / r.height)]; };
  c.addEventListener('pointerdown', (e) => { drawing = true; empty = false; c.setPointerCapture(e.pointerId); const [x, y] = pos(e); ctx.beginPath(); ctx.moveTo(x, y); e.preventDefault(); });
  c.addEventListener('pointermove', (e) => { if (!drawing) return; const [x, y] = pos(e); ctx.lineTo(x, y); ctx.stroke(); });
  c.addEventListener('pointerup', () => { drawing = false; });
  c.addEventListener('pointercancel', () => { drawing = false; });
  const line = h('div', { style: 'position:absolute;left:24px;right:24px;bottom:34px;border-bottom:1px solid #bbb;pointer-events:none' });
  const el = h('div', { style: 'position:relative;display:inline-block' }, c, line);
  return { el, blob: () => new Promise((res) => c.toBlob(res, 'image/png')), clear: () => { ctx.clearRect(0, 0, width, height); empty = true; }, isEmpty: () => empty };
}

/** Renders typed text in the bundled serif italic onto a transparent PNG. */
async function typedPng(text: string, size = 44): Promise<Blob | null> {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  const font = `italic ${size}px "EB Garamond", "Georgia", serif`;
  try { await (document as any).fonts?.load(font); } catch { /* fallback font */ }
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 24;
  c.width = w * 2; c.height = size * 1.6 * 2;
  const g = c.getContext('2d')!; g.scale(2, 2); g.font = font; g.fillStyle = '#102a6b'; g.textBaseline = 'alphabetic';
  g.fillText(text, 12, size * 1.15);
  return new Promise((res) => c.toBlob(res, 'image/png'));
}

async function savedSignatures(kind: 'signature' | 'initials'): Promise<{ key: string; sig: SavedSig }[]> {
  const keys = await kvKeys('sig:');
  const out: { key: string; sig: SavedSig }[] = [];
  for (const k of keys) { const s = await kvGet<SavedSig>(k); if (s && s.kind === kind) out.push({ key: k, sig: s }); }
  return out.sort((a, b) => b.sig.when - a.sig.when);
}

/** Lets the user draw, type, pick or reuse a signature; arms the Sign tool with it. */
async function signatureDialog(app: App, kind: 'signature' | 'initials'): Promise<void> {
  const saved = await savedSignatures(kind);
  const pad = drawPad(kind === 'initials' ? 200 : 480, kind === 'initials' ? 120 : 160);
  const preview = h('img', { style: 'max-width:100%;max-height:120px;display:none;border:1px solid #ddd;background:#fff' }) as HTMLImageElement;
  let picked: Blob | null = null;
  const title = kind === 'initials' ? 'Initials' : 'Signature';
  const r = await openDialog({ title: `Add ${title}`, wide: true, fields: [
    { key: 'mode', label: 'How', type: 'radio', options: [...(saved.length ? [{ value: 'saved', label: 'Use a saved one' }] : []), { value: 'draw', label: 'Draw' }, { value: 'type', label: 'Type' }, { value: 'image', label: 'Picture of your signature' }], value: saved.length ? 'saved' : 'draw' },
    ...(saved.length ? [{ key: 'saved', label: 'Saved', type: 'select' as const, options: saved.map((s) => ({ value: s.key, label: `${s.sig.name} (${new Date(s.sig.when).toLocaleDateString()})` })), value: saved[0].key, visibleIf: (v: any) => v.mode === 'saved' }] : []),
    { key: 'text', label: 'Name', type: 'text', value: kind === 'initials' ? app.prefs.initials : app.prefs.author, visibleIf: (v) => v.mode === 'type' },
    { key: 'file', label: 'Picture (PNG with transparent background works best)', type: 'file', accept: 'image/*', visibleIf: (v) => v.mode === 'image' },
    { key: 'save', label: 'Save for next time (kept on this device only)', type: 'checkbox', value: true, visibleIf: (v) => v.mode !== 'saved' },
    { key: 'name', label: 'Name for the saved signature', type: 'text', value: app.prefs.author, visibleIf: (v) => v.mode !== 'saved' && v.save },
  ], content: h('div', null, pad.el, preview), onChange: (v) => { pad.el.style.display = v.mode === 'draw' ? '' : 'none'; preview.style.display = v.mode === 'type' || v.mode === 'image' ? '' : 'none'; if (v.mode === 'type') void typedPng(v.text || ' ').then((b) => { if (b) preview.src = URL.createObjectURL(b); }); if (v.mode === 'image' && v.file instanceof File) { picked = v.file; preview.src = URL.createObjectURL(v.file); } }, onOpen: (ctl) => { const v = ctl.values(); pad.el.style.display = v.mode === 'draw' ? '' : 'none'; preview.style.display = 'none'; }, buttons: [{ label: 'Clear Drawing', onClick: () => pad.clear() }], ok: 'Place on Page' });
  if (!r) return;
  let blob: Blob | null = null;
  let saveName = '';
  if (r.mode === 'saved') { const s = saved.find((x) => x.key === r.saved)!.sig; blob = new Blob([s.png], { type: 'image/png' }); }
  else if (r.mode === 'draw') { if (pad.isEmpty()) { toast('Draw your signature first.'); return; } blob = await pad.blob(); saveName = r.name; }
  else if (r.mode === 'type') { if (!String(r.text).trim()) { toast('Type your name first.'); return; } blob = await typedPng(String(r.text)); saveName = r.name; }
  else { blob = picked || (r.file instanceof File ? r.file : null); if (!blob) { toast('Choose a picture first.'); return; } saveName = r.name; }
  if (!blob) return;
  const im = await imageRefFromFile(app, blob);
  if (r.mode !== 'saved' && r.save) await kvSet(`sig:${Date.now()}`, { name: saveName || title, png: await blob.arrayBuffer(), width: im.width, height: im.height, kind, when: Date.now() } as SavedSig);
  app.tab.ui.setTool('sign', { image: im.ref, width: im.width, height: im.height });
  toast(`Click or drag on the page to place your ${title.toLowerCase()}.`, { ms: 3000 });
}

/** Ink strokes for a check mark or a cross inside a box. */
function mark(app: App, kind: 'check' | 'cross'): void {
  app.tab.ui.setTool('stamp', { mark: kind });
  toast(`Click where the ${kind === 'check' ? 'check mark' : 'cross'} goes.`, { ms: 2500 });
}

export function placeMark(app: App, page: number, x: number, y: number, kind: 'check' | 'cross', size = 14): void {
  const p = pageOf(app, page);
  const s = size;
  const strokes: [number, number][][] = kind === 'check'
    ? [[[x, y + s * 0.45], [x + s * 0.35, y + s * 0.1], [x + s, y + s * 0.9]]]
    : [[[x, y], [x + s, y + s]], [[x, y + s], [x + s, y]]];
  app.edit(kind === 'check' ? 'Check Mark' : 'Cross', (doc) => addInk(doc, p, strokes, { color: [0.06, 0.16, 0.42], width: 2, author: app.prefs.author, subject: 'Fill & Sign' }));
}

def([
  { id: 'sign.signature', label: 'Sign', icon: 'draw', tab: 'Sign', group: 'Fill & Sign', popular: true, keys: ['Mod-Shift-s'], noRecord: true, tip: 'Draw, type or pick a picture of your signature, then click where it goes', run: (app) => signatureDialog(app, 'signature') },
  { id: 'sign.initials', label: 'Initials', icon: 'abc', tab: 'Sign', group: 'Fill & Sign', noRecord: true, run: (app) => signatureDialog(app, 'initials') },
  { id: 'sign.dateStamp', label: 'Date', icon: 'event', tab: 'Sign', group: 'Fill & Sign', noRecord: true, tip: 'Click where today\'s date goes (drawn into the page)', run: (app) => { app.tab.ui.setTool('stamp', { date: true }); toast('Click where the date goes.', { ms: 2500 }); } },
  { id: 'sign.checkmark', label: 'Check Mark', icon: 'check', tab: 'Sign', group: 'Fill & Sign', noRecord: true, run: (app) => mark(app, 'check') },
  { id: 'sign.cross', label: 'Cross', icon: 'close', tab: 'Sign', group: 'Fill & Sign', noRecord: true, run: (app) => mark(app, 'cross') },
  {
    id: 'sign.manageSignatures', label: 'Saved Signatures…', icon: 'manage_accounts', tab: 'Sign', group: 'Fill & Sign', noRecord: true, edits: false,
    run: async (app) => {
      const all = [...(await savedSignatures('signature')), ...(await savedSignatures('initials'))];
      if (!all.length) { toast('No saved signatures yet. Sign once and keep "Save for next time" on.'); return; }
      const r = await openDialog({ title: 'Saved Signatures', fields: [{ key: 'k', label: 'Delete', type: 'list', multiple: true, rows: 8, options: all.map((s) => ({ value: s.key, label: `${s.sig.name} — ${s.sig.kind} — ${new Date(s.sig.when).toLocaleString()}` })), value: [] }], ok: 'Delete Selected', help: 'Signatures are stored only on this device.' });
      if (!r?.k?.length) return;
      for (const k of r.k) await kvDel(k);
      toast(`${r.k.length} deleted.`);
      void app;
    },
  },
  {
    id: 'sign.requestSignatures', label: 'Request Signatures…', icon: 'send', tab: 'Sign', group: 'Signature Fields', noRecord: true,
    tip: 'Add a signature field for each signer at the bottom of the last page and draft an email asking them to sign',
    run: async (app) => {
      const r = await openDialog({ title: 'Request Signatures', fields: [
        { key: 'who', label: 'Signers (one per line: Name <email>)', type: 'textarea', rows: 4, value: '' },
        { key: 'where', label: 'Put the fields on', type: 'radio', options: [{ value: 'last', label: 'The last page' }, { value: 'current', label: 'The current page' }], value: 'last' },
        { key: 'subject', label: 'Email subject', type: 'text', value: `Please sign: ${app.tab.title}` },
        { key: 'msg', label: 'Message', type: 'textarea', rows: 3, value: `Please open the attached PDF in QuillFolio (or any PDF reader), sign in your field, and send it back.` },
      ], ok: 'Add Fields and Draft Email' });
      if (!r || !String(r.who).trim()) return;
      const signers = String(r.who).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const m = /^(.*?)\s*<([^>]+)>\s*$/.exec(l); return { name: m ? m[1].trim() || m[2] : l, email: m ? m[2] : '' }; });
      const pi = r.where === 'current' ? app.page : app.doc.pageCount - 1;
      const p = pageOf(app, pi);
      const existing = new Set(readFields(app.doc).map((f) => f.name));
      app.edit('Request Signatures', (doc) => {
        const w = Math.min(220, (p.cropBox[2] - p.cropBox[0] - 72) / Math.min(2, signers.length) - 12);
        signers.forEach((s, i) => {
          let name = `Signature ${s.name}`; let k = 2; while (existing.has(name)) name = `Signature ${s.name} ${k++}`; existing.add(name);
          const col = i % 2, row = Math.floor(i / 2);
          const x = p.cropBox[0] + 36 + col * (w + 24), y = p.cropBox[1] + 36 + row * 70;
          addField(doc, { name, type: 'signature', page: pi, rect: [x, y, x + w, y + 44], tooltip: `Signature of ${s.name}`, border: [0.3, 0.3, 0.3] });
          const { insertText } = requireTextEdit();
          insertText(doc, p, x, y - 11, `${s.name}${s.email ? ` <${s.email}>` : ''}`, { size: 8, color: [0.3, 0.3, 0.3] });
        });
      });
      const to = signers.map((s) => s.email).filter(Boolean).join(',');
      openExternal(`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(r.subject)}&body=${encodeURIComponent(`${r.msg}\n\n(Attach ${app.tab.fileName || app.tab.title + '.pdf'} after saving it.)`)}`);
      toast(`${signers.length} signature field(s) added. Save the PDF and attach it to the email draft.`, { ms: 7000 });
    },
  },
  {
    id: 'sign.verify', label: 'Verify Signatures', icon: 'verified_user', tab: 'Sign', group: 'Signature Fields', edits: false, noRecord: true,
    tip: 'List the digital signatures and check that each covers the whole file (certificate validation is not implemented yet)',
    run: (app) => {
      const sigs = readSignatures(app.doc);
      if (!sigs.length) { app.ui.openPane('report', { title: 'Signatures', items: [{ level: 'info', text: 'The document has no signature fields.' }], actions: [{ label: 'Add a signature field', run: () => app.exec('forms.signatureField') }] }); return; }
      const items = sigs.map((s) => s.signed
        ? { level: (s.coversWholeFile ? 'info' : 'warning') as 'info' | 'warning', text: `${s.field}: signed by ${s.signer || 'unknown'}${s.date ? ` on ${s.date.toLocaleString()}` : ''}${s.reason ? `, reason: ${s.reason}` : ''} (${s.subFilter || s.filter})`, fix: s.coversWholeFile ? 'The byte range covers the whole file: nothing was appended after signing.' : 'The byte range does not cover the whole file: the document was changed after it was signed (incremental updates follow the signature). The cryptographic check of the certificate is not implemented in this version.' }
        : { level: 'info' as const, text: `${s.field}: unsigned signature field` });
      app.ui.openPane('report', { title: 'Signatures', items, html: h('p', { class: 'ql-help' }, 'QuillFolio checks the byte ranges of existing signatures. Validating certificates and creating certificate-based signatures are on the roadmap; Fill & Sign places a visual signature.') });
    },
  },
  {
    id: 'sign.clearSignatureField', label: 'Clear Signature Field', icon: 'backspace', tab: 'Sign', group: 'Signature Fields', isEnabled: (app) => readSignatures(app.doc).some((s) => s.signed),
    tip: 'Remove the signature value from a signed field (the document is then unsigned)',
    run: async (app) => {
      const signed = readFields(app.doc).filter((f) => f.type === 'signature' && f.dict.has('V'));
      if (!signed.length) return;
      const r = await openDialog({ title: 'Clear Signature Field', fields: [{ key: 'f', label: 'Field', type: 'select', options: signed.map((f) => f.name), value: signed[0].name }] });
      if (!r || !(await confirmDialog('Clear Signature', 'Remove the signature? The document will no longer be signed.', 'Clear'))) return;
      const f = signed.find((x) => x.name === r.f)!;
      app.edit('Clear Signature', (doc) => { f.dict.delete('V'); doc.update(f.ref, f.dict); });
    },
  },
]);

import * as textEditMod from '../pdf/ops/textedit';
function requireTextEdit() { return textEditMod; }
export { esc, savedSignatures };
