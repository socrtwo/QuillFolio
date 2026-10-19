// Browser smoke test: serves dist/ with `vite preview`, builds a PDF with the engine, opens it, annotates,
// fills a field, rotates a page, saves, reopens, and checks the results.
// Usage: npm run build && npm run e2e   (set QF_URL to test an already-running server instead)
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = 4191;
let server = null;
let url = process.env.QF_URL;
if (!url) {
  server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore', detached: true });
  url = `http://localhost:${PORT}/`;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const exe = existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {};
const browser = await chromium.launch(exe);
const failures = [];
const check = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };

try {
  const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await p.addInitScript(() => localStorage.setItem('quillfolio.prefs.v1', JSON.stringify({ firstRun: false })));
  await p.goto(url, { waitUntil: 'networkidle' });
  await p.waitForSelector('.qf-page canvas');
  await p.waitForTimeout(800);

  check('commands registered', await p.evaluate(() => window.__qfAllIds.length > 300), true);
  check('blank document', await p.evaluate(() => qf.doc.pageCount), 1);

  // Build a three-page PDF with the engine and open it through the drop command.
  const built = await p.evaluate(async () => {
    const { PdfDocument } = await window.__qfEngine();
    const build = await window.__qfBuild();
    const d = PdfDocument.create();
    build.addTextPages(d, '# Smoke Test\n\nHello QuillFolio. This is page one.\n\n## Second heading\n\nMore text.', { title: 'Smoke' });
    build.addBlankPage(d);
    build.addBlankPage(d);
    const bytes = d.save({ incremental: false });
    window.__smokeBytes = bytes;
    const f = new File([bytes], 'smoke.pdf', { type: 'application/pdf' });
    await qf.exec('file.openDropped', [f]);
    await new Promise((r) => setTimeout(r, 1200));
    return { pages: qf.doc.pageCount, name: qf.tab.fileName, bytes: bytes.length };
  });
  check('opened pages', built.pages, 3);
  check('opened name', built.name, 'smoke.pdf');
  await p.waitForSelector('.qf-page[data-i="2"]');
  const text = await p.evaluate(() => qf.viewer.pageText(0));
  check('text layer', /Hello QuillFolio/.test(text), true);

  // Annotate: a note, a highlight and a text field through the engine commands.
  await p.evaluate(() => { void qf.exec('comment.toolDone', { tool: 'note', page: 0, start: [100, 700], end: [100, 700], rect: [100, 700, 100, 700], pts: [[100, 700]], click: true, opts: {} }); });
  await p.waitForSelector('.ql-dialog');
  await p.fill('.ql-dialog textarea', 'A smoke-test note');
  await p.click('.ql-dialog .ql-primary');
  await p.waitForTimeout(400);
  await p.evaluate(() => qf.exec('comment.toolDone', { tool: 'highlight', page: 0, start: [72, 690], end: [300, 720], rect: [72, 690, 300, 720], pts: [], click: false, opts: {} }));
  await p.waitForTimeout(400);
  await p.evaluate(() => { void qf.exec('comment.toolDone', { tool: 'field-text', page: 1, start: [72, 600], end: [300, 630], rect: [72, 600, 300, 630], pts: [], click: false, opts: {} }); });
  await p.waitForTimeout(400);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  const annots = await p.evaluate(() => qf.viewer.annotsOf(0).map((a) => a.subtype).sort());
  check('annotations', annots.filter((s) => s !== 'Popup'), ['Highlight', 'Text']);

  // Fill the field by name and read the value back.
  const field = await p.evaluate(() => qf.viewer.annotsOf(1).find((a) => a.subtype === 'Widget'));
  check('field widget', !!field, true);
  const fieldName = await p.evaluate(async () => { const { readFields } = await window.__qfStructure(); return readFields(qf.doc)[0].name; });
  await p.evaluate((n) => { void qf.exec('forms.fillValue', n); }, fieldName);
  await p.waitForSelector('.ql-dialog');
  await p.fill('.ql-dialog input[type="text"]', 'filled by smoke');
  await p.click('.ql-dialog .ql-primary');
  await p.waitForTimeout(400);
  check('field value', await p.evaluate(async () => { const { readFields } = await window.__qfStructure(); return readFields(qf.doc)[0].value; }), 'filled by smoke');

  // Rotate page 3, undo, redo.
  await p.evaluate(() => { qf.viewer.selectPage(2); qf.exec('organize.rotateRight'); });
  await p.waitForTimeout(300);
  check('rotated', await p.evaluate(() => qf.doc.pages[2].rotate), 90);
  await p.evaluate(() => qf.exec('edit.undo'));
  check('undo', await p.evaluate(() => qf.doc.pages[2].rotate), 0);
  await p.evaluate(() => qf.exec('edit.redo'));
  check('redo', await p.evaluate(() => qf.doc.pages[2].rotate), 90);

  // Save (incremental and rewritten) and reopen each.
  const round = await p.evaluate(async () => {
    const { PdfDocument } = await window.__qfEngine();
    const { readFields, pageAnnotations } = await window.__qfStructure();
    const out = [];
    for (const incremental of [true, false]) {
      const bytes = qf.doc.save({ incremental });
      const d = PdfDocument.load(bytes);
      out.push([incremental ? 'incremental' : 'rewrite', d.pageCount, d.pages[2].rotate, readFields(d)[0].value, pageAnnotations(d, d.pages[0]).filter((a) => a.subtype !== 'Popup').length, bytes.length > 500]);
    }
    return out;
  });
  check('round trips', round, [['incremental', 3, 90, 'filled by smoke', 2, true], ['rewrite', 3, 90, 'filled by smoke', 2, true]]);

  // Search finds the text; organize grid renders thumbnails; views switch.
  const hits = await p.evaluate(() => qf.viewer.search('QuillFolio'));
  check('search', hits.map((h) => h.page), [0]);
  await p.evaluate(() => qf.exec('view.organize'));
  await p.waitForSelector('.qf-gthumb');
  check('grid thumbs', await p.evaluate(() => document.querySelectorAll('.qf-gthumb').length), 3);
  await p.evaluate(() => qf.exec('view.organize'));
  for (const v of ['view.single', 'view.facing', 'view.continuous', 'view.nightMode', 'view.nightMode']) { await p.evaluate((id) => qf.exec(id), v); await p.waitForTimeout(120); }

  // Repair: damage the saved bytes (drop the xref) and open again.
  const repaired = await p.evaluate(async () => {
    const bytes = qf.doc.save({ incremental: false });
    const text = new TextDecoder('latin1').decode(bytes);
    const cut = text.lastIndexOf('xref');
    const damaged = new TextEncoder().encode(text.slice(0, cut) + 'garbage');
    const io = await window.__qfIO();
    const r = await io.openAsPdf(new Uint8Array(damaged), 'damaged.pdf');
    return [r.doc.pageCount, !!r.repair];
  });
  check('repair', repaired, [3, true]);

  if (errs.length) failures.push(...errs);
} finally {
  await browser.close();
  if (server) try { process.kill(-server.pid); } catch { /* already gone */ }
}

if (failures.length) { console.error('E2E failures:\n' + failures.join('\n')); process.exit(1); }
console.log('E2E smoke test passed');
