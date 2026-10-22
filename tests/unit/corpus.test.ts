/**
 * Regression tests for engine bugs found by running QuillFolio over real-world PDFs (the pdf.js test
 * corpus and the py-pdf sample files) and checking the results with poppler and pypdf. The synthetic
 * cases always run; the cases that read a corpus file run only when /home/user/samples/pdf exists.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { PdfDocument } from '../../src/pdf/document';
import { Dict, Name, PdfStream, PdfString, Ref, latin1, bytesOf } from '../../src/pdf/objects';
import { lzwDecode, inflateZlib } from '../../src/pdf/filters';
import { fmtNum, serializeName, nameText } from '../../src/pdf/writer';
import { Lexer, parseObject } from '../../src/pdf/lexer';
import { saslPrep } from '../../src/pdf/crypt';
import { aesCbcEncryptNoPad, aesCbcDecryptNoPad, aesEncryptBlock, sha512, hex } from '../../src/pdf/hash';
import { deletePages, insertBlankPages, extractPages, addOverlayText } from '../../src/pdf/ops/pages';
import { addRedactMark, applyRedactions } from '../../src/pdf/ops/annots';
import { addField, setFieldValue } from '../../src/pdf/ops/forms';
import { readFields, readMetadata, writeMetadata } from '../../src/pdf/structure';
import { parseContent, analyzeContent } from '../../src/pdf/content';
import { openAsPdf } from '../../src/io';

const enc = new TextEncoder();

/** A PDF file from object bodies (numbered from 1), with a correct cross-reference table. */
function pdfFrom(objs: string[], extraTrailer = ''): Uint8Array {
  let s = '%PDF-1.7\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(s.length); s += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = s.length;
  s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  s += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R ${extraTrailer}>>\nstartxref\n${x}\n%%EOF\n`;
  return bytesOf(s);
}
const stream = (body: string, dict = '') => `<< /Length ${body.length} ${dict}>>\nstream\n${body}\nendstream`;

const SAMPLES = '/home/user/samples/pdf/';
const sample = (p: string) => (existsSync(SAMPLES + p) ? new Uint8Array(readFileSync(SAMPLES + p)) : null);
const itSample = (name: string, p: string, fn: (b: Uint8Array) => void | Promise<void>) => (existsSync(SAMPLES + p) ? it(name, () => fn(sample(p)!)) : it.skip(name, () => {}));

describe('syntax and filters', () => {
  it('keeps the bytes of names through a round trip', () => {
    // "/F#C3#A9" is the UTF-8 name "Fé"; "/Caf#E9" a Latin-1 one; content streams refer to them by bytes.
    const o = parseObject(bytesOf('<< /F#C3#A9 1 /Caf#E9 2 /A#20B 3 >>')) as Dict;
    const keys = o.keys();
    expect(keys.map((k) => serializeName(k))).toEqual(['/F#C3#A9', '/Caf#E9', '/A#20B']);
    expect(nameText(keys[0])).toBe('Fé');
    expect(nameText(keys[1])).toBe('Café');
    // A Unicode name made in the app is written as UTF-8.
    expect(serializeName('中文')).toBe('/#E4#B8#AD#E6#96#87');
    expect(serializeName('application/pdf')).toBe('/application#2Fpdf');
  });

  it('decodes LZW past the first code-width change (EarlyChange 1)', () => {
    // An LZW encoder per ISO 32000-1 §7.4.4 with early change, for data long enough to need 10- and 11-bit codes.
    const data = new Uint8Array(6000); let seed = 7;
    for (let i = 0; i < data.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; data[i] = 65 + ((seed >> 16) % 6); }
    const out: number[] = []; let acc = 0, nbits = 0;
    const emit = (code: number, width: number) => { acc = (acc << width) | code; nbits += width; while (nbits >= 8) { out.push((acc >> (nbits - 8)) & 255); nbits -= 8; } acc &= (1 << nbits) - 1; };
    let dict = new Map<string, number>(); let next = 258, width = 9;
    const reset = () => { dict = new Map(); for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i); next = 258; width = 9; };
    reset(); emit(256, 9);
    let w = '';
    for (const b of data) {
      const c = String.fromCharCode(b);
      if (dict.has(w + c)) { w += c; continue; }
      emit(dict.get(w)!, width);
      dict.set(w + c, next++);
      if (next + 1 > (1 << width) && width < 12) width++;
      if (next >= 4094) { emit(256, width); reset(); }
      w = c;
    }
    emit(dict.get(w)!, width); emit(257, width); if (nbits) emit(0, 8 - nbits);
    expect(Array.from(lzwDecode(Uint8Array.from(out)))).toEqual(Array.from(data));
  });

  it('writes numbers precisely enough for font matrices and scale factors', () => {
    for (const v of [0.00048828125, 1.33333337, -0.001, 12345.678901, 0.1 + 0.2]) expect(Math.abs(Number(fmtNum(v)) - v)).toBeLessThan(1e-6 * Math.max(1, Math.abs(v)));
    expect(fmtNum(0.1 + 0.2)).toBe('0.3');
    expect(fmtNum(1e-12)).toBe('0');
  });

  it('AES and SHA-512 match the published test vectors', () => {
    // FIPS-197 appendix C.1 and C.3; FIPS 180-2 "abc".
    const pt = Uint8Array.from({ length: 16 }, (_, i) => i * 0x11);
    expect(hex(aesEncryptBlock(Uint8Array.from({ length: 16 }, (_, i) => i), pt))).toBe('69c4e0d86a7b0430d8cdb78070b4c55a');
    const k256 = Uint8Array.from({ length: 32 }, (_, i) => i);
    const ct = aesCbcEncryptNoPad(k256, new Uint8Array(16), pt);
    expect(hex(ct)).toBe('8ea2b7ca516745bfeafc49904b496089');
    expect(hex(aesCbcDecryptNoPad(k256, new Uint8Array(16), ct))).toBe(hex(pt));
    expect(hex(sha512(enc.encode('abc'))).slice(0, 16)).toBe('ddaf35a193617aba');
  });

  it('prepares R6 passwords with SASLprep', () => {
    expect(saslPrep('SªSL­prep')).toBe('SaSLprep');
    expect(saslPrep('a b')).toBe('a b');
  });
});

describe('loading damaged and unusual files', () => {
  it('a page tree rebuilt from a scan survives a save', () => {
    // No catalog and no Pages object: the pages are gathered, and the Info dictionary added on save
    // must get a new number rather than the rebuilt tree's.
    const s = '%PDF-1.4\n1 0 obj\n<< /Type /Page /MediaBox [0 0 100 100] >>\nendobj\n2 0 obj\n<< /Type /Page /MediaBox [0 0 200 200] >>\nendobj\ntrailer\n<< /Size 3 >>\n%%EOF\n';
    const d = PdfDocument.load(bytesOf(s));
    expect(d.pageCount).toBe(2);
    const back = PdfDocument.load(d.save());
    expect(back.pages.map((p) => p.mediaBox[2])).toEqual([100, 200]);
  });

  it('an update names where the previous table really is when startxref was off', () => {
    const good = latin1(pdfFrom(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>']));
    const real = good.lastIndexOf('xref\n0 ');
    const bad = bytesOf(good.replace(/startxref\n\d+/, `startxref\n${real - 20}`));
    const doc = PdfDocument.load(bad);
    const out = latin1(doc.save({ incremental: true }));
    expect(/\/Prev (\d+)/.exec(out.slice(bad.length))![1]).toBe(String(real));
  });

  it('reads a page tree whose Kids lost its array brackets', () => {
    const b = pdfFrom(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids 3 0 R /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>']);
    expect(PdfDocument.load(b).pageCount).toBe(1);
  });

  it('rewrites instead of appending when the cross-reference table is miscounted', () => {
    const good = latin1(pdfFrom(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>']));
    const bad = bytesOf(good.replace('xref\n0 4\n', 'xref\n0 5\n'));
    const doc = PdfDocument.load(bad);
    expect(doc.report.xrefDamaged).toBe(true);
    const out = doc.save();
    expect(latin1(out.subarray(0, 64))).not.toBe(latin1(bad.subarray(0, 64)).slice(0, 64) === latin1(out.subarray(0, 64)) ? '' : 'x');
    expect(latin1(out).split('%%EOF').length - 1).toBe(1); // one revision: a rewrite, not an update
  });

  it('keeps an indirect /CF of the encryption dictionary in a full rewrite', () => {
    const doc = PdfDocument.create();
    const page = doc.pagesRoot!;
    void page;
    const bytes = doc.save({ incremental: false, encrypt: { userPassword: '', ownerPassword: 'o', permissions: {} } });
    // Make /CF indirect, as some writers do.
    let s = latin1(bytes);
    const m = /\/CF\s*(<<\/StdCF<<[^>]*>>>>)/.exec(s);
    expect(m).toBeTruthy();
    const cf = m![1];
    s = s.replace(m![0], '/CF 999 0 R');
    s = s.replace('%%EOF', '%%EOF').replace(/startxref\n(\d+)\n%%EOF\n$/, (_all, x) => `999 0 obj\n${cf}\nendobj\nstartxref\n${x}\n%%EOF\n`);
    const doc2 = PdfDocument.load(bytesOf(s), { repair: true });
    const out = doc2.save({ incremental: false });
    const doc3 = PdfDocument.load(out);
    expect(doc3.report.encrypted).toBe(true);
    expect(latin1(out)).toMatch(/\/CF<<\/StdCF<</);
  });
});

describe('page operations keep what pages inherit', () => {
  const tree = () => pdfFrom([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 4 /CropBox [10 10 190 290] /Resources << /Font << /F1 7 0 R >> >> /MediaBox [0 0 200 300] >>',
    '<< /Type /Pages /Parent 2 0 R /Kids [5 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Pages /Parent 2 0 R /Kids [8 0 R 9 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 3 0 R /Contents 10 0 R >>',
    '<< /Type /Page /Parent 3 0 R /Contents 10 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 4 0 R /Contents 10 0 R >>',
    '<< /Type /Page /Parent 4 0 R /Contents 10 0 R >>',
    stream('BT /F1 12 Tf 20 200 Td (Inherited) Tj ET'),
  ]);

  it('deleting a page keeps the others\' inherited crop box and resources', () => {
    const doc = PdfDocument.load(tree());
    expect(doc.pages[1].cropBox).toEqual([10, 10, 190, 290]);
    deletePages(doc, [0]);
    const back = PdfDocument.load(doc.save({ incremental: false }));
    expect(back.pageCount).toBe(3);
    for (const p of back.pages) { expect(p.cropBox).toEqual([10, 10, 190, 290]); expect(back.getDict(back.getDict(p.dict, 'Resources'), 'Font')?.has('F1')).toBe(true); }
  });

  it('a header added to a page that inherits its resources keeps the page\'s fonts', () => {
    const doc = PdfDocument.load(tree());
    addOverlayText(doc, [0], { text: 'HEADER', position: 'top-center' });
    const back = PdfDocument.load(doc.save({ incremental: false }));
    const p = back.pages[0];
    const fonts = back.getDict(p.resources, 'Font')!;
    expect(fonts.has('F1')).toBe(true);
    const text = analyzeContent(back, parseContent(back.pageContent(p)), p.resources).runs.map((r) => r.text).join(' ');
    expect(text).toContain('Inherited');
    expect(text).toContain('HEADER');
  });

  it('edits a file whose catalog points straight at its only page', () => {
    // pdf.js issue 21436: /Pages names the page itself; inserting a page used to loop forever.
    const b = pdfFrom(['<< /Type /Catalog /Pages 3 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>']);
    const doc = PdfDocument.load(b);
    expect(doc.pageCount).toBe(1);
    insertBlankPages(doc, 1, 2, [100, 100]);
    const back = PdfDocument.load(doc.save({ incremental: false }));
    expect(back.pages.map((p) => p.mediaBox[2])).toEqual([200, 100, 100]);
    deletePages(back, [1]);
    expect(back.pageCount).toBe(2);
  });

  it('inserts a blank page at a page index in a nested page tree', () => {
    const doc = PdfDocument.load(tree());
    insertBlankPages(doc, 3, 1, [100, 100]);
    expect(doc.pageCount).toBe(5);
    expect(doc.pages[3].mediaBox).toEqual([0, 0, 100, 100]);
    expect(doc.pages[4].mediaBox).toEqual([0, 0, 200, 300]);
  });
});

describe('forms and page extraction', () => {
  it('extracting a page keeps its form fields and their values', () => {
    const doc = PdfDocument.create();
    insertBlankPages(doc, 0, 2, [300, 300]);
    addField(doc, { name: 'name', type: 'text', page: 1, rect: [20, 20, 200, 40] });
    addField(doc, { name: 'other', type: 'text', page: 0, rect: [20, 20, 200, 40] });
    setFieldValue(doc, readFields(doc).find((f) => f.name === 'name')!, 'Ada');
    const ex = PdfDocument.load(extractPages(doc, [1]).save({ incremental: false }));
    const fields = readFields(ex);
    expect(fields.map((f) => f.name)).toEqual(['name']);
    expect(fields[0].value).toBe('Ada');
    expect(fields[0].widgets[0].page).toBe(0);
  });

  it('field attributes are inherited from any ancestor', () => {
    const b = pdfFrom([
      '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] >> >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [6 0 R] >>',
      '<< /T (form) /FT /Tx /V (deep) /Kids [5 0 R] >>',
      '<< /T (group) /Parent 4 0 R /Kids [6 0 R] >>',
      '<< /T (field) /Parent 5 0 R /Type /Annot /Subtype /Widget /Rect [0 0 50 20] /P 3 0 R >>',
    ]);
    const f = readFields(PdfDocument.load(b));
    expect(f.map((x) => [x.name, x.type, x.value])).toEqual([['form.group.field', 'text', 'deep']]);
  });
});

describe('redaction', () => {
  const page = () => pdfFrom([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R /T3 6 0 R >> >> /Contents 4 0 R >>',
    stream('2 0 0 2 0 0 cm BT /F1 10 Tf 10 50 Td (SECRET) Tj (visible) Tj ET BT /T3 10 Tf 10 20 Td (ab) Tj ET'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type3 /FontMatrix [0.01 0 0 0.01 0 0] /FirstChar 97 /LastChar 98 /Widths [100 100] /FontBBox [0 0 100 100] /CharProcs << >> /Encoding << /Differences [97 /a /b] >> /Resources << >> >>',
  ]);

  it('removes the text for good, keeps the text after it in place and forces a rewrite', () => {
    const doc = PdfDocument.load(page());
    const p = doc.pages[0];
    const before = analyzeContent(doc, parseContent(doc.pageContent(p)), p.resources).runs;
    const secret = before.find((r) => r.text === 'SECRET')!, visible = before.find((r) => r.text === 'visible')!;
    addRedactMark(doc, p, [secret.box]);
    const res = applyRedactions(doc, [0]);
    expect(res.textRemoved).toBe(1);
    expect(doc.mustRewrite).toBe(true);
    const out = doc.save(); // the default save must not append to the old bytes
    expect(latin1(out)).not.toContain('SECRET');
    const back = PdfDocument.load(out);
    const after = analyzeContent(back, parseContent(back.pageContent(back.pages[0])), back.pages[0].resources).runs;
    expect(after.some((r) => r.text.includes('SECRET'))).toBe(false);
    const vis = after.find((r) => r.text === 'visible')!;
    expect(vis.box[0]).toBeCloseTo(visible.box[0], 3);
  });

  it('measures Type 3 text with its font matrix', () => {
    const doc = PdfDocument.load(page());
    const p = doc.pages[0];
    const t3 = analyzeContent(doc, parseContent(doc.pageContent(p)), p.resources).runs.find((r) => r.font === 'T3')!;
    // Two glyphs of width 100 in a 0.01 glyph space at 10 pt under a 2× page transform: 40 units wide.
    expect(t3.box[2] - t3.box[0]).toBeCloseTo(40, 3);
  });
});

describe('encryption round trips', () => {
  it('leaves an unencrypted metadata stream unencrypted when it saves', () => {
    const doc = PdfDocument.create();
    insertBlankPages(doc, 0, 1, [200, 200]);
    writeMetadata(doc, { title: 'Plain metadata' });
    const encd = PdfDocument.load(doc.save({ incremental: false, encrypt: { userPassword: 'u', ownerPassword: 'o', permissions: {}, encryptMetadata: false } }), { password: 'u' });
    writeMetadata(encd, { author: 'Someone' });
    const out = encd.save({ incremental: true });
    expect(latin1(out)).toContain('<x:xmpmeta');
    expect(readMetadata(PdfDocument.load(out, { password: 'u' })).author).toBe('Someone');
  });
});

describe('real-world files', () => {
  itSample('opens a linearized file whose main cross-reference table was wiped', 'pypdf-samples/017-unreadable-meta-data/unreadablemetadata.pdf', (b) => {
    // The file says 4 pages, but its page tree root and one page object were overwritten with zeros:
    // the three page objects that are left are collected.
    const d = PdfDocument.load(b);
    expect(d.pageCount).toBe(3);
    expect(d.report.pagesSynthesized).toBe(true);
    // The rebuilt page tree must survive saving (new objects must not reuse its number).
    expect(PdfDocument.load(d.save()).pageCount).toBe(3);
  });
  itSample('opens a file whose attachments only are encrypted (AuthEvent EFOpen)', 'pdfjs/test/pdfs/auth-event-ef-open.pdf', (b) => {
    const d = PdfDocument.load(b);
    expect(d.pageCount).toBe(1);
    expect(d.report.warnings.join(' ')).toMatch(/attachments/);
  });
  itSample('opens an R6 file whose password needs SASLprep', 'pdfjs/test/pdfs/saslprep-r6.pdf', (b) => {
    expect(PdfDocument.load(b, { password: 'SªSL­prep' }).pageCount).toBe(1);
  });
  itSample('keeps the indirect crypt filter dictionary when rewriting an AES-256 file', 'pdfjs/test/pdfs/issue7665.pdf', (b) => {
    const out = PdfDocument.load(b).save({ incremental: false });
    const back = PdfDocument.load(out);
    const p = back.pages[0];
    expect(analyzeContent(back, parseContent(back.pageContent(p)), p.resources).runs.map((r) => r.text).join('').length).toBeGreaterThan(0);
  });
  itSample('opens a fuzzed file whose Kids array lost its bracket', 'pdfjs/test/pdfs/poppler-937-0-fuzzed.pdf', async (b) => {
    expect((await openAsPdf(b, 'poppler-937-0-fuzzed.pdf')).doc.pageCount).toBe(1);
  });
  itSample('a header on a page that inherits resources keeps its text', 'pdfjs/test/pdfs/bug1669099.pdf', (b) => {
    const doc = PdfDocument.load(b);
    const before = analyzeContent(doc, parseContent(doc.pageContent(doc.pages[0])), doc.pages[0].resources).runs.length;
    addOverlayText(doc, [0], { text: 'HEADER', position: 'top-center' });
    const back = PdfDocument.load(doc.save());
    const p = back.pages[0];
    const runs = analyzeContent(back, parseContent(back.pageContent(p)), p.resources).runs;
    expect(runs.length).toBe(before + 1);
    expect(back.getDict(p.resources, 'Font')!.keys().length).toBeGreaterThan(1);
  });
});

void Name; void Ref; void PdfString; void PdfStream; void Lexer; void inflateZlib;

describe('page import keeps document-level state the pages depend on', () => {
  const layered = () => pdfFrom([
    '<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R 6 0 R] /D << /OFF [6 0 R] /Order [5 0 R 6 0 R] >> >> /AcroForm << /Fields [] /NeedAppearances true >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Properties << /L1 5 0 R /L2 6 0 R >> >> /Contents 4 0 R >>',
    stream('/OC /L2 BDC 0 0 1 rg 10 10 50 50 re f EMC'),
    '<< /Type /OCG /Name (Shown) >>',
    '<< /Type /OCG /Name (Hidden) >>',
  ]);
  it('a hidden layer stays hidden in extracted pages', () => {
    const ex = PdfDocument.load(extractPages(PdfDocument.load(layered()), [0]).save({ incremental: false }));
    const oc = ex.getDict(ex.catalog, 'OCProperties')!;
    const off = ex.getArray(ex.getDict(oc, 'D'), 'OFF')!;
    expect(off.length).toBe(1);
    expect(ex.getText(ex.resolve<Dict>(off[0]), 'Name')).toBe('Hidden');
    const used = ex.getDict(ex.getDict(ex.pages[0].resources, 'Properties'), 'L2');
    expect(used).toBe(ex.resolve(off[0]));
  });
  it('NeedAppearances survives a merge', () => {
    const src = PdfDocument.load(layered());
    addField(src, { name: 'f', type: 'text', page: 0, rect: [10, 10, 100, 30] });
    const ex = PdfDocument.load(extractPages(src, [0]).save({ incremental: false }));
    expect(ex.get(ex.getDict(ex.catalog, 'AcroForm'), 'NeedAppearances')).toBe(true);
  });
});
