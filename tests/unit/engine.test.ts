import { describe, it, expect } from 'vitest';
import { PdfDocument } from '../../src/pdf/document';
import { Dict, Name, PdfString, Ref, latin1, bytesOf } from '../../src/pdf/objects';
import { deflateZlib, inflateZlib, ascii85Decode, asciiHexDecode, lzwDecode, runLengthDecode } from '../../src/pdf/filters';
import { md5, sha256, rc4, aesCbcEncrypt, aesCbcDecrypt, hex, sha384, sha512 } from '../../src/pdf/hash';
import { parseContent, serializeContent, analyzeContent } from '../../src/pdf/content';
import { makeTextPdf, addTextPage } from '../../src/pdf/build';

const enc = new TextEncoder();

describe('filters and hashes', () => {
  it('deflate round trip', () => {
    const data = enc.encode('Hello hello hello hello world, this is a test of the deflate compressor. '.repeat(50));
    const z = deflateZlib(data);
    expect(z.length).toBeLessThan(data.length / 3);
    const back = inflateZlib(z);
    expect(back.corrupt).toBe(false);
    expect(latin1(back.data)).toBe(latin1(data));
    expect(inflateZlib(deflateZlib(new Uint8Array(0))).data.length).toBe(0);
    const bin = new Uint8Array(5000); for (let i = 0; i < bin.length; i++) bin[i] = (i * 7919) & 255;
    expect(Array.from(inflateZlib(deflateZlib(bin)).data)).toEqual(Array.from(bin));
  });
  it('recovers deflate data when the zlib header checksum is damaged', () => {
    const data = enc.encode('Recover this content even with a damaged zlib header.');
    const z = deflateZlib(data);
    z[1] ^= 0x01;
    expect(latin1(inflateZlib(z).data)).toBe(latin1(data));
  });
  it('ascii filters', () => {
    expect(latin1(asciiHexDecode(enc.encode('48656C6C6F>')))).toBe('Hello');
    expect(latin1(ascii85Decode(enc.encode('87cURD]i,"Ebo80~>')))).toBe('Hello World!');
    expect(Array.from(runLengthDecode(Uint8Array.from([2, 1, 2, 3, 254, 9, 128])))).toEqual([1, 2, 3, 9, 9, 9]);
    expect(latin1(lzwDecode(Uint8Array.from([0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01])))).toBe('-----A---B');
  });
  it('md5, sha-2, rc4, aes', () => {
    expect(hex(md5(enc.encode('')))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(hex(md5(enc.encode('The quick brown fox jumps over the lazy dog')))).toBe('9e107d9d372bb6826bd81d3542a419d6');
    expect(hex(sha256(enc.encode('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hex(sha384(enc.encode('abc')))).toBe('cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7');
    expect(hex(sha512(enc.encode('abc')))).toBe('ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f');
    expect(hex(rc4(enc.encode('Key'), enc.encode('Plaintext')))).toBe('bbf316e8d940af0ad3');
    const key = new Uint8Array(16).fill(7);
    const ct = aesCbcEncrypt(key, enc.encode('sixteen byte msg!'));
    expect(latin1(aesCbcDecrypt(key, ct))).toBe('sixteen byte msg!');
    const key32 = new Uint8Array(32).fill(3);
    expect(latin1(aesCbcDecrypt(key32, aesCbcEncrypt(key32, enc.encode('x'))))).toBe('x');
  });
});

describe('document round trips', () => {
  it('creates, saves and reloads a text PDF', () => {
    const bytes = makeTextPdf(['Hello QuillFolio', 'Second page']);
    expect(latin1(bytes, 0, 8)).toBe('%PDF-1.7');
    const doc = PdfDocument.load(bytes);
    expect(doc.pageCount).toBe(2);
    expect(doc.report.reconstructed).toBe(false);
    const pt = analyzeContent(doc, parseContent(doc.pageContent(doc.pages[0])), doc.pages[0].resources);
    expect(pt.runs.map((r) => r.text).join('')).toContain('Hello QuillFolio');
    // Incremental update: a third page.
    addTextPage(doc, 'Third');
    const inc = doc.save({ incremental: true });
    expect(inc.length).toBeGreaterThan(bytes.length);
    expect(latin1(inc, 0, bytes.length)).toBe(latin1(bytes));
    const doc2 = PdfDocument.load(inc);
    expect(doc2.pageCount).toBe(3);
    expect(doc2.report.reconstructed).toBe(false);
    // Full rewrite with object streams and recompression.
    const full = PdfDocument.load(inc).save({ incremental: false, objectStreams: true, recompress: true });
    const doc3 = PdfDocument.load(full);
    expect(doc3.pageCount).toBe(3);
    expect(doc3.report.reconstructed).toBe(false);
    const p3 = analyzeContent(doc3, parseContent(doc3.pageContent(doc3.pages[2])), doc3.pages[2].resources);
    expect(p3.runs.map((r) => r.text).join('')).toContain('Third');
    const inc2 = PdfDocument.load(full);
    addTextPage(inc2, 'Fourth');
    const doc4 = PdfDocument.load(inc2.save({ incremental: true }));
    expect(doc4.pageCount).toBe(4);
  });
  it('content stream parse/serialize keeps operators', () => {
    const ops = parseContent(bytesOf('BT /F1 12 Tf 72 700 Td (Hi (there)) Tj [(A) -200 (B)] TJ ET q 1 0 0 1 10 10 cm /Im1 Do Q BI /W 2 /H 2 /CS /G /BPC 8 ID \x00\xff\xff\x00 EI'));
    expect(ops.map((o) => o.op)).toEqual(['BT', 'Tf', 'Td', 'Tj', 'TJ', 'ET', 'q', 'cm', 'Do', 'Q', 'INLINE_IMAGE']);
    expect((ops[3].args[0] as PdfString).toText()).toBe('Hi (there)');
    const again = parseContent(serializeContent(ops));
    expect(again.map((o) => o.op)).toEqual(ops.map((o) => o.op));
    expect(again[10].inline!.data.length).toBe(4);
  });
  it('encrypts with AES-256 and opens with user and owner passwords', () => {
    const doc = PdfDocument.load(makeTextPdf(['Secret']));
    const out = doc.save({ incremental: false, encrypt: { userPassword: 'user', ownerPassword: 'owner', permissions: { print: true, copy: false } } });
    expect(() => PdfDocument.load(out)).toThrow(/encrypted/);
    const u = PdfDocument.load(out, { password: 'user' });
    expect(u.securityInfo?.method).toBe('aesv3');
    expect(u.securityInfo?.ownerAccess).toBe(false);
    expect(u.securityInfo?.permissions.copy).toBe(false);
    const pt = analyzeContent(u, parseContent(u.pageContent(u.pages[0])), u.pages[0].resources);
    expect(pt.runs.map((r) => r.text).join('')).toContain('Secret');
    const o = PdfDocument.load(out, { password: 'owner' });
    expect(o.securityInfo?.ownerAccess).toBe(true);
    // Incremental update on an encrypted file keeps it readable.
    addTextPage(u, 'More');
    const u2 = PdfDocument.load(u.save({ incremental: true }), { password: 'user' });
    expect(u2.pageCount).toBe(2);
    expect(analyzeContent(u2, parseContent(u2.pageContent(u2.pages[1])), u2.pages[1].resources).runs[0].text).toContain('More');
    // Remove security.
    const plain = PdfDocument.load(o.save({ incremental: false, removeSecurity: true }));
    expect(plain.securityInfo).toBeNull();
    expect(plain.pageCount).toBe(1);
  });
  it('round trips names, strings and nested objects', () => {
    const doc = PdfDocument.create();
    const d = new Dict({ 'A B': Name.get('x#y/z'), S: PdfString.fromText('paren (test) \\ back\nline'), U: PdfString.fromText('Ünïcödé ✓'), Arr: [1, -2.5, true, null, new Ref(1, 0)], Nested: new Dict({ K: 0.000001 }) });
    const r = doc.register(d);
    doc.catalog.set('QF', r); doc.update(doc.catalogRef, doc.catalog);
    const back = PdfDocument.load(doc.save({ incremental: false, keepUnused: true }));
    const bd = back.getDict(back.catalog, 'QF')!;
    expect(back.getName(bd, 'A B')).toBe('x#y/z');
    expect(back.getText(bd, 'S')).toBe('paren (test) \\ back\nline');
    expect(back.getText(bd, 'U')).toBe('Ünïcödé ✓');
    expect(back.getArray(bd, 'Arr')!.slice(0, 4)).toEqual([1, -2.5, true, null]);
  });
});

describe('objects', () => {
  it('parses dates', async () => {
    const { parsePdfDate } = await import('../../src/pdf/objects');
    expect(parsePdfDate("D:20240102030405+02'00'")!.toISOString()).toBe('2024-01-02T01:04:05.000Z');
    expect(parsePdfDate('D:2024')!.getFullYear()).toBe(2024);
    expect(parsePdfDate('garbage')).toBeNull();
  });
  it('lexer survives junk', () => {
    expect(bytesOf('ab').length).toBe(2);
  });
});
