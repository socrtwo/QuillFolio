/**
 * Stream filters (ISO 32000-1 §7.4): FlateDecode (ImmortalInflate, so damaged data still yields what
 * it can), LZWDecode, ASCIIHexDecode, ASCII85Decode, RunLengthDecode, and the PNG/TIFF predictors.
 * Image filters (DCTDecode, JPXDecode, CCITTFaxDecode, JBIG2Decode) are left for the renderer: their
 * data passes through untouched and the stream is reported as an "image filter" stream.
 * Encoding: FlateDecode with a small DEFLATE compressor (LZ77 + fixed Huffman), synchronous.
 */
import { immortalInflate } from '../io/recover/inflate';
import { Dict, Name, PdfObj, PdfStream, isName } from './objects';

export const IMAGE_FILTERS = new Set(['DCTDecode', 'DCT', 'JPXDecode', 'CCITTFaxDecode', 'CCF', 'JBIG2Decode']);

export interface DecodeResult { data: Uint8Array; corrupt: boolean; imageFilter: string | null; params: Dict | null }

const ALIASES: Record<string, string> = { Fl: 'FlateDecode', LZW: 'LZWDecode', AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', RL: 'RunLengthDecode', DCT: 'DCTDecode', CCF: 'CCITTFaxDecode' };

/** The filter chain of a stream as [name, params][] (resolving refs through `resolve`). */
export function filterChain(dict: Dict, resolve: (o: PdfObj | undefined) => PdfObj): [string, Dict | null][] {
  const f = resolve(dict.get('Filter') ?? dict.get('F'));
  const p = resolve(dict.get('DecodeParms') ?? dict.get('DP'));
  const names: string[] = isName(f) ? [f.name] : Array.isArray(f) ? f.map((x) => resolve(x)).filter(isName).map((x) => (x as Name).name) : [];
  const params: (Dict | null)[] = Array.isArray(p) ? p.map((x) => { const r = resolve(x); return r instanceof Dict ? r : null; }) : [p instanceof Dict ? p : null];
  return names.map((n, i) => [ALIASES[n] || n, params[i] ?? null]);
}

/** Decodes a stream's raw bytes (already decrypted) through its filter chain. */
export function decodeStream(raw: Uint8Array, dict: Dict, resolve: (o: PdfObj | undefined) => PdfObj): DecodeResult {
  let data = raw;
  let corrupt = false;
  for (const [name, params] of filterChain(dict, resolve)) {
    if (IMAGE_FILTERS.has(name)) return { data, corrupt, imageFilter: name, params };
    switch (name) {
      case 'FlateDecode': { const r = inflateZlib(data); data = r.data; corrupt ||= r.corrupt; break; }
      case 'LZWDecode': data = lzwDecode(data, params ? numOf(resolve(params.get('EarlyChange')), 1) : 1); break;
      case 'ASCIIHexDecode': data = asciiHexDecode(data); break;
      case 'ASCII85Decode': data = ascii85Decode(data); break;
      case 'RunLengthDecode': data = runLengthDecode(data); break;
      case 'Crypt': break; // identity crypt filter
      default: return { data, corrupt, imageFilter: name, params }; // unknown filter: hand the bytes on
    }
    if (params && (name === 'FlateDecode' || name === 'LZWDecode')) data = applyPredictor(data, params, resolve);
  }
  return { data, corrupt, imageFilter: null, params: null };
}

const numOf = (o: PdfObj, d: number): number => (typeof o === 'number' ? o : d);

/** zlib-wrapped (or raw) DEFLATE data → bytes; never throws. */
export function inflateZlib(data: Uint8Array): { data: Uint8Array; corrupt: boolean } {
  if (!data.length) return { data, corrupt: false };
  let start = 0;
  // Skip leading whitespace some producers leave before the zlib header.
  while (start < data.length && (data[start] === 0x0a || data[start] === 0x0d || data[start] === 0x20 || data[start] === 0x09)) start++;
  const cmf = data[start], flg = data[start + 1];
  const zlib = (cmf & 0x0f) === 8 && ((cmf << 8) | flg) % 31 === 0;
  const body = data.subarray(zlib ? start + 2 : start);
  const r = immortalInflate(body, { resync: false });
  if (!zlib && r.isCorrupt && r.data.length === 0 && start + 1 < data.length) {
    // Maybe a damaged header: try from the next byte.
    const r2 = immortalInflate(data.subarray(start + 1), { resync: false });
    if (r2.data.length) return { data: r2.data, corrupt: true };
  }
  return { data: r.data, corrupt: r.isCorrupt };
}

export function applyPredictor(data: Uint8Array, params: Dict, resolve: (o: PdfObj | undefined) => PdfObj): Uint8Array {
  const pred = numOf(resolve(params.get('Predictor')), 1);
  if (pred <= 1) return data;
  const colors = numOf(resolve(params.get('Colors')), 1);
  const bpc = numOf(resolve(params.get('BitsPerComponent')), 8);
  const columns = numOf(resolve(params.get('Columns')), 1);
  const bpp = Math.ceil((colors * bpc) / 8);
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  if (pred === 2) {
    // TIFF predictor (8-bit only; others pass through)
    if (bpc !== 8) return data;
    const rows = Math.floor(data.length / rowLen);
    const out = data.slice(0, rows * rowLen);
    for (let r = 0; r < rows; r++) { const o = r * rowLen; for (let i = bpp; i < rowLen; i++) out[o + i] = (out[o + i] + out[o + i - bpp]) & 0xff; }
    return out;
  }
  // PNG predictors: each row starts with a filter type byte.
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  let prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const ft = data[r * (rowLen + 1)];
    const src = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
    const row = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0, x = src[i];
      let v: number;
      switch (ft) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: v = x;
      }
      row[i] = v & 0xff;
    }
    prev = row;
  }
  return out;
}

export function asciiHexDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let hi = -1;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === 0x3e) break;
    let v = -1;
    if (c >= 0x30 && c <= 0x39) v = c - 48; else if (c >= 0x41 && c <= 0x46) v = c - 55; else if (c >= 0x61 && c <= 0x66) v = c - 87; else continue;
    if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
  }
  if (hi >= 0) out.push(hi * 16);
  return Uint8Array.from(out);
}

export function ascii85Decode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let tuple: number[] = [];
  let i = 0;
  if (data[0] === 0x3c && data[1] === 0x7e) i = 2;
  for (; i < data.length; i++) {
    const c = data[i];
    if (c === 0x7e) break;
    if (c === 0x7a && !tuple.length) { out.push(0, 0, 0, 0); continue; }
    if (c < 0x21 || c > 0x75) continue;
    tuple.push(c - 33);
    if (tuple.length === 5) { let v = 0; for (const t of tuple) v = v * 85 + t; out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); tuple = []; }
  }
  if (tuple.length > 1) {
    const n = tuple.length;
    while (tuple.length < 5) tuple.push(84);
    let v = 0; for (const t of tuple) v = v * 85 + t;
    const b = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...b.slice(0, n - 1));
  }
  return Uint8Array.from(out);
}

export function runLengthDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const l = data[i++];
    if (l === 128) break;
    if (l < 128) { for (let k = 0; k <= l && i < data.length; k++) out.push(data[i++]); }
    else { const b = data[i++]; for (let k = 0; k < 257 - l; k++) out.push(b); }
  }
  return Uint8Array.from(out);
}

export function lzwDecode(data: Uint8Array, early = 1): Uint8Array {
  const out: number[] = [];
  let dict: number[][] = [];
  const reset = () => { dict = []; for (let i = 0; i < 256; i++) dict.push([i]); dict.push([], []); };
  reset();
  let codeLen = 9, prev: number[] | null = null, bitBuf = 0, bitCnt = 0, pos = 0;
  while (true) {
    while (bitCnt < codeLen && pos < data.length) { bitBuf = (bitBuf << 8) | data[pos++]; bitCnt += 8; }
    if (bitCnt < codeLen) break;
    const code = (bitBuf >>> (bitCnt - codeLen)) & ((1 << codeLen) - 1);
    bitCnt -= codeLen;
    if (code === 256) { reset(); codeLen = 9; prev = null; continue; }
    if (code === 257) break;
    let entry: number[];
    if (code < dict.length) { entry = dict[code]; if (prev) dict.push([...prev, entry[0]]); }
    else if (prev) { entry = [...prev, prev[0]]; dict.push(entry); }
    else break;
    out.push(...entry);
    prev = entry;
    if (dict.length + early - 1 >= (1 << codeLen) && codeLen < 12) codeLen++;
  }
  return Uint8Array.from(out);
}

// ------------------------------------------------------------------------------------------
// Encoding

/** Adler-32 of data. */
function adler32(data: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) { a = (a + data[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

/** zlib (RFC 1950) stream with DEFLATE data: LZ77 with hash chains + fixed Huffman codes. */
export function deflateZlib(data: Uint8Array): Uint8Array {
  const out = new BitWriter();
  out.byte(0x78); out.byte(0x9c);
  if (data.length === 0) {
    out.bits(1, 1); out.bits(1, 2); // final, fixed
    out.code(256); out.flush();
  } else {
    out.bits(1, 1); out.bits(1, 2);
    const HASH = 1 << 15;
    const head = new Int32Array(HASH).fill(-1);
    const prevIdx = new Int32Array(data.length);
    const hashAt = (i: number) => ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & (HASH - 1);
    let i = 0;
    const n = data.length;
    while (i < n) {
      let bestLen = 0, bestDist = 0;
      if (i + 2 < n) {
        const h = hashAt(i);
        let p = head[h];
        let chain = 0;
        while (p >= 0 && i - p <= 32768 && chain++ < 48) {
          if (data[p] === data[i] && data[p + 1] === data[i + 1] && data[p + 2] === data[i + 2]) {
            let l = 3;
            while (l < 258 && i + l < n && data[p + l] === data[i + l]) l++;
            if (l > bestLen) { bestLen = l; bestDist = i - p; if (l >= 258) break; }
          }
          p = prevIdx[p];
        }
        prevIdx[i] = head[h];
        head[h] = i;
      }
      if (bestLen >= 3) {
        out.lengthCode(bestLen); out.distCode(bestDist);
        for (let k = 1; k < bestLen; k++) { const j = i + k; if (j + 2 < n) { const h = hashAt(j); prevIdx[j] = head[h]; head[h] = j; } }
        i += bestLen;
      } else { out.code(data[i]); i++; }
    }
    out.code(256);
    out.flush();
  }
  const ad = adler32(data);
  out.byte((ad >>> 24) & 255); out.byte((ad >>> 16) & 255); out.byte((ad >>> 8) & 255); out.byte(ad & 255);
  return out.bytes();
}

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

class BitWriter {
  private buf: number[] = [];
  private cur = 0;
  private n = 0;
  byte(b: number): void { this.flush(); this.buf.push(b & 255); }
  bits(v: number, count: number): void {
    for (let i = 0; i < count; i++) { this.cur |= ((v >>> i) & 1) << this.n; this.n++; if (this.n === 8) { this.buf.push(this.cur); this.cur = 0; this.n = 0; } }
  }
  /** Huffman codes are written most significant bit first. */
  private huff(code: number, len: number): void { for (let i = len - 1; i >= 0; i--) this.bits((code >>> i) & 1, 1); }
  code(sym: number): void {
    if (sym <= 143) this.huff(0x30 + sym, 8);
    else if (sym <= 255) this.huff(0x190 + sym - 144, 9);
    else if (sym <= 279) this.huff(sym - 256, 7);
    else this.huff(0xc0 + sym - 280, 8);
  }
  lengthCode(len: number): void {
    let i = LEN_BASE.length - 1;
    while (LEN_BASE[i] > len) i--;
    this.code(257 + i);
    if (LEN_EXTRA[i]) this.bits(len - LEN_BASE[i], LEN_EXTRA[i]);
  }
  distCode(dist: number): void {
    let i = DIST_BASE.length - 1;
    while (DIST_BASE[i] > dist) i--;
    this.huff(i, 5);
    if (DIST_EXTRA[i]) this.bits(dist - DIST_BASE[i], DIST_EXTRA[i]);
  }
  flush(): void { if (this.n) { this.buf.push(this.cur); this.cur = 0; this.n = 0; } }
  bytes(): Uint8Array { this.flush(); return Uint8Array.from(this.buf); }
}

/** Makes a Flate-compressed stream object from bytes (and extra dictionary entries). */
export function flateStream(data: Uint8Array, entries: Record<string, PdfObj> = {}, compress = true): PdfStream {
  const dict = new Dict(entries);
  const raw = compress ? deflateZlib(data) : data;
  if (compress) dict.set('Filter', Name.get('FlateDecode'));
  dict.set('Length', raw.length);
  const s = new PdfStream(dict, raw);
  s.decoded = data;
  return s;
}
