/**
 * The primitives the standard security handler needs (ISO 32000-1 §7.6, 32000-2 §7.6.4): MD5, SHA-256/384/512,
 * RC4 and AES-128/256 (CBC). Written from the published algorithms so the engine stays synchronous
 * and works the same in the browser, in Electron and in Node tests.
 */

// ------------------------------------------------------------------------------------------
// MD5 (RFC 1321)

const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const MD5_K = new Uint32Array(64);
for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;

export function md5(data: Uint8Array): Uint8Array {
  const len = data.length;
  const padded = new Uint8Array(((len + 8) >> 6) * 64 + 64);
  padded.set(data);
  padded[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bits >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bits / 4294967296), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + MD5_K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << MD5_S[i]) | (F >>> (32 - MD5_S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true); ov.setUint32(4, b0, true); ov.setUint32(8, c0, true); ov.setUint32(12, d0, true);
  return out;
}

// ------------------------------------------------------------------------------------------
// SHA-256

const K256 = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
const W256 = new Uint32Array(64);

export function sha256(data: Uint8Array): Uint8Array {
  const len = data.length;
  const padded = new Uint8Array(((len + 8) >> 6) * 64 + 64);
  padded.set(data);
  padded[len] = 0x80;
  const bits = len * 8, hi = Math.floor(bits / 4294967296), lo = bits >>> 0, e0 = padded.length;
  padded[e0 - 8] = hi >>> 24; padded[e0 - 7] = hi >>> 16; padded[e0 - 6] = hi >>> 8; padded[e0 - 5] = hi;
  padded[e0 - 4] = lo >>> 24; padded[e0 - 3] = lo >>> 16; padded[e0 - 2] = lo >>> 8; padded[e0 - 1] = lo;
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a, h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const W = W256;
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) { const p = off + i * 4; W[i] = (padded[p] << 24) | (padded[p + 1] << 16) | (padded[p + 2] << 8) | padded[p + 3]; }
    for (let i = 16; i < 64; i++) {
      const x = W[i - 15], y = W[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K256[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  const out = new Uint8Array(32);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((v, i) => { out[i * 4] = v >>> 24; out[i * 4 + 1] = v >>> 16; out[i * 4 + 2] = v >>> 8; out[i * 4 + 3] = v; });
  return out;
}

// ------------------------------------------------------------------------------------------
// SHA-384 / SHA-512 on pairs of 32-bit words (high, low)

const K512 = new Uint32Array([
  0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc, 0x3956c25b, 0xf348b538, 0x59f111f1, 0xb605d019, 0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118,
  0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe, 0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2, 0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1, 0x9bdc06a7, 0x25c71235, 0xc19bf174, 0xcf692694,
  0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65, 0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5,
  0x983e5152, 0xee66dfab, 0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4, 0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725, 0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70,
  0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed, 0x53380d13, 0x9d95b3df, 0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b,
  0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001, 0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30, 0xd192e819, 0xd6ef5218, 0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8,
  0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53, 0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8, 0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373, 0x682e6ff3, 0xd6b2b8a3,
  0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec, 0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b,
  0xca273ece, 0xea26619c, 0xd186b8c7, 0x21c0c207, 0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178, 0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6, 0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b,
  0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc, 0x431d67c4, 0x9c100d4c, 0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817,
]);
const W512 = new Int32Array(160);

function sha512Core(data: Uint8Array, init: number[], outBytes: number): Uint8Array {
  const len = data.length;
  const padded = new Uint8Array(((len + 16) >> 7) * 128 + 128);
  padded.set(data);
  padded[len] = 0x80;
  const bits = len * 8, hi = Math.floor(bits / 4294967296), lo = bits >>> 0, e0 = padded.length;
  padded[e0 - 8] = hi >>> 24; padded[e0 - 7] = hi >>> 16; padded[e0 - 6] = hi >>> 8; padded[e0 - 5] = hi;
  padded[e0 - 4] = lo >>> 24; padded[e0 - 3] = lo >>> 16; padded[e0 - 2] = lo >>> 8; padded[e0 - 1] = lo;
  const H = Int32Array.from(init);
  const W = W512;
  for (let off = 0; off < padded.length; off += 128) {
    for (let i = 0; i < 32; i++) { const p = off + i * 4; W[i] = (padded[p] << 24) | (padded[p + 1] << 16) | (padded[p + 2] << 8) | padded[p + 3]; }
    for (let i = 16; i < 80; i++) {
      // σ0(W[i-15]) = rotr1 ^ rotr8 ^ shr7 ; σ1(W[i-2]) = rotr19 ^ rotr61 ^ shr6
      const xh = W[(i - 15) * 2], xl = W[(i - 15) * 2 + 1];
      const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
      const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
      const yh = W[(i - 2) * 2], yl = W[(i - 2) * 2 + 1];
      const s1h = ((yh >>> 19) | (yl << 13)) ^ ((yl >>> 29) | (yh << 3)) ^ (yh >>> 6);
      const s1l = ((yl >>> 19) | (yh << 13)) ^ ((yh >>> 29) | (yl << 3)) ^ ((yl >>> 6) | (yh << 26));
      let l = (W[(i - 16) * 2 + 1] >>> 0) + (s0l >>> 0) + (W[(i - 7) * 2 + 1] >>> 0) + (s1l >>> 0);
      let h = W[(i - 16) * 2] + s0h + W[(i - 7) * 2] + s1h + Math.floor(l / 4294967296);
      W[i * 2] = h | 0; W[i * 2 + 1] = l | 0;
    }
    let ah = H[0], al = H[1], bh = H[2], bl = H[3], ch = H[4], cl = H[5], dh = H[6], dl = H[7];
    let eh = H[8], el = H[9], fh = H[10], fl = H[11], gh = H[12], gl = H[13], hh = H[14], hl = H[15];
    for (let i = 0; i < 80; i++) {
      // Σ1(e) = rotr14 ^ rotr18 ^ rotr41
      const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
      const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
      const chh = (eh & fh) ^ (~eh & gh), chl = (el & fl) ^ (~el & gl);
      let l = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + K512[i * 2 + 1] + (W[i * 2 + 1] >>> 0);
      const t1h = (hh + S1h + chh + K512[i * 2] + W[i * 2] + Math.floor(l / 4294967296)) | 0;
      const t1l = l | 0;
      // Σ0(a) = rotr28 ^ rotr34 ^ rotr39
      const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
      const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
      const mjh = (ah & bh) ^ (ah & ch) ^ (bh & ch), mjl = (al & bl) ^ (al & cl) ^ (bl & cl);
      l = (S0l >>> 0) + (mjl >>> 0);
      const t2h = (S0h + mjh + Math.floor(l / 4294967296)) | 0, t2l = l | 0;
      hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
      l = (dl >>> 0) + (t1l >>> 0);
      eh = (dh + t1h + Math.floor(l / 4294967296)) | 0; el = l | 0;
      dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
      l = (t1l >>> 0) + (t2l >>> 0);
      ah = (t1h + t2h + Math.floor(l / 4294967296)) | 0; al = l | 0;
    }
    const add = (k: number, xh: number, xl: number) => { const l = (H[k + 1] >>> 0) + (xl >>> 0); H[k] = (H[k] + xh + Math.floor(l / 4294967296)) | 0; H[k + 1] = l | 0; };
    add(0, ah, al); add(2, bh, bl); add(4, ch, cl); add(6, dh, dl); add(8, eh, el); add(10, fh, fl); add(12, gh, gl); add(14, hh, hl);
  }
  const out = new Uint8Array(outBytes);
  for (let i = 0; i < outBytes; i++) out[i] = (H[i >> 2] >>> (24 - (i & 3) * 8)) & 255;
  return out;
}

export const sha384 = (d: Uint8Array): Uint8Array => sha512Core(d, [0xcbbb9d5d, 0xc1059ed8, 0x629a292a, 0x367cd507, 0x9159015a, 0x3070dd17, 0x152fecd8, 0xf70e5939, 0x67332667, 0xffc00b31, 0x8eb44a87, 0x68581511, 0xdb0c2e0d, 0x64f98fa7, 0x47b5481d, 0xbefa4fa4], 48);
export const sha512 = (d: Uint8Array): Uint8Array => sha512Core(d, [0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1, 0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179], 64);

// ------------------------------------------------------------------------------------------
// RC4

export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  for (let i = 0, j = 0; i < 256; i++) { j = (j + S[i] + key[i % key.length]) & 255; const t = S[i]; S[i] = S[j]; S[j] = t; }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255; j = (j + S[i]) & 255;
    const t = S[i]; S[i] = S[j]; S[j] = t;
    out[k] = data[k] ^ S[(S[i] + S[j]) & 255];
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// AES (FIPS 197) with 32-bit lookup tables, CBC mode

const SBOX = new Uint8Array(256), INV_SBOX = new Uint8Array(256);
const TE0 = new Uint32Array(256), TE1 = new Uint32Array(256), TE2 = new Uint32Array(256), TE3 = new Uint32Array(256);
const TD0 = new Uint32Array(256), TD1 = new Uint32Array(256), TD2 = new Uint32Array(256), TD3 = new Uint32Array(256);
(() => {
  let p = 1, q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff; if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >>> 7)) ^ ((q << 2) | (q >>> 6)) ^ ((q << 3) | (q >>> 5)) ^ ((q << 4) | (q >>> 4));
    SBOX[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
  const xt = (x: number) => ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff;
  const ror8 = (v: number) => ((v >>> 8) | (v << 24)) >>> 0;
  for (let x = 0; x < 256; x++) {
    const s = SBOX[x], s2 = xt(s), s3 = s2 ^ s;
    const e = ((s2 << 24) | (s << 16) | (s << 8) | s3) >>> 0;
    TE0[x] = e; TE1[x] = ror8(e); TE2[x] = ror8(TE1[x]); TE3[x] = ror8(TE2[x]);
    const v = INV_SBOX[x], v2 = xt(v), v4 = xt(v2), v8 = xt(v4);
    const v9 = v8 ^ v, v11 = v8 ^ v2 ^ v, v13 = v8 ^ v4 ^ v, v14 = v8 ^ v4 ^ v2;
    const d = ((v14 << 24) | (v9 << 16) | (v13 << 8) | v11) >>> 0;
    TD0[x] = d; TD1[x] = ror8(d); TD2[x] = ror8(TD1[x]); TD3[x] = ror8(TD2[x]);
  }
})();

interface AesKey { enc: Uint32Array; dec: Uint32Array; rounds: number }
const keyCache = new Map<string, AesKey>();

function expandKey(key: Uint8Array): AesKey {
  const id = String.fromCharCode(...key);
  const hit = keyCache.get(id);
  if (hit) return hit;
  const nk = key.length >> 2, rounds = nk + 6, total = 4 * (rounds + 1);
  const w = new Uint32Array(total);
  for (let i = 0; i < nk; i++) w[i] = ((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0;
  let rcon = 1;
  for (let i = nk; i < total; i++) {
    let t = w[i - 1];
    if (i % nk === 0) {
      t = ((SBOX[(t >>> 16) & 255] << 24) | (SBOX[(t >>> 8) & 255] << 16) | (SBOX[t & 255] << 8) | SBOX[t >>> 24]) ^ (rcon << 24);
      rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x1b : 0)) & 0xff;
    } else if (nk > 6 && i % nk === 4) t = (SBOX[t >>> 24] << 24) | (SBOX[(t >>> 16) & 255] << 16) | (SBOX[(t >>> 8) & 255] << 8) | SBOX[t & 255];
    w[i] = (w[i - nk] ^ t) >>> 0;
  }
  // Decryption keys for the equivalent inverse cipher: reversed rounds, InvMixColumns on the inner ones.
  const dec = new Uint32Array(total);
  for (let r = 0; r <= rounds; r++) {
    for (let c = 0; c < 4; c++) {
      const v = w[(rounds - r) * 4 + c];
      dec[r * 4 + c] = r === 0 || r === rounds ? v : (TD0[SBOX[v >>> 24]] ^ TD1[SBOX[(v >>> 16) & 255]] ^ TD2[SBOX[(v >>> 8) & 255]] ^ TD3[SBOX[v & 255]]) >>> 0;
    }
  }
  const k = { enc: w, dec, rounds };
  if (keyCache.size > 64) keyCache.clear();
  keyCache.set(id, k);
  return k;
}

/** Encrypts one 16-byte block in place: in[o..o+16) → out[o..o+16). */
function encBlock(k: AesKey, src: Uint8Array, so: number, dst: Uint8Array, dof: number): void {
  const rk = k.enc;
  let s0 = ((src[so] << 24) | (src[so + 1] << 16) | (src[so + 2] << 8) | src[so + 3]) ^ rk[0];
  let s1 = ((src[so + 4] << 24) | (src[so + 5] << 16) | (src[so + 6] << 8) | src[so + 7]) ^ rk[1];
  let s2 = ((src[so + 8] << 24) | (src[so + 9] << 16) | (src[so + 10] << 8) | src[so + 11]) ^ rk[2];
  let s3 = ((src[so + 12] << 24) | (src[so + 13] << 16) | (src[so + 14] << 8) | src[so + 15]) ^ rk[3];
  let r = 4;
  for (let round = 1; round < k.rounds; round++, r += 4) {
    const t0 = TE0[s0 >>> 24] ^ TE1[(s1 >>> 16) & 255] ^ TE2[(s2 >>> 8) & 255] ^ TE3[s3 & 255] ^ rk[r];
    const t1 = TE0[s1 >>> 24] ^ TE1[(s2 >>> 16) & 255] ^ TE2[(s3 >>> 8) & 255] ^ TE3[s0 & 255] ^ rk[r + 1];
    const t2 = TE0[s2 >>> 24] ^ TE1[(s3 >>> 16) & 255] ^ TE2[(s0 >>> 8) & 255] ^ TE3[s1 & 255] ^ rk[r + 2];
    const t3 = TE0[s3 >>> 24] ^ TE1[(s0 >>> 16) & 255] ^ TE2[(s1 >>> 8) & 255] ^ TE3[s2 & 255] ^ rk[r + 3];
    s0 = t0; s1 = t1; s2 = t2; s3 = t3;
  }
  const o0 = ((SBOX[s0 >>> 24] << 24) | (SBOX[(s1 >>> 16) & 255] << 16) | (SBOX[(s2 >>> 8) & 255] << 8) | SBOX[s3 & 255]) ^ rk[r];
  const o1 = ((SBOX[s1 >>> 24] << 24) | (SBOX[(s2 >>> 16) & 255] << 16) | (SBOX[(s3 >>> 8) & 255] << 8) | SBOX[s0 & 255]) ^ rk[r + 1];
  const o2 = ((SBOX[s2 >>> 24] << 24) | (SBOX[(s3 >>> 16) & 255] << 16) | (SBOX[(s0 >>> 8) & 255] << 8) | SBOX[s1 & 255]) ^ rk[r + 2];
  const o3 = ((SBOX[s3 >>> 24] << 24) | (SBOX[(s0 >>> 16) & 255] << 16) | (SBOX[(s1 >>> 8) & 255] << 8) | SBOX[s2 & 255]) ^ rk[r + 3];
  put(dst, dof, o0); put(dst, dof + 4, o1); put(dst, dof + 8, o2); put(dst, dof + 12, o3);
}

function decBlock(k: AesKey, src: Uint8Array, so: number, dst: Uint8Array, dof: number): void {
  const rk = k.dec;
  let s0 = ((src[so] << 24) | (src[so + 1] << 16) | (src[so + 2] << 8) | src[so + 3]) ^ rk[0];
  let s1 = ((src[so + 4] << 24) | (src[so + 5] << 16) | (src[so + 6] << 8) | src[so + 7]) ^ rk[1];
  let s2 = ((src[so + 8] << 24) | (src[so + 9] << 16) | (src[so + 10] << 8) | src[so + 11]) ^ rk[2];
  let s3 = ((src[so + 12] << 24) | (src[so + 13] << 16) | (src[so + 14] << 8) | src[so + 15]) ^ rk[3];
  let r = 4;
  for (let round = 1; round < k.rounds; round++, r += 4) {
    const t0 = TD0[s0 >>> 24] ^ TD1[(s3 >>> 16) & 255] ^ TD2[(s2 >>> 8) & 255] ^ TD3[s1 & 255] ^ rk[r];
    const t1 = TD0[s1 >>> 24] ^ TD1[(s0 >>> 16) & 255] ^ TD2[(s3 >>> 8) & 255] ^ TD3[s2 & 255] ^ rk[r + 1];
    const t2 = TD0[s2 >>> 24] ^ TD1[(s1 >>> 16) & 255] ^ TD2[(s0 >>> 8) & 255] ^ TD3[s3 & 255] ^ rk[r + 2];
    const t3 = TD0[s3 >>> 24] ^ TD1[(s2 >>> 16) & 255] ^ TD2[(s1 >>> 8) & 255] ^ TD3[s0 & 255] ^ rk[r + 3];
    s0 = t0; s1 = t1; s2 = t2; s3 = t3;
  }
  const o0 = ((INV_SBOX[s0 >>> 24] << 24) | (INV_SBOX[(s3 >>> 16) & 255] << 16) | (INV_SBOX[(s2 >>> 8) & 255] << 8) | INV_SBOX[s1 & 255]) ^ rk[r];
  const o1 = ((INV_SBOX[s1 >>> 24] << 24) | (INV_SBOX[(s0 >>> 16) & 255] << 16) | (INV_SBOX[(s3 >>> 8) & 255] << 8) | INV_SBOX[s2 & 255]) ^ rk[r + 1];
  const o2 = ((INV_SBOX[s2 >>> 24] << 24) | (INV_SBOX[(s1 >>> 16) & 255] << 16) | (INV_SBOX[(s0 >>> 8) & 255] << 8) | INV_SBOX[s3 & 255]) ^ rk[r + 2];
  const o3 = ((INV_SBOX[s3 >>> 24] << 24) | (INV_SBOX[(s2 >>> 16) & 255] << 16) | (INV_SBOX[(s1 >>> 8) & 255] << 8) | INV_SBOX[s0 & 255]) ^ rk[r + 3];
  put(dst, dof, o0); put(dst, dof + 4, o1); put(dst, dof + 8, o2); put(dst, dof + 12, o3);
}

function put(b: Uint8Array, o: number, v: number): void { b[o] = v >>> 24; b[o + 1] = v >>> 16; b[o + 2] = v >>> 8; b[o + 3] = v; }

/** AES-CBC without padding (data length must be a multiple of 16). */
export function aesCbcEncryptNoPad(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const k = expandKey(key);
  const n = data.length - (data.length % 16);
  const out = new Uint8Array(n);
  const blk = new Uint8Array(16);
  for (let i = 0; i < 16; i++) blk[i] = iv[i] ?? 0;
  for (let o = 0; o < n; o += 16) {
    for (let i = 0; i < 16; i++) blk[i] ^= data[o + i];
    encBlock(k, blk, 0, out, o);
    for (let i = 0; i < 16; i++) blk[i] = out[o + i];
  }
  return out;
}

export function aesCbcDecryptNoPad(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const k = expandKey(key);
  const n = data.length - (data.length % 16);
  const out = new Uint8Array(n);
  for (let o = 0; o < n; o += 16) {
    decBlock(k, data, o, out, o);
    if (o === 0) for (let i = 0; i < 16; i++) out[i] ^= iv[i] ?? 0;
    else for (let i = 0; i < 16; i++) out[o + i] ^= data[o - 16 + i];
  }
  return out;
}

/** AES-CBC with a random IV prefix and PKCS#5 padding, as PDF strings and streams use (AESV2/AESV3). */
export function aesCbcEncrypt(key: Uint8Array, data: Uint8Array, iv = randomBytes(16)): Uint8Array {
  const pad = 16 - (data.length % 16);
  const padded = new Uint8Array(data.length + pad);
  padded.set(data);
  padded.fill(pad, data.length);
  const enc = aesCbcEncryptNoPad(key, iv, padded);
  const out = new Uint8Array(16 + enc.length);
  out.set(iv); out.set(enc, 16);
  return out;
}

export function aesCbcDecrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length < 16) return new Uint8Array(0);
  const iv = data.subarray(0, 16);
  const dec = aesCbcDecryptNoPad(key, iv, data.subarray(16));
  const pad = dec.length ? dec[dec.length - 1] : 0;
  if (pad >= 1 && pad <= 16 && pad <= dec.length) return dec.subarray(0, dec.length - pad);
  return dec;
}

/** AES-ECB of one block. */
export function aesEncryptBlock(key: Uint8Array, block: Uint8Array): Uint8Array { const out = new Uint8Array(16); encBlock(expandKey(key), block, 0, out, 0); return out; }

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  try { (globalThis.crypto as Crypto).getRandomValues(b); } catch { for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256); }
  return b;
}

export const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
