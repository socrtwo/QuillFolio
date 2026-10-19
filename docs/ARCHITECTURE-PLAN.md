# Architecture plan

The intended shape of QuillFolio. [ARCHITECTURE.md](ARCHITECTURE.md) describes what is built.

- **Stack:** TypeScript, Vite, vitest, Capacitor (Android, iOS), Electron (Windows, macOS, Linux); the same CI and release workflows as the sister apps.
- **Shell (shared with the suite):** command registry, ribbon tabs and groups built from command ids, Quick Access Bar, customizable tabs and keyboard, command search, macro recorder, backstage, panes, dialogs, AI wizard and providers, spelling worker and dictionaries, recovery helpers, platform layer.
- **Engine (own code, `src/pdf`):** a lossless object model (names, strings, numbers, references, dictionaries, arrays, streams) with a tolerant lexer and parser; filters; cross-reference tables, streams and object streams; the standard security handler; a document class whose edits live in an overlay until written; a writer for incremental updates and full rewrites; content-stream parsing and analysis; readers and writers for outlines, labels, attachments, layers, metadata, annotations, fields and signatures; operations for pages, annotations, forms, text editing, optimization, extraction; the repair pipeline.
- **Viewer (`src/view`):** pdf.js renders the bytes the engine produces: canvas per page, a selectable text layer, lazy rendering, thumbnails, search; an SVG overlay for selection handles, drawing in progress, search hits and field highlights. The viewer never changes the document; gestures become commands.
- **Commands (`src/commands`):** one module per tab; each command is data plus a `run` function that calls the engine inside an undoable step (`app.edit`).
- **Undo:** snapshots of the engine overlay (the changed-objects map, trailer and next object number) before each edit; undo and redo swap snapshots and re-render.
- **Export:** images through the renderer; text, Markdown, HTML, CSV through the engine's text extraction; form and comment data as XFDF/FDF/CSV/JSON; review packages as ZIP.
- **OCR:** tesseract.js in a worker, bundled; language data downloaded on demand with consent; results written as an invisible text layer into the page content.
- **AI:** the suite's providers; prompts in `src/ai/folio.ts`; only the text a command needs leaves the device; results previewed; changes applied as one undoable step.
- **Repair:** [REPAIR.md](REPAIR.md).
- **Security:** no server; document scripts never run; links checked before opening; keys in the platform keystore; file access on the desktop limited to files the user opened or saved.
- **Later:** certificate signing, linearization, conforming archival output, JBIG2/JPX decoding in the engine, CID-font text editing, font embedding, portfolio creation.
