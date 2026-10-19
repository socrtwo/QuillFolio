# Contributing to QuillFolio

Thanks for your interest. QuillFolio is an original, clean-room PDF app; the rules below keep it that way and keep the suite consistent.

## What helps most

- **Bug reports with files:** PDFs you made yourself (or that are openly licensed) that render, fill or save wrongly, and damaged files for the repair pipeline. Say which reader produced them. Never attach confidential documents.
- **Feedback on the plan:** missing commands, wrong command placement, ideas from other PDF software, and corrections to [docs/INNOVATIONS.md](docs/INNOVATIONS.md).
- **Code:** see below.

## Rules

- **Clean room.** No code, text, icons or assets copied from proprietary software, and no reading of leaked or decompiled sources. Write from the public specifications (ISO 32000, XFDF, FDF, the image formats) and from the behavior you observe in files. Vendor product names appear only in file-type lists and in [docs/LEGAL.md](docs/LEGAL.md); the interface uses generic terms.
- **No missing commands.** Every feature is a `def()` command in `src/commands/*.ts` with an id, a label, a Material Symbols icon, a tab and a group. Tabs, the Quick Access Bar, menus, shortcuts, macros and search use ids only. Register a command only when it works; planned ids go in [docs/COMMANDS-PLAN.md](docs/COMMANDS-PLAN.md).
- **The engine is the document of record.** Changes go through `src/pdf` (objects, writer, ops); pdf.js is used for drawing and text extraction only. Every edit must survive `doc.save({ incremental: true })` and `doc.save({ incremental: false })`; add a unit test that round-trips it.
- **American English** in the interface, comments and docs. **MIT** license; only permissive dependencies (never GPL/LGPL). Do not put model names or AI attribution in files.
- Keep the shared shell files (`src/ui/*`, `src/ai/*`, `src/proof/*`, `src/platform/*`, `scripts/*`) as close to QuillStage's as possible so fixes port across the suite.

## Working on the code

```bash
npm install
npm run dev          # Vite dev server
npm run typecheck && npm test && npm run build
npm run catalog      # regenerates docs/COMMANDS.md (a test fails when it is stale)
npm run e2e          # Playwright smoke test against the build
```

Platform builds: [docs/BUILD.md](docs/BUILD.md). Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Pull requests

One topic per pull request. Describe the file or command it changes, add or update tests, run the checks above, and keep the generated catalog in sync. By contributing you agree that your contribution is licensed under the MIT License.
