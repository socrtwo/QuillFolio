/**
 * Cross-reference tables and streams (ISO 32000-1 §7.5.4–7.5.8) and their reconstruction from the
 * bytes of a damaged file.
 */
import { Dict, Name, PdfObj, PdfStream, Ref, isName, latin1 } from './objects';
import { Lexer, Parser } from './lexer';
import { decodeStream } from './filters';

export interface XrefEntry { offset: number; gen: number; /** 1 = in file, 2 = in an object stream (offset = stream object number, idx = index). */ type: 1 | 2; idx?: number }

export interface XrefResult {
  entries: Map<number, XrefEntry>;
  trailer: Dict;
  /** The file's newest section is an xref stream (updates should then use one too). */
  usesXrefStream: boolean;
  startxref: number;
  warnings: string[];
  /** Offsets of every xref section seen (newest first). */
  sections: number[];
}

const num = (o: PdfObj | undefined, d = 0): number => (typeof o === 'number' ? o : d);

/** Parses the xref chain starting at startxref. Throws when nothing usable is found. */
export function parseXref(buf: Uint8Array, resolveLength: (o: PdfObj) => PdfObj = (o) => o): XrefResult {
  const tail = Lexer.findLast(buf, 'startxref');
  if (tail < 0) throw new Error('No startxref');
  const lex = new Lexer(buf, tail + 9);
  const t = lex.next();
  if (t.t !== 'num') throw new Error('startxref has no offset');
  const result: XrefResult = { entries: new Map(), trailer: new Dict(), usesXrefStream: false, startxref: t.v, warnings: [], sections: [] };
  const seen = new Set<number>();
  const queue: number[] = [t.v];
  let first = true;
  while (queue.length) {
    const off = queue.shift()!;
    if (seen.has(off) || off < 0 || off >= buf.length) { if (!seen.has(off)) result.warnings.push(`xref offset ${off} is outside the file`); continue; }
    seen.add(off);
    result.sections.push(off);
    const section = parseSection(buf, off, resolveLength);
    if (!section) { result.warnings.push(`No xref section at ${off}`); if (first) throw new Error('startxref points at nothing'); continue; }
    if (first) {
      result.usesXrefStream = section.stream;
      // An update's /Prev must name where the table really is, or readers following it find nothing.
      // (The table itself is intact, so this is not counted as damage: updates stay valid with the corrected offset.)
      if (section.at !== undefined) result.startxref = section.at;
    }
    if (section.short) result.warnings.push(`The cross-reference table at ${off} lists fewer entries than it declares.`);
    first = false;
    for (const [n, e] of section.entries) if (!result.entries.has(n)) result.entries.set(n, e);
    for (const [k, v] of section.trailer.map) if (!result.trailer.has(k)) result.trailer.set(k, v);
    // Hybrid files: the xref stream named by XRefStm takes precedence over the table's Prev.
    const xs = section.trailer.get('XRefStm');
    if (typeof xs === 'number') queue.push(xs);
    const prev = section.trailer.get('Prev');
    if (typeof prev === 'number') queue.push(prev);
  }
  if (!result.trailer.has('Root')) throw new Error('The trailer has no /Root');
  return result;
}

type Section = { entries: Map<number, XrefEntry>; trailer: Dict; stream: boolean; /** A table subsection listed fewer entries than its header declared. */ short?: boolean; /** Where the section really starts, when the offset that led to it was a little off. */ at?: number };

function parseSection(buf: Uint8Array, off: number, resolveLength: (o: PdfObj) => PdfObj): Section | null {
  const lex = new Lexer(buf, off);
  lex.skipWs();
  if (Lexer.find(buf, 'xref', lex.pos, lex.pos + 4) === lex.pos) return parseTable(buf, lex.pos + 4);
  // An xref stream: "n g obj <<…>> stream"
  const p = new Parser(buf, lex.pos, resolveLength);
  const ind = p.parseIndirect();
  if (ind && ind.obj instanceof PdfStream && isName(ind.obj.dict.get('Type'), 'XRef')) return parseXrefStream(ind.obj, resolveLength);
  // Some writers point a few bytes before/after "xref".
  const near = Lexer.find(buf, 'xref', Math.max(0, off - 64), off + 128);
  if (near >= 0 && near !== off && !(near >= 5 && Lexer.find(buf, 'startxref', near - 5, near + 4) === near - 5)) return { ...parseTable(buf, near + 4), at: near };
  return null;
}

function parseTable(buf: Uint8Array, pos: number): Section {
  const entries = new Map<number, XrefEntry>();
  let short = false;
  const lex = new Lexer(buf, pos);
  for (;;) {
    lex.skipWs();
    if (Lexer.find(buf, 'trailer', lex.pos, lex.pos + 7) === lex.pos) {
      const p = new Parser(buf, lex.pos + 7);
      const t = p.parse();
      return { entries, trailer: t instanceof Dict ? t : new Dict(), stream: false, short };
    }
    const a = lex.next();
    const b = lex.next();
    if (a.t !== 'num' || b.t !== 'num') return { entries, trailer: new Dict(), stream: false, short: true };
    const start = a.v, count = b.v;
    lex.skipWs();
    // Entries are 20 bytes each in a valid file, but tolerate sloppy spacing by tokenizing.
    for (let i = 0; i < count; i++) {
      lex.skipWs();
      const save = lex.pos;
      if (Lexer.find(buf, 'trailer', lex.pos, lex.pos + 7) === lex.pos) { short = true; break; }
      const o = lex.next(), g = lex.next(), k = lex.next();
      if (o.t !== 'num' || g.t !== 'num' || k.t !== 'kw') { lex.pos = save; short = true; break; }
      const n = start + i;
      if (k.v === 'n' && !entries.has(n)) entries.set(n, { offset: o.v, gen: g.v, type: 1 });
      // Free entries ('f') are not recorded: a later section may define the object.
    }
  }
}

function parseXrefStream(s: PdfStream, resolveLength: (o: PdfObj) => PdfObj): Section {
  const d = s.dict;
  const data = decodeStream(s.raw, d, (o) => resolveLength(o ?? null)).data;
  const W = (d.get('W') as PdfObj[] | undefined)?.map((x) => num(x)) || [1, 1, 1];
  const size = num(d.get('Size'));
  const index = (d.get('Index') as PdfObj[] | undefined)?.map((x) => num(x)) || [0, size];
  const entries = new Map<number, XrefEntry>();
  const rowLen = W.reduce((a, b) => a + b, 0);
  let pos = 0;
  const read = (w: number): number => { let v = 0; for (let i = 0; i < w; i++) v = v * 256 + (data[pos++] ?? 0); return v; };
  for (let k = 0; k + 1 < index.length; k += 2) {
    const start = index[k], count = index[k + 1];
    for (let i = 0; i < count && pos + rowLen <= data.length; i++) {
      const type = W[0] === 0 ? 1 : read(W[0]);
      const f2 = read(W[1]);
      const f3 = read(W[2]);
      const n = start + i;
      if (entries.has(n)) continue;
      if (type === 1) entries.set(n, { offset: f2, gen: f3, type: 1 });
      else if (type === 2) entries.set(n, { offset: f2, gen: 0, type: 2, idx: f3 });
    }
  }
  const trailer = new Dict();
  for (const k of ['Root', 'Info', 'ID', 'Encrypt', 'Prev', 'Size', 'XRefStm']) if (d.has(k)) trailer.set(k, d.get(k)!);
  return { entries, trailer, stream: true };
}

export interface Reconstruction extends XrefResult { objectsFound: number; trailersFound: number; catalogSynthesized: boolean }

/**
 * Rebuilds the cross-reference table by scanning the file for "num gen obj", trailers and xref
 * streams. The last definition of an object wins (later updates come later in the file).
 */
export function reconstructXref(buf: Uint8Array, resolveLength: (o: PdfObj) => PdfObj = (o) => o): Reconstruction {
  const entries = new Map<number, XrefEntry>();
  const warnings: string[] = [];
  const text = latin1(buf);
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  let found = 0;
  const objStreams: number[] = [];
  const xrefStreamDicts: Dict[] = [];
  const catalogs: number[] = [];
  const pagesRoots: number[] = [];
  while ((m = re.exec(text))) {
    // The match must start at a token boundary (not inside a number like "123 0 obj" → "23 0 obj").
    if (m.index > 0 && /[0-9]/.test(text[m.index - 1])) { re.lastIndex = m.index + 1; continue; }
    const n = +m[1], g = +m[2];
    entries.set(n, { offset: m.index, gen: g, type: 1 });
    found++;
    // Peek at the object's dictionary type without a full parse (cheap scan of the next bytes).
    const head = text.slice(m.index, Math.min(text.length, m.index + 400));
    if (/\/Type\s*\/ObjStm\b/.test(head)) objStreams.push(n);
    if (/\/Type\s*\/XRef\b/.test(head)) { try { const p = new Parser(buf, m.index, resolveLength); const o = p.parseIndirect(); if (o?.obj instanceof PdfStream) xrefStreamDicts.push(o.obj.dict); } catch { /* */ } }
    if (/\/Type\s*\/Catalog\b/.test(head)) catalogs.push(n);
    if (/\/Type\s*\/Pages\b/.test(head) && !/\/Parent\b/.test(head)) pagesRoots.push(n);
    re.lastIndex = m.index + m[0].length;
  }
  // Objects inside object streams: list them so they resolve even when no xref stream survives.
  for (const sn of objStreams) {
    const e = entries.get(sn)!;
    try {
      const p = new Parser(buf, e.offset, resolveLength);
      const o = p.parseIndirect();
      if (!(o?.obj instanceof PdfStream)) continue;
      const data = decodeStream(o.obj.raw, o.obj.dict, (x) => resolveLength(x ?? null)).data;
      const count = num(o.obj.dict.get('N'));
      const lex = new Lexer(data, 0);
      for (let i = 0; i < count; i++) {
        const a = lex.next(), b = lex.next();
        if (a.t !== 'num' || b.t !== 'num') break;
        if (!entries.has(a.v) || entries.get(a.v)!.type === 2) entries.set(a.v, { offset: sn, gen: 0, type: 2, idx: i });
        // Objects in streams count as catalogs/pages roots too.
        const headText = latin1(data, b.v, Math.min(data.length, b.v + 300));
        if (/\/Type\s*\/Catalog\b/.test(headText)) catalogs.push(a.v);
        if (/\/Type\s*\/Pages\b/.test(headText) && !/\/Parent\b/.test(headText)) pagesRoots.push(a.v);
      }
    } catch { /* damaged object stream */ }
  }
  // Trailers: the last one with a usable Root wins; xref streams' dicts count too.
  const trailer = new Dict();
  let trailersFound = 0;
  const tre = /trailer/g;
  const trailerDicts: Dict[] = [];
  while ((m = tre.exec(text))) {
    try { const p = new Parser(buf, m.index + 7, resolveLength); const t = p.parse(); if (t instanceof Dict) { trailerDicts.push(t); trailersFound++; } } catch { /* */ }
  }
  for (const d of [...trailerDicts, ...xrefStreamDicts].reverse()) {
    for (const k of ['Root', 'Info', 'ID', 'Encrypt']) if (!trailer.has(k) && d.has(k)) trailer.set(k, d.get(k)!);
  }
  let catalogSynthesized = false;
  const rootOk = (() => { const r = trailer.get('Root'); return r instanceof Ref && entries.has(r.num); })();
  if (!rootOk) {
    trailer.delete('Root');
    if (catalogs.length) { trailer.set('Root', new Ref(catalogs[catalogs.length - 1], 0)); warnings.push('The trailer was missing or damaged; the document catalog was found by scanning.'); }
    else if (pagesRoots.length) { trailer.set('Root', new Ref(-1, 0)); (trailer as any).__pagesRoot = pagesRoots[pagesRoots.length - 1]; catalogSynthesized = true; warnings.push('No document catalog survived; one was rebuilt from the page tree.'); }
    else { warnings.push('No catalog and no page tree root found; pages will be collected by scanning.'); catalogSynthesized = true; }
  }
  if (!found) warnings.push('No objects found in the file.');
  const maxNum = Math.max(0, ...entries.keys());
  trailer.set('Size', maxNum + 1);
  return { entries, trailer, usesXrefStream: xrefStreamDicts.length > 0 && trailerDicts.length === 0, startxref: -1, warnings, sections: [], objectsFound: found, trailersFound, catalogSynthesized };
}

export const XREF_NAME = Name.get('XRef');
