/**
 * Interactive forms (ISO 32000-1 §12.7): filling fields with regenerated appearances, creating and
 * deleting fields, calculation and tab order, reset, flattening, and FDF/XFDF/CSV/JSON data exchange.
 */
import { Dict, Name, PdfObj, PdfStream, PdfString, Ref, latin1 } from '../objects';
import { flateStream } from '../filters';
import { PdfDocument, PageInfo } from '../document';
import { fmtNum } from '../writer';
import { ensureAcroForm, readFields, touchAcroForm, FieldInfo, FieldType, addAnnotation, removeAnnotation } from '../structure';
import { stdFontRef, lit } from '../build';
import { textWidth, winAnsiBytes, wrapText, type StdFont } from '../stdfonts';
import { flattenAnnotations } from './annots';
import { bytesOf } from '../objects';

type RGB = [number, number, number];
type Rect = [number, number, number, number];

/** Parses a default appearance string: font resource name, size, color. */
export function parseDA(da: string): { font: string; size: number; color: string } {
  const f = /\/([^\s/]+)\s+([\d.]+)\s+Tf/.exec(da);
  const g = /([\d.]+)\s+g\b/.exec(da), rg = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg\b/.exec(da);
  return { font: f ? f[1] : 'Helv', size: f ? +f[2] : 0, color: rg ? `${rg[1]} ${rg[2]} ${rg[3]} rg` : g ? `${g[1]} g` : '0 g' };
}

function fieldFont(doc: PdfDocument, resName: string): { name: string; ref: Ref; std: StdFont } {
  const af = ensureAcroForm(doc);
  let dr = doc.getDict(af, 'DR');
  if (!dr) { dr = new Dict(); af.set('DR', dr); }
  let fonts = doc.getDict(dr, 'Font');
  if (!fonts) { fonts = new Dict(); dr.set('Font', fonts); }
  const existing = fonts.get(resName);
  if (existing instanceof Ref) {
    const fd = doc.resolve<Dict | null>(existing);
    const base = fd instanceof Dict ? doc.getName(fd, 'BaseFont') : '';
    const std = (/Cour/i.test(base) ? 'Courier' : /Times|Tiro/i.test(base) ? 'Times-Roman' : 'Helvetica') as StdFont;
    return { name: resName, ref: existing, std };
  }
  const ref = stdFontRef(doc, 'Helvetica');
  fonts.set(resName === 'Helv' || !resName ? 'Helv' : resName, ref);
  touchAcroForm(doc);
  return { name: resName || 'Helv', ref, std: 'Helvetica' };
}

function widgetStyle(doc: PdfDocument, w: Dict): { border: RGB | null; bg: RGB | null; width: number } {
  const mk = doc.getDict(w, 'MK');
  const c = (k: string): RGB | null => { const a = mk ? doc.getArray(mk, k) : null; if (!a || !a.length) return null; const v = a.map((x) => doc.resolve<number>(x)); return v.length === 1 ? [v[0], v[0], v[0]] : v.length === 3 ? [v[0], v[1], v[2]] : [1 - Math.min(1, v[0] + v[3]), 1 - Math.min(1, v[1] + v[3]), 1 - Math.min(1, v[2] + v[3])]; };
  const bs = doc.getDict(w, 'BS');
  return { border: c('BC'), bg: c('BG'), width: bs ? doc.getNum(bs, 'W', 1) : 1 };
}

/** Builds and stores the appearance stream of a text/choice widget for its current value. */
export function regenerateAppearance(doc: PdfDocument, f: FieldInfo, w: FieldInfo['widgets'][number]): void {
  const r = w.rect;
  const width = r[2] - r[0], height = r[3] - r[1];
  const da = parseDA(f.defaultAppearance || doc.getText(ensureAcroForm(doc), 'DA'));
  const font = fieldFont(doc, da.font);
  const style = widgetStyle(doc, w.dict);
  let ops = '/Tx BMC q ';
  if (style.bg) ops += `${style.bg.map(fmtNum).join(' ')} rg 0 0 ${fmtNum(width)} ${fmtNum(height)} re f `;
  if (style.border) ops += `${style.border.map(fmtNum).join(' ')} RG ${fmtNum(style.width)} w ${fmtNum(style.width / 2)} ${fmtNum(style.width / 2)} ${fmtNum(width - style.width)} ${fmtNum(height - style.width)} re S `;
  const pad = 2 + style.width;
  const values = f.type === 'list' ? f.options.map((o) => o.label || o.value) : [typeof f.value === 'string' ? f.value : Array.isArray(f.value) ? f.value.join(', ') : ''];
  const text = f.password ? '*'.repeat(values[0].length) : values[0];
  let size = da.size;
  const q = doc.getNum(f.dict, 'Q', 0);
  const comb = f.type === 'text' && !!(f.flags & (1 << 24)) && f.maxLen > 0;
  ops += `BT ${da.color} `;
  if (f.type === 'list') {
    if (!size) size = 12;
    const sel = new Set(Array.isArray(f.value) ? f.value : [f.value as string]);
    ops += `/${font.name} ${fmtNum(size)} Tf `;
    f.options.forEach((o, i) => {
      const y = height - pad - (i + 1) * size * 1.15 + size * 0.25;
      if (y < -size) return;
      if (sel.has(o.value) || sel.has(o.label)) ops += `ET q 0.6 0.75 0.85 rg ${fmtNum(pad / 2)} ${fmtNum(y - size * 0.3)} ${fmtNum(width - pad)} ${fmtNum(size * 1.15)} re f Q BT ${da.color} /${font.name} ${fmtNum(size)} Tf `;
      ops += `1 0 0 1 ${fmtNum(pad)} ${fmtNum(y)} Tm ${lit(winAnsiBytes(o.label || o.value))} Tj `;
    });
  } else if (f.multiline) {
    if (!size) size = 10;
    const lines = wrapText(text, font.std, size, width - pad * 2);
    ops += `/${font.name} ${fmtNum(size)} Tf `;
    lines.forEach((l, i) => { const y = height - pad - size * 0.95 - i * size * 1.2; if (y > -size) ops += `1 0 0 1 ${fmtNum(pad)} ${fmtNum(y)} Tm ${lit(winAnsiBytes(l))} Tj `; });
  } else if (comb) {
    if (!size) size = Math.min(height * 0.7, (width / f.maxLen) * 1.2);
    const cell = width / f.maxLen;
    ops += `/${font.name} ${fmtNum(size)} Tf `;
    [...text].slice(0, f.maxLen).forEach((ch, i) => { const cw = textWidth(ch, font.std, size); ops += `1 0 0 1 ${fmtNum(i * cell + (cell - cw) / 2)} ${fmtNum((height - size * 0.7) / 2)} Tm ${lit(winAnsiBytes(ch))} Tj `; });
  } else {
    if (!size) { size = Math.min(12, height * 0.66); while (size > 4 && textWidth(text, font.std, size) > width - pad * 2) size *= 0.92; }
    const tw = textWidth(text, font.std, size);
    const x = q === 1 ? (width - tw) / 2 : q === 2 ? width - pad - tw : pad;
    ops += `/${font.name} ${fmtNum(size)} Tf 1 0 0 1 ${fmtNum(x)} ${fmtNum((height - size * 0.7) / 2)} Tm ${lit(winAnsiBytes(text))} Tj `;
  }
  ops += 'ET Q EMC';
  const res = new Dict({ Font: new Dict({ [font.name]: font.ref }) });
  const s = flateStream(bytesOf(ops), { Type: Name.get('XObject'), Subtype: Name.get('Form'), BBox: [0, 0, width, height], Resources: res });
  const ap = doc.getDict(w.dict, 'AP') || new Dict();
  const old = ap.get('N');
  if (old instanceof Ref) doc.update(old, s); else ap.set('N', doc.register(s));
  w.dict.set('AP', ap);
  // Rotation of the widget (MK/R) is kept through the Matrix.
  const mk = doc.getDict(w.dict, 'MK'); const rot = mk ? doc.getNum(mk, 'R', 0) : 0;
  if (rot) { const a = (rot * Math.PI) / 180; s.dict.set('Matrix', [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), rot === 90 ? width : rot === 180 ? width : 0, rot === 180 ? height : rot === 270 ? height : 0]); s.dict.set('BBox', rot % 180 ? [0, 0, height, width] : [0, 0, width, height]); }
  doc.touch(w.ref);
}

/** Sets a field's value (text, choice, checkbox/radio) and refreshes its widgets' appearances. */
export function setFieldValue(doc: PdfDocument, f: FieldInfo, value: string | string[] | boolean): void {
  if (f.readOnly) throw new Error(`${f.name} is read-only.`);
  if (f.type === 'checkbox' || f.type === 'radio') {
    const on = typeof value === 'boolean' ? value : value !== '' && value !== 'Off' && value !== 'false';
    const states = f.widgets.map((w) => w.onState || 'Yes');
    if (f.type === 'radio') {
      // value: the export name (on state) to select, or true for the first widget
      const want = typeof value === 'string' ? value : on ? states[0] : null;
      f.dict.set('V', want ? Name.get(want) : Name.get('Off'));
      f.widgets.forEach((w) => { w.dict.set('AS', Name.get(w.onState === want ? w.onState! : 'Off')); doc.touch(w.ref); });
    } else {
      f.dict.set('V', Name.get(on ? states[0] : 'Off'));
      f.widgets.forEach((w, i) => { w.dict.set('AS', Name.get(on ? states[i] : 'Off')); doc.touch(w.ref); });
    }
    doc.update(f.ref, f.dict);
    f.value = on;
    return;
  }
  if (f.type === 'text') {
    let text = Array.isArray(value) ? value.join('\n') : String(value === true ? 'Yes' : value === false ? '' : value);
    if (f.maxLen > 0) text = text.slice(0, f.maxLen);
    f.dict.set('V', PdfString.fromText(text));
    f.value = text;
  } else if (f.type === 'combo' || f.type === 'list') {
    const vals = Array.isArray(value) ? value : [String(value)];
    const toExport = vals.map((v) => f.options.find((o) => o.label === v || o.value === v)?.value ?? v);
    f.dict.set('V', toExport.length > 1 ? toExport.map((v) => PdfString.fromText(v)) : PdfString.fromText(toExport[0] || ''));
    f.value = toExport.length > 1 ? toExport : toExport[0] || '';
    if (f.type === 'list') f.dict.set('I', toExport.map((v) => f.options.findIndex((o) => o.value === v)).filter((i) => i >= 0));
  } else return;
  doc.update(f.ref, f.dict);
  for (const w of f.widgets) regenerateAppearance(doc, f, w);
  // Tell readers not to regenerate (we did) but allow it for fonts we lack.
  const af = ensureAcroForm(doc); af.set('NeedAppearances', false); touchAcroForm(doc);
}

export function resetForm(doc: PdfDocument, fields = readFields(doc)): void {
  for (const f of fields) {
    if (f.readOnly) continue;
    const dv = doc.get(f.dict, 'DV');
    if (f.type === 'checkbox' || f.type === 'radio') setFieldValue(doc, f, dv instanceof Name ? dv.name !== 'Off' : false);
    else if (f.type === 'text' || f.type === 'combo' || f.type === 'list') setFieldValue(doc, f, dv instanceof PdfString ? dv.toText() : Array.isArray(dv) ? dv.map((x) => (x instanceof PdfString ? x.toText() : '')) : '');
  }
}

export interface NewField { name: string; type: FieldType; page: number; rect: Rect; options?: string[]; value?: string | boolean; required?: boolean; multiline?: boolean; maxLen?: number; tooltip?: string; fontSize?: number; border?: RGB | null; background?: RGB | null; exportValue?: string; checkStyle?: 'check' | 'circle' | 'cross' | 'square' }

export function addField(doc: PdfDocument, spec: NewField): Ref {
  const af = ensureAcroForm(doc);
  const page = doc.pages[spec.page];
  if (!page) throw new Error('No such page.');
  const ft = spec.type === 'text' ? 'Tx' : spec.type === 'signature' ? 'Sig' : spec.type === 'combo' || spec.type === 'list' ? 'Ch' : 'Btn';
  let flags = 0;
  if (spec.required) flags |= 2;
  if (spec.multiline) flags |= 1 << 12;
  if (spec.type === 'combo') flags |= 1 << 17;
  if (spec.type === 'radio') flags |= 1 << 15;
  if (spec.type === 'button') flags |= 1 << 16;
  const existing = readFields(doc).find((f) => f.name === spec.name);
  const mk = new Dict();
  if (spec.border) mk.set('BC', spec.border); if (spec.background) mk.set('BG', spec.background);
  if (spec.type === 'checkbox' || spec.type === 'radio') mk.set('CA', PdfString.fromText({ check: '4', circle: 'l', cross: '8', square: 'n' }[spec.checkStyle || (spec.type === 'radio' ? 'circle' : 'check')]));
  const widget = new Dict({ Type: Name.get('Annot'), Subtype: Name.get('Widget'), Rect: spec.rect, F: 4, MK: mk, BS: new Dict({ W: 1, S: Name.get('S') }) });
  if (spec.type === 'radio' && existing && existing.type === 'radio') {
    // Another option of an existing radio group.
    widget.set('Parent', existing.ref);
    const on = spec.exportValue || `Choice${existing.widgets.length + 1}`;
    widget.set('AP', new Dict({ N: new Dict({ [on]: checkAppearance(doc, spec.rect, 'circle', true, mk), Off: checkAppearance(doc, spec.rect, 'circle', false, mk) }) }));
    widget.set('AS', Name.get('Off'));
    const ref = addAnnotation(doc, page, widget);
    const kids = (doc.getArray(existing.dict, 'Kids') || []).slice(); kids.push(ref); existing.dict.set('Kids', kids); doc.update(existing.ref, existing.dict);
    return ref;
  }
  const field = widget; // merged field/widget dictionary
  field.set('FT', Name.get(ft));
  field.set('T', PdfString.fromText(spec.name));
  if (flags) field.set('Ff', flags);
  if (spec.tooltip) field.set('TU', PdfString.fromText(spec.tooltip));
  if (spec.maxLen) field.set('MaxLen', spec.maxLen);
  field.set('DA', PdfString.fromText(`/Helv ${fmtNum(spec.fontSize ?? 0)} Tf 0 g`));
  fieldFont(doc, 'Helv');
  if (spec.options) field.set('Opt', spec.options.map((o) => PdfString.fromText(o)));
  if (spec.type === 'checkbox' || spec.type === 'radio') {
    const on = spec.exportValue || 'Yes';
    const style = spec.checkStyle || (spec.type === 'radio' ? 'circle' : 'check');
    field.set('AP', new Dict({ N: new Dict({ [on]: checkAppearance(doc, spec.rect, style, true, mk), Off: checkAppearance(doc, spec.rect, style, false, mk) }) }));
    field.set('AS', Name.get(spec.value === true ? on : 'Off'));
    field.set('V', Name.get(spec.value === true ? on : 'Off'));
  }
  if (spec.type === 'button') {
    field.set('AP', new Dict({ N: buttonAppearance(doc, spec.rect, spec.value ? String(spec.value) : spec.name, mk) }));
    if (!mk.has('CA')) mk.set('CA', PdfString.fromText(spec.value ? String(spec.value) : spec.name));
  }
  const ref = addAnnotation(doc, page, field);
  const fields = (doc.getArray(af, 'Fields') || []).slice(); fields.push(ref); af.set('Fields', fields); touchAcroForm(doc);
  if ((spec.type === 'text' || spec.type === 'combo' || spec.type === 'list') && spec.value !== undefined) {
    const f = readFields(doc).find((x) => x.ref.num === ref.num);
    if (f) setFieldValue(doc, f, spec.value);
  } else if (spec.type === 'text' || spec.type === 'combo' || spec.type === 'list') { const f = readFields(doc).find((x) => x.ref.num === ref.num); if (f) for (const w of f.widgets) regenerateAppearance(doc, f, w); }
  return ref;
}

function checkAppearance(doc: PdfDocument, rect: Rect, style: string, on: boolean, mk: Dict): Ref {
  const w = rect[2] - rect[0], h = rect[3] - rect[1];
  let ops = '';
  const bg = doc.getArray(mk, 'BG'), bc = doc.getArray(mk, 'BC');
  if (bg && bg.length === 3) ops += `${bg.map((x) => fmtNum(doc.resolve<number>(x))).join(' ')} rg 0 0 ${fmtNum(w)} ${fmtNum(h)} re f `;
  if (bc && bc.length === 3) ops += `${bc.map((x) => fmtNum(doc.resolve<number>(x))).join(' ')} RG 1 w 0.5 0.5 ${fmtNum(w - 1)} ${fmtNum(h - 1)} re S `;
  if (on) {
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.3;
    if (style === 'circle') ops += `0 g ${fmtNum(cx + r)} ${fmtNum(cy)} m ${fmtNum(cx + r)} ${fmtNum(cy + r * 0.55)} ${fmtNum(cx + r * 0.55)} ${fmtNum(cy + r)} ${fmtNum(cx)} ${fmtNum(cy + r)} c ${fmtNum(cx - r * 0.55)} ${fmtNum(cy + r)} ${fmtNum(cx - r)} ${fmtNum(cy + r * 0.55)} ${fmtNum(cx - r)} ${fmtNum(cy)} c ${fmtNum(cx - r)} ${fmtNum(cy - r * 0.55)} ${fmtNum(cx - r * 0.55)} ${fmtNum(cy - r)} ${fmtNum(cx)} ${fmtNum(cy - r)} c ${fmtNum(cx + r * 0.55)} ${fmtNum(cy - r)} ${fmtNum(cx + r)} ${fmtNum(cy - r * 0.55)} ${fmtNum(cx + r)} ${fmtNum(cy)} c f`;
    else if (style === 'cross') ops += `0 G ${fmtNum(Math.max(1, r / 4))} w ${fmtNum(cx - r)} ${fmtNum(cy - r)} m ${fmtNum(cx + r)} ${fmtNum(cy + r)} l ${fmtNum(cx - r)} ${fmtNum(cy + r)} m ${fmtNum(cx + r)} ${fmtNum(cy - r)} l S`;
    else if (style === 'square') ops += `0 g ${fmtNum(cx - r)} ${fmtNum(cy - r)} ${fmtNum(r * 2)} ${fmtNum(r * 2)} re f`;
    else ops += `0 G ${fmtNum(Math.max(1, r / 3))} w 1 J 1 j ${fmtNum(cx - r)} ${fmtNum(cy)} m ${fmtNum(cx - r * 0.3)} ${fmtNum(cy - r * 0.7)} l ${fmtNum(cx + r)} ${fmtNum(cy + r * 0.8)} l S`;
  }
  return doc.register(flateStream(bytesOf(ops), { Type: Name.get('XObject'), Subtype: Name.get('Form'), BBox: [0, 0, w, h] }));
}

function buttonAppearance(doc: PdfDocument, rect: Rect, caption: string, mk: Dict): Ref {
  const w = rect[2] - rect[0], h = rect[3] - rect[1];
  const font = fieldFont(doc, 'Helv');
  const size = Math.min(12, h * 0.6);
  const bg = doc.getArray(mk, 'BG');
  const ops = `${bg && bg.length === 3 ? bg.map((x) => fmtNum(doc.resolve<number>(x))).join(' ') + ' rg' : '0.85 g'} 0 0 ${fmtNum(w)} ${fmtNum(h)} re f 0.4 G 1 w 0.5 0.5 ${fmtNum(w - 1)} ${fmtNum(h - 1)} re S BT 0 g /Helv ${fmtNum(size)} Tf ${fmtNum((w - textWidth(caption, 'Helvetica', size)) / 2)} ${fmtNum((h - size * 0.7) / 2)} Td ${lit(winAnsiBytes(caption))} Tj ET`;
  return doc.register(flateStream(bytesOf(ops), { Type: Name.get('XObject'), Subtype: Name.get('Form'), BBox: [0, 0, w, h], Resources: new Dict({ Font: new Dict({ Helv: font.ref }) }) }));
}

export function deleteField(doc: PdfDocument, f: FieldInfo): void {
  const af = doc.getDict(doc.catalog, 'AcroForm');
  for (const w of f.widgets) { const p = doc.pages[w.page]; if (p) removeAnnotation(doc, p, w.ref); }
  if (af) { af.set('Fields', (doc.getArray(af, 'Fields') || []).filter((r) => !(r instanceof Ref && r.num === f.ref.num))); touchAcroForm(doc); }
  const parent = f.dict.get('Parent');
  if (parent instanceof Ref) { const pd = doc.resolve<Dict>(parent); pd.set('Kids', (doc.getArray(pd, 'Kids') || []).filter((r) => !(r instanceof Ref && r.num === f.ref.num))); doc.touch(parent); }
  doc.remove(f.ref);
}

export function setFieldProps(doc: PdfDocument, f: FieldInfo, props: { name?: string; required?: boolean; readOnly?: boolean; tooltip?: string; maxLen?: number; multiline?: boolean; options?: string[]; fontSize?: number; defaultValue?: string }): void {
  if (props.name !== undefined) f.dict.set('T', PdfString.fromText(props.name));
  let flags = f.flags;
  const bit = (b: number, on: boolean | undefined) => { if (on === undefined) return; flags = on ? flags | b : flags & ~b; };
  bit(2, props.required); bit(1, props.readOnly); bit(1 << 12, props.multiline);
  f.dict.set('Ff', flags);
  if (props.tooltip !== undefined) { if (props.tooltip) f.dict.set('TU', PdfString.fromText(props.tooltip)); else f.dict.delete('TU'); }
  if (props.maxLen !== undefined) { if (props.maxLen > 0) f.dict.set('MaxLen', props.maxLen); else f.dict.delete('MaxLen'); }
  if (props.options) f.dict.set('Opt', props.options.map((o) => PdfString.fromText(o)));
  if (props.fontSize !== undefined) { const da = parseDA(f.defaultAppearance); f.dict.set('DA', PdfString.fromText(`/${da.font} ${fmtNum(props.fontSize)} Tf ${da.color}`)); f.defaultAppearance = `/${da.font} ${props.fontSize} Tf ${da.color}`; }
  if (props.defaultValue !== undefined) f.dict.set('DV', PdfString.fromText(props.defaultValue));
  doc.update(f.ref, f.dict);
  f.flags = flags;
  if (f.type === 'text' || f.type === 'combo' || f.type === 'list') for (const w of f.widgets) regenerateAppearance(doc, f, w);
}

export function setCalculationOrder(doc: PdfDocument, names: string[]): void {
  const af = ensureAcroForm(doc);
  const fields = readFields(doc);
  af.set('CO', names.map((n) => fields.find((f) => f.name === n)?.ref).filter((r): r is Ref => !!r));
  touchAcroForm(doc);
}

/** Reorders a page's annotations so the Tab key visits widgets in the given field order (row order by default). */
export function setTabOrder(doc: PdfDocument, p: PageInfo, mode: 'rows' | 'columns' | 'structure' | string[]): void {
  if (typeof mode === 'string') { p.dict.set('Tabs', Name.get(mode === 'rows' ? 'R' : mode === 'columns' ? 'C' : 'S')); if (p.ref) doc.touch(p.ref); return; }
  const fields = readFields(doc);
  const annots = (doc.getArray(p.dict, 'Annots') || []).slice();
  const order = new Map<number, number>();
  mode.forEach((name, i) => { const f = fields.find((x) => x.name === name); if (f) for (const w of f.widgets) order.set(w.ref.num, i); });
  annots.sort((a, b) => (a instanceof Ref ? order.get(a.num) ?? 1e9 : 1e9) - (b instanceof Ref ? order.get(b.num) ?? 1e9 : 1e9));
  p.dict.set('Annots', annots);
  p.dict.delete('Tabs');
  if (p.ref) doc.touch(p.ref);
}

export function flattenForm(doc: PdfDocument): number {
  let n = 0;
  for (const p of doc.pages) n += flattenAnnotations(doc, p, (a) => a.subtype === 'Widget');
  const af = doc.getDict(doc.catalog, 'AcroForm');
  if (af) { doc.catalog.delete('AcroForm'); doc.update(doc.catalogRef, doc.catalog); }
  return n;
}

// ------------------------------------------------------------------------------------------
// Data exchange

export function formData(doc: PdfDocument): Record<string, string | string[] | boolean> {
  const out: Record<string, string | string[] | boolean> = {};
  for (const f of readFields(doc)) if (f.type !== 'button' && f.type !== 'signature') out[f.name] = f.value;
  return out;
}

export function applyFormData(doc: PdfDocument, data: Record<string, unknown>): number {
  let n = 0;
  const fields = readFields(doc);
  for (const [k, v] of Object.entries(data)) {
    const f = fields.find((x) => x.name === k || x.name.endsWith('.' + k));
    if (!f || f.readOnly) continue;
    try {
      if (f.type === 'checkbox') setFieldValue(doc, f, v === true || v === 'true' || v === 'Yes' || v === 'On' || v === 1 || v === '1' || (typeof v === 'string' && v !== '' && v !== 'Off' && v !== 'false'));
      else if (f.type === 'radio') setFieldValue(doc, f, typeof v === 'string' ? v : !!v);
      else setFieldValue(doc, f, Array.isArray(v) ? v.map(String) : String(v ?? ''));
      n++;
    } catch { /* read-only */ }
  }
  return n;
}

const xmlEsc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function exportFormXfdf(doc: PdfDocument, fileName = ''): string {
  const fields = readFields(doc).filter((f) => f.type !== 'button' && f.type !== 'signature');
  const items = fields.map((f) => {
    const vals = f.type === 'checkbox' || f.type === 'radio' ? [f.value ? (f.widgets.find((w) => (f.type === 'radio' ? doc.getName(w.dict, 'AS') !== 'Off' : true))?.onState || 'Yes') : 'Off'] : Array.isArray(f.value) ? f.value : [String(f.value)];
    return `<field name="${xmlEsc(f.name)}">${vals.map((v) => `<value>${xmlEsc(v)}</value>`).join('')}</field>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">${fileName ? `<f href="${xmlEsc(fileName)}"/>` : ''}<fields>${items.join('')}</fields></xfdf>`;
}

export function importFormXfdf(doc: PdfDocument, xml: string): number {
  const dom = new DOMParser().parseFromString(xml, 'application/xml');
  const data: Record<string, unknown> = {};
  const walk = (el: Element, prefix: string) => {
    for (const c of [...el.children]) {
      if (c.localName === 'field') { const name = (prefix ? prefix + '.' : '') + (c.getAttribute('name') || ''); const vals = [...c.children].filter((x) => x.localName === 'value').map((x) => x.textContent || ''); if (vals.length) data[name] = vals.length > 1 ? vals : vals[0]; walk(c, name); }
      else walk(c, prefix);
    }
  };
  const fields = dom.getElementsByTagNameNS('*', 'fields')[0];
  if (fields) walk(fields, '');
  return applyFormData(doc, data);
}

/** FDF (the older binary-ish form data format): a minimal writer and reader. */
export function exportFormFdf(doc: PdfDocument, fileName = ''): Uint8Array {
  const fields = readFields(doc).filter((f) => f.type !== 'button' && f.type !== 'signature');
  const fdf = PdfDocument.create();
  const items = fields.map((f) => {
    const d = new Dict({ T: PdfString.fromText(f.name) });
    if (f.type === 'checkbox' || f.type === 'radio') d.set('V', Name.get(f.value ? f.widgets[0]?.onState || 'Yes' : 'Off'));
    else d.set('V', Array.isArray(f.value) ? f.value.map((v) => PdfString.fromText(v)) : PdfString.fromText(String(f.value)));
    return d;
  });
  const fdfDict = new Dict({ Fields: items });
  if (fileName) fdfDict.set('F', PdfString.fromText(fileName));
  fdf.catalog.set('FDF', fdfDict);
  fdf.catalog.delete('Pages');
  fdf.update(fdf.catalogRef, fdf.catalog);
  const out = fdf.save({ incremental: false, keepUnused: true });
  return bytesOf(latin1(out).replace('%PDF-1.7', '%FDF-1.2'));
}

export function importFormFdf(doc: PdfDocument, bytes: Uint8Array): number {
  const text = latin1(bytes).replace('%FDF-', '%PDF-');
  const fdf = PdfDocument.load(bytesOf(text));
  const root = fdf.catalog;
  const fd = fdf.getDict(root, 'FDF');
  const data: Record<string, unknown> = {};
  const walk = (list: PdfObj[], prefix: string) => {
    for (const it of list) {
      const d = fdf.resolve<Dict | null>(it);
      if (!(d instanceof Dict)) continue;
      const name = (prefix ? prefix + '.' : '') + fdf.getText(d, 'T');
      const v = fdf.get(d, 'V');
      if (v instanceof PdfString) data[name] = v.toText(); else if (v instanceof Name) data[name] = v.name; else if (Array.isArray(v)) data[name] = v.map((x) => { const r = fdf.resolve(x); return r instanceof PdfString ? r.toText() : ''; });
      const kids = fdf.getArray(d, 'Kids'); if (kids) walk(kids, name);
    }
  };
  if (fd) walk(fdf.getArray(fd, 'Fields') || [], '');
  return applyFormData(doc, data);
}

export function formDataCsv(doc: PdfDocument): string {
  const d = formData(doc);
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return Object.keys(d).map(q).join(',') + '\n' + Object.values(d).map((v) => q(Array.isArray(v) ? v.join('; ') : String(v))).join(',') + '\n';
}

/** Finds likely form fields on a page from its drawn rectangles and underscore runs (for "Detect Form Fields"). */
export function detectFieldsFromText(runs: { text: string; box: Rect }[], rects: Rect[]): NewField[] {
  const out: NewField[] = [];
  let n = 0;
  for (const r of runs) {
    const m = /^(.*?[:\s])?(_{3,})\s*$/.exec(r.text);
    if (m) {
      const frac = m[2].length / Math.max(1, r.text.length);
      const w = r.box[2] - r.box[0];
      out.push({ name: (m[1] || `Field ${++n}`).replace(/[:\s_]+$/, '').trim() || `Field ${++n}`, type: 'text', page: -1, rect: [r.box[2] - w * frac, r.box[1] - 2, r.box[2], r.box[3] + 2] });
    }
    if (/\[\s*\]|☐|\(\s*\)/.test(r.text)) out.push({ name: r.text.replace(/\[\s*\]|☐|\(\s*\)/g, '').trim() || `Check ${++n}`, type: 'checkbox', page: -1, rect: [r.box[0], r.box[1], r.box[0] + (r.box[3] - r.box[1]), r.box[3]] });
  }
  for (const r of rects) { const w = r[2] - r[0], h = r[3] - r[1]; if (w > 30 && h > 8 && h < 40) out.push({ name: `Field ${++n}`, type: 'text', page: -1, rect: r }); else if (Math.abs(w - h) < 3 && w >= 6 && w <= 20) out.push({ name: `Check ${++n}`, type: 'checkbox', page: -1, rect: r }); }
  return out;
}

export { readFields };
export type { FieldInfo };
export const strOf = (o: PdfObj): string => (o instanceof PdfString ? o.toText() : o instanceof Name ? o.name : '');
export const isStream = (o: unknown): o is PdfStream => o instanceof PdfStream;
