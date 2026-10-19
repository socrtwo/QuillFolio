#!/usr/bin/env node
// Copies the renderer's and the OCR engine's static files into public/, so the app works offline on every
// platform: pdf.js CMaps, standard fonts, ICC profiles and WASM decoders (public/pdfjs/), and the
// Tesseract worker and core (public/tesseract/). Runs before `vite build` and `vite dev` (package.json).
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const copies = [
  ['pdfjs-dist/cmaps', 'public/pdfjs/cmaps'],
  ['pdfjs-dist/standard_fonts', 'public/pdfjs/standard_fonts'],
  ['pdfjs-dist/wasm', 'public/pdfjs/wasm'],
  ['pdfjs-dist/iccs', 'public/pdfjs/iccs'],
  ['tesseract.js/dist/worker.min.js', 'public/tesseract/worker.min.js'],
  // Only the LSTM cores the worker can pick (plain, SIMD, relaxed SIMD); the legacy engine cores stay out.
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'public/tesseract/core/tesseract-core-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'public/tesseract/core/tesseract-core-simd-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'public/tesseract/core/tesseract-core-relaxedsimd-lstm.wasm.js'],
  ['tesseract.js-core/LICENSE', 'public/tesseract/core/LICENSE'],
];
for (const [from, to] of copies) {
  const src = join(nm, from), dst = join(root, to);
  if (!existsSync(src)) { console.warn('missing', from); continue; }
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true, filter: (p) => !/\.(md|txt|map)$/i.test(p) || /LICENSE/i.test(p) });
}
console.log('copied renderer and OCR assets:', copies.map(([, t]) => t).join(', '), `(${readdirSync(join(root, 'public/pdfjs/cmaps')).length} CMaps)`);
