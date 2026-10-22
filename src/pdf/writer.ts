/**
 * Serialization (ISO 32000-1 §7.3, §7.5): objects to bytes, full rewrites with renumbering (unused
 * objects dropped, streams optionally recompressed, optional encryption) and incremental updates
 * (the original bytes untouched, changed objects and a new cross-reference section appended).
 */
import { Dict, Name, PdfObj, PdfStream, PdfString, Ref, bytesOf, concat, isName, pdfDate, nameObj } from './objects';
import { deflateZlib } from './filters';
import { SecurityHandler, Permissions } from './crypt';
import type { PdfDocument } from './document';
import { md5, randomBytes } from './hash';

export interface SaveOptions {
  /** Append an update instead of rewriting (default: when possible). */
  incremental?: boolean;
  /** Full rewrite only: recompress non-image streams with Flate. */
  recompress?: boolean;
  /** Full rewrite only: keep objects that are not reachable from the trailer. */
  keepUnused?: boolean;
  /** Full rewrite only: pack dictionaries into object streams and write an xref stream. */
  objectStreams?: boolean;
  /** Encrypt with AES-256 (full rewrite). */
  encrypt?: { userPassword: string; ownerPassword: string; permissions: Partial<Permissions>; encryptMetadata?: boolean };
  /** Drop the existing encryption (full rewrite). */
  removeSecurity?: boolean;
  /** PDF version for the header (full rewrite). */
  version?: string;
}

const NAME_ESC = /[^\x21-\x7e]|[#()<>\[\]{}\/%]/g;

export function serializeName(n: string): string {
  // Names read from files hold one char per byte; names made in the app may hold any Unicode text,
  // which is written as UTF-8 (the convention ISO 32000-1 §7.3.5 recommends).
  const bytes = /[^\x00-\xff]/.test(n) ? String.fromCharCode(...new TextEncoder().encode(n)) : n;
  return '/' + bytes.replace(NAME_ESC, (c) => '#' + c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase());
}

/** Display text of a name: its bytes read as UTF-8 when they form valid UTF-8, else as Latin-1. */
export function nameText(n: string): string {
  if (!/[\x80-\xff]/.test(n)) return n;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(n, (c) => c.charCodeAt(0) & 255)); } catch { return n; }
}

export function serializeString(s: PdfString): string {
  const b = s.bytes;
  let binary = s.hex;
  if (!binary) { let bad = 0; for (let i = 0; i < b.length; i++) if (b[i] < 32 || b[i] > 126) bad++; binary = bad > b.length / 4 && b.length > 2; }
  if (binary) { let h = '<'; for (let i = 0; i < b.length; i++) h += b[i].toString(16).padStart(2, '0'); return h + '>'; }
  let out = '(';
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === 0x28 || c === 0x29 || c === 0x5c) out += '\\' + String.fromCharCode(c);
    else if (c === 10) out += '\\n'; else if (c === 13) out += '\\r'; else if (c === 9) out += '\\t'; else if (c === 8) out += '\\b'; else if (c === 12) out += '\\f';
    else if (c < 32 || c > 126) out += '\\' + c.toString(8).padStart(3, '0');
    else out += String.fromCharCode(c);
  }
  return out + ')';
}

export function fmtNum(n: number): string {
  if (!isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  // Enough digits that values read from a file survive a round trip (font matrices such as
  // 0.00048828125 and scale factors such as 1.33333337 change glyph metrics when rounded), without
  // the float noise of String(n) or exponent notation.
  let s = n.toFixed(Math.abs(n) >= 1 ? 6 : 10).replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s;
}

/** Serializes a direct object. Streams return their dictionary + data. */
export function serialize(o: PdfObj): Uint8Array {
  const parts: Uint8Array[] = [];
  const push = (s: string) => parts.push(bytesOf(s));
  const walk = (v: PdfObj): void => {
    if (v === null || v === undefined) push('null');
    else if (typeof v === 'boolean') push(v ? 'true' : 'false');
    else if (typeof v === 'number') push(fmtNum(v));
    else if (v instanceof PdfString) push(serializeString(v));
    else if (v instanceof Name) push(serializeName(v.name));
    else if (v instanceof Ref) push(`${v.num} ${v.gen} R`);
    else if (Array.isArray(v)) { push('['); v.forEach((x, i) => { if (i) push(' '); walk(x); }); push(']'); }
    else if (v instanceof Dict) {
      push('<<');
      for (const [k, x] of v.map) { push(serializeName(k)); if (!(x instanceof Dict) && !Array.isArray(x) && !(x instanceof PdfString) && !(x instanceof Name)) push(' '); walk(x); }
      push('>>');
    } else if (v instanceof PdfStream) {
      const d = v.dict.clone();
      d.set('Length', v.raw.length);
      walk(d);
      push('\nstream\n');
      parts.push(v.raw);
      push('\nendstream');
    }
  };
  walk(o);
  return concat(parts);
}

function reachable(doc: PdfDocument, roots: PdfObj[]): Set<number> {
  const seen = new Set<number>();
  const stack: PdfObj[] = [...roots];
  while (stack.length) {
    const v = stack.pop()!;
    if (v instanceof Ref) { if (seen.has(v.num)) continue; seen.add(v.num); stack.push(doc.fetch(v)); }
    else if (Array.isArray(v)) stack.push(...v);
    else if (v instanceof Dict) stack.push(...v.map.values());
    else if (v instanceof PdfStream) stack.push(...v.dict.map.values());
  }
  return seen;
}

/** Remaps references in an object graph (used by renumbering and by copying between documents). A map that returns null drops the reference (written as null). */
export function remapRefs(o: PdfObj, map: (r: Ref) => Ref | null): PdfObj {
  if (o instanceof Ref) return map(o);
  if (Array.isArray(o)) return o.map((x) => remapRefs(x, map));
  if (o instanceof Dict) { const d = new Dict(); for (const [k, v] of o.map) d.map.set(k, remapRefs(v, map)); return d; }
  if (o instanceof PdfStream) { const s = new PdfStream(remapRefs(o.dict, map) as Dict, o.raw); s.decoded = o.decoded; return s; }
  return o;
}

const IMAGE_OR_FONT = new Set(['DCTDecode', 'JPXDecode', 'CCITTFaxDecode', 'JBIG2Decode']);

function recompressed(doc: PdfDocument, s: PdfStream): PdfStream {
  const f = s.dict.get('Filter');
  const names = isName(f) ? [f.name] : Array.isArray(f) ? f.filter(nameObj).map((n) => (n as Name).name) : [];
  if (names.some((n) => IMAGE_OR_FONT.has(n)) || isName(s.dict.get('Type'), 'XRef')) return s;
  if (names.length === 1 && names[0] === 'FlateDecode' && !s.dict.has('DecodeParms')) return s; // already Flate without predictor
  let data: Uint8Array;
  try { const r = doc.decode(s); if (r.imageFilter || r.corrupt) return s; data = r.data; } catch { return s; }
  const d = s.dict.clone();
  d.delete('DecodeParms'); d.delete('DP'); d.delete('F');
  d.set('Filter', Name.get('FlateDecode'));
  const raw = deflateZlib(data);
  d.set('Length', raw.length);
  const out = new PdfStream(d, raw);
  out.decoded = data;
  return out;
}

export function writeFull(doc: PdfDocument, opts: SaveOptions = {}): Uint8Array {
  const trailer = doc.trailer;
  const roots: PdfObj[] = [trailer.get('Root') ?? null, trailer.get('Info') ?? null];
  let nums = opts.keepUnused ? doc.objectNumbers() : [...reachable(doc, roots)].sort((a, b) => a - b);
  const encRef = trailer.get('Encrypt');
  nums = nums.filter((n) => !(encRef instanceof Ref && encRef.num === n));
  // Renumber 1..n in order.
  const map = new Map<number, number>();
  nums.forEach((n, i) => map.set(n, i + 1));
  // A reference to an object that is not written (missing from the file, or the old /Encrypt dictionary)
  // becomes null: "0 0 R" would point at the free-list head.
  const mapRef = (r: Ref): Ref | null => (map.has(r.num) ? new Ref(map.get(r.num)!, 0) : null);
  // Encryption for the new file.
  const ids = doc.resolve(trailer.get('ID'));
  const keepSecurity = !!doc.security && !opts.encrypt && !opts.removeSecurity;
  // The R2–R4 file key depends on the first ID string, so a file kept encrypted keeps it (even an empty one).
  let id0 = Array.isArray(ids) && ids[0] instanceof PdfString ? ids[0].bytes : keepSecurity ? new Uint8Array(0) : md5(concat([randomBytes(16), bytesOf(String(Date.now()))]));
  const id1 = md5(concat([id0, randomBytes(16), bytesOf(String(Date.now()))]));
  let security: SecurityHandler | null = null;
  let encDict: Dict | null = null;
  if (opts.encrypt) {
    id0 = md5(concat([randomBytes(16), bytesOf(String(Date.now()))]));
    const e = SecurityHandler.createAes256(opts.encrypt.userPassword, opts.encrypt.ownerPassword, opts.encrypt.permissions, id0, opts.encrypt.encryptMetadata !== false);
    security = e.handler; encDict = e.dict;
  } else if (keepSecurity) {
    security = doc.security;
    // The dictionary is written as one direct object: its parts (often /CF) may be indirect objects
    // that are not reachable from the catalog and would otherwise be lost or keep stale numbers.
    encDict = inlineRefs(doc, security!.dict) as Dict;
  }
  const out: Uint8Array[] = [];
  let pos = 0;
  const push = (b: Uint8Array) => { out.push(b); pos += b.length; };
  push(bytesOf(`%PDF-${opts.version || versionOf(doc)}\n%\xe2\xe3\xcf\xd3\n`));
  const offsets = new Map<number, number>();
  const objStmCandidates: [number, Uint8Array][] = [];
  for (const n of nums) {
    const newNum = map.get(n)!;
    let obj = doc.fetch(new Ref(n, doc.genOf(n)));
    obj = remapRefs(obj, mapRef);
    if (obj instanceof PdfStream && opts.recompress) obj = recompressed(doc, obj);
    if (obj instanceof PdfStream && isName(obj.dict.get('Type'), 'XRef')) continue; // old xref streams are dropped
    if (obj instanceof PdfStream && isName(obj.dict.get('Type'), 'ObjStm')) continue; // their contents are written directly
    if (security) obj = security.encryptObject(obj, new Ref(newNum, 0));
    if (opts.objectStreams && !(obj instanceof PdfStream) && !security) { objStmCandidates.push([newNum, serialize(obj)]); continue; }
    offsets.set(newNum, pos);
    push(bytesOf(`${newNum} 0 obj\n`));
    push(serialize(obj));
    push(bytesOf('\nendobj\n'));
  }
  let size = nums.length + 1;
  const xrefStmEntries: [number, number, number, number][] = []; // num, type, f2, f3
  if (objStmCandidates.length) {
    // One object stream per 100 objects.
    for (let i = 0; i < objStmCandidates.length; i += 100) {
      const chunk = objStmCandidates.slice(i, i + 100);
      const stmNum = size++;
      let header = '';
      const bodies: Uint8Array[] = [];
      let off = 0;
      chunk.forEach(([num, data]) => { header += `${num} ${off} `; bodies.push(data, bytesOf('\n')); off += data.length + 1; });
      const hb = bytesOf(header + '\n');
      const data = concat([hb, ...bodies]);
      const raw = deflateZlib(data);
      const s = new PdfStream(new Dict({ Type: Name.get('ObjStm'), N: chunk.length, First: hb.length, Filter: Name.get('FlateDecode'), Length: raw.length }), raw);
      offsets.set(stmNum, pos);
      push(bytesOf(`${stmNum} 0 obj\n`)); push(serialize(s)); push(bytesOf('\nendobj\n'));
      chunk.forEach(([num], idx) => xrefStmEntries.push([num, 2, stmNum, idx]));
    }
  }
  let encNum = 0;
  if (encDict) {
    encNum = size++;
    offsets.set(encNum, pos);
    push(bytesOf(`${encNum} 0 obj\n`)); push(serialize(encDict)); push(bytesOf('\nendobj\n'));
  }
  const newTrailer = new Dict();
  const root = trailer.get('Root');
  newTrailer.set('Root', root instanceof Ref ? mapRef(root) : (root ?? null) as PdfObj);
  const info = trailer.get('Info');
  if (info instanceof Ref && map.has(info.num)) newTrailer.set('Info', mapRef(info)!);
  newTrailer.set('ID', [new PdfString(id0, true), new PdfString(id1, true)]);
  if (encNum) newTrailer.set('Encrypt', new Ref(encNum, 0));
  const xrefPos = pos;
  if (opts.objectStreams || xrefStmEntries.length) {
    const xnum = size++;
    newTrailer.set('Size', size);
    const rows: Uint8Array[] = [];
    const W = [1, 4, 2];
    const entryFor = new Map<number, [number, number, number]>();
    for (const [n, o] of offsets) entryFor.set(n, [1, o, 0]);
    for (const [n, t, f2, f3] of xrefStmEntries) entryFor.set(n, [t, f2, f3]);
    entryFor.set(xnum, [1, xrefPos, 0]);
    for (let n = 0; n < size; n++) {
      const e = entryFor.get(n) || [0, 0, 0];
      rows.push(Uint8Array.from([e[0], (e[1] >>> 24) & 255, (e[1] >>> 16) & 255, (e[1] >>> 8) & 255, e[1] & 255, (e[2] >> 8) & 255, e[2] & 255]));
    }
    const data = concat(rows);
    const raw = deflateZlib(data);
    const xd = new Dict({ Type: Name.get('XRef'), Size: size, W, Filter: Name.get('FlateDecode'), Length: raw.length });
    for (const [k, v] of newTrailer.map) xd.set(k, v);
    push(bytesOf(`${xnum} 0 obj\n`)); push(serialize(new PdfStream(xd, raw))); push(bytesOf('\nendobj\n'));
  } else {
    newTrailer.set('Size', size);
    let x = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let n = 1; n < size; n++) { const o = offsets.get(n); x += o != null ? `${String(o).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n'; }
    push(bytesOf(x));
    push(bytesOf('trailer\n')); push(serialize(newTrailer)); push(bytesOf('\n'));
  }
  push(bytesOf(`startxref\n${xrefPos}\n%%EOF\n`));
  return concat(out);
}

export function writeIncremental(doc: PdfDocument, opts: SaveOptions = {}): Uint8Array {
  void opts;
  const base = doc.buf;
  const out: Uint8Array[] = [base];
  let pos = base.length;
  const push = (b: Uint8Array) => { out.push(b); pos += b.length; };
  if (base.length && base[base.length - 1] !== 10 && base[base.length - 1] !== 13) push(bytesOf('\n'));
  const changed = [...doc.changed.entries()].sort((a, b) => a[0] - b[0]);
  const offsets = new Map<number, number>();
  const deleted: number[] = [];
  for (const [n, obj] of changed) {
    if (obj === null) { deleted.push(n); continue; }
    const gen = doc.genOf(n);
    let o: PdfObj = obj;
    if (doc.security) o = doc.security.encryptObject(o, new Ref(n, gen));
    offsets.set(n, pos);
    push(bytesOf(`${n} ${gen} obj\n`)); push(serialize(o)); push(bytesOf('\nendobj\n'));
  }
  const size = Math.max(doc.size, ...changed.map(([n]) => n + 1));
  const ids = doc.resolve(doc.trailer.get('ID'));
  const id0 = Array.isArray(ids) && ids[0] instanceof PdfString ? ids[0] : new PdfString(md5(bytesOf(String(Date.now()))), true);
  const id1 = new PdfString(md5(concat([id0.bytes, bytesOf(String(Date.now()) + pos)])), true);
  const t = new Dict();
  for (const k of ['Root', 'Info', 'Encrypt']) if (doc.trailer.has(k)) t.set(k, doc.trailer.get(k)!);
  t.set('ID', [id0, id1]);
  t.set('Size', size);
  if (doc.startxref >= 0) t.set('Prev', doc.startxref);
  const xrefPos = pos;
  if (doc.usesXrefStream) {
    const xnum = size;
    const nums = [...offsets.keys(), ...deleted, xnum].sort((a, b) => a - b);
    const rows: Uint8Array[] = [];
    const index: number[] = [];
    // Index: runs of consecutive numbers.
    let runStart = -1, runLen = 0, prev = -2;
    const flush = () => { if (runStart >= 0) index.push(runStart, runLen); };
    for (const n of nums) {
      if (n !== prev + 1) { flush(); runStart = n; runLen = 0; }
      runLen++; prev = n;
      const o = n === xnum ? xrefPos : offsets.get(n);
      const e: [number, number, number] = o != null ? [1, o, n === xnum ? 0 : doc.genOf(n)] : [0, 0, 0];
      rows.push(Uint8Array.from([e[0], (e[1] >>> 24) & 255, (e[1] >>> 16) & 255, (e[1] >>> 8) & 255, e[1] & 255, (e[2] >> 8) & 255, e[2] & 255]));
    }
    flush();
    const data = concat(rows);
    const raw = deflateZlib(data);
    const xd = new Dict({ Type: Name.get('XRef'), Size: size + 1, W: [1, 4, 2], Index: index, Filter: Name.get('FlateDecode'), Length: raw.length });
    for (const [k, v] of t.map) if (k !== 'Size') xd.set(k, v);
    push(bytesOf(`${xnum} 0 obj\n`)); push(serialize(new PdfStream(xd, raw))); push(bytesOf('\nendobj\n'));
  } else {
    const nums = [...offsets.keys(), ...deleted].sort((a, b) => a - b);
    let x = 'xref\n';
    let i = 0;
    while (i < nums.length) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      x += `${nums[i]} ${j - i + 1}\n`;
      for (let k = i; k <= j; k++) { const n = nums[k]; const o = offsets.get(n); x += o != null ? `${String(o).padStart(10, '0')} ${String(doc.genOf(n)).padStart(5, '0')} n \n` : `0000000000 ${String(Math.min(65535, doc.genOf(n) + 1)).padStart(5, '0')} f \n`; }
      i = j + 1;
    }
    push(bytesOf(x));
    push(bytesOf('trailer\n')); push(serialize(t)); push(bytesOf('\n'));
  }
  push(bytesOf(`startxref\n${xrefPos}\n%%EOF\n`));
  return concat(out);
}

/** A copy of an object with every indirect reference replaced by the object it points at (cycles become null). */
function inlineRefs(doc: PdfDocument, o: PdfObj, seen = new Set<number>()): PdfObj {
  if (o instanceof Ref) {
    if (seen.has(o.num)) return null;
    const next = new Set(seen); next.add(o.num);
    return inlineRefs(doc, doc.fetch(o), next);
  }
  if (Array.isArray(o)) return o.map((x) => inlineRefs(doc, x, seen));
  if (o instanceof Dict) { const d = new Dict(); for (const [k, v] of o.map) d.map.set(k, inlineRefs(doc, v, seen)); return d; }
  return o;
}

function versionOf(doc: PdfDocument): string {
  const m = /%PDF-(\d\.\d)/.exec(doc.report.header);
  const v = doc.catalog.get('Version');
  const cv = isName(v) ? v.name : '';
  const best = [m?.[1] || '1.4', cv].filter(Boolean).sort().pop() || '1.4';
  return best < '1.4' ? '1.4' : best;
}

export const nowDate = pdfDate;
