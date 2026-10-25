# Innovations survey

What PDF software, past and present, has offered, and what Anne's Folio adopts from each. Ideas are described generically; product names identify where an idea came from (nominative use; see [LEGAL.md](LEGAL.md)). Command ids in backticks are implemented; the rest are listed in [ROADMAP.md](ROADMAP.md).

## The field, roughly in order of appearance

| Origin | What it contributed | Anne's Folio |
|---|---|---|
| **PostScript viewers and Ghostscript** (1980s–) | Interpreting page descriptions in software; command-line conversion and rewriting (`pdfwrite`), repair by re-interpretation | A full rewrite in memory that renumbers and recompresses (`tools.rewrite`, `tools.optimize`); batch processing of many files (`tools.batch`) |
| **The first PDF readers** (1993–) | Thumbnails, bookmarks, article threads, links, fit-page and fit-width, page labels, the invisible text layer over scanned pages | Thumbnail rail and grid (`view.thumbnails`, `view.organize`), bookmarks pane (`view.bookmarks`), page labels (`organize.pageLabels`), fit modes, OCR text layer (`scan.recognize`) |
| **Full PDF editors** (Acrobat and successors) | Annotations with popups and replies, stamps, form fields and data, digital signatures, redaction with removal of the underlying content, optimization, preflight, accessibility checks, Bates numbering, portfolios, compare, measurement | The Comment, Forms, Sign, Protect, Organize Pages and Review tabs; redaction that rewrites the content stream (`protect.applyRedactions`); archival and accessibility checks (`review.archivalCheck`, `review.checkAccessibility`); Bates (`organize.bates`); measurements with a scale (`comment.measure`, `comment.measureScale`); compare (`review.compare`) |
| **Lightweight viewers** (Preview, Sumatra, Okular, Evince, PDF-XChange, Foxit, MuPDF viewers) | Fast rendering, tabs, keyboard-driven navigation, inverted colors for reading at night, presentation mode, continuous and facing layouts, quick markup from a selection, Fill & Sign with a drawn signature | Document tabs, keyboard navigation (`nav.*`), night mode (`view.nightMode`), presentation mode (`view.presentation`), facing and book layouts, the Selected Text contextual tab, Fill & Sign (`sign.signature`) |
| **Command-line toolkits** (qpdf, pdftk, PDFsam, MuPDF tools, poppler utilities) | Split, merge, rotate, extract, N-up, booklet, decrypt, `--qdf` inspection, `pdfimages`, `pdftotext -layout`, cross-reference reconstruction | Split by count, ranges, bookmarks or size (`organize.split`), merge and combine, booklet and N-up (`organize.booklet`, `organize.nUp`), raw object view (`dev.rawObject`), image and layout-preserving text extraction (`tools.extractImages`, `tools.extractText`), reconstruction on open |
| **Scanning and OCR suites** | Deskew, despeckle, auto-crop, duplex reordering, compression of scanned images, searchable PDFs | The Scan/OCR tab (`scan.deskew`, `scan.despeckle`, `scan.autoCrop`, `scan.reorder`, `scan.compressScans`, `scan.recognize`) |
| **Review and markup tools** (engineering and legal markup software) | Measurement with calibrated scales, clouds, stamps galleries, markup summaries, review packages passed between reviewers | Revision clouds (`comment.cloud`), stamp gallery (`comment.stamp`), comment summary (`comment.summarize`), review packages (`file.saveReviewPackage`) |
| **Browser PDF viewers** (pdf.js, Chromium's viewer) | Rendering any PDF anywhere with no install; forms and annotations drawn from appearance streams; printing through the browser | pdf.js renders the pages; printing goes through the system print service (`file.print`) |
| **Office suites' PDF export** | Tagged PDF, headings as bookmarks, document properties | Bookmarks from headings by font size (`tools.bookmarksFromHeadings`), properties and XMP (`file.properties`, `tools.editXmp`) |
| **Document-cloud services** | Share links, request signatures, review sessions, version history | Request signatures by email draft (`sign.requestSignatures`), version history and snapshots (`file.versions`, `file.snapshot`), share sheet (`file.share`) |

## Anne's Folio's own ideas

- **Repair report with a diff.** Every damaged file gets a method-by-method report (what succeeded, what was partial, what failed) and a list of what was rebuilt and what was lost, with the recovered document opened as a new file (`file.openRepair`, `file.recoveryReport`). Lineage: the author's Immortal Zip, XML Truncator-Fixer and Word Recovery tools.
- **Structure inspector with raw objects.** A tree of the trailer, catalog, pages and resources with every object viewable as PDF syntax and decoded streams (`view.inspector`, `dev.rawObject`, `dev.exportStructure`).
- **Redaction log.** Applying redactions appends a log entry (who, when, how many text runs, images and areas) as an attachment inside the file, and the review package carries an audit log (`protect.redactLog`).
- **Pattern plus AI redaction suggestions.** Emails, phone numbers, identification and card numbers, dates and addresses found by patterns, and the AI's reading of the pages, merged into one checklist (`ai.suggestRedactions`).
- **Plain-language accessibility fixer.** The checks say what they can and cannot verify; the fixer sets the title, language and display-title flag and gives form fields tooltips (`review.accessibilityFixer`).
- **Document similarity.** Shingle overlap between open documents, for spotting duplicates and versions (`tools.similar`).
- **Searchable-pages report.** Which pages have text and which are image-only, with one click to recognize the rest (`scan.makeSearchableReport`).
- **Honest output names.** "Prepare for Archiving" rather than a PDF/A claim, "verify byte ranges" rather than "validate signature", until the implementation earns the name.
- **Everything is a command.** As in the rest of the suite: every feature placeable on the Quick Access Bar, a tab, a key or a macro, and searchable.

## Considered and skipped (for now)

- **Certificate signing and timestamps.** Needs a PKCS#7/CMS implementation and key management on every platform; on the roadmap.
- **Linearization.** Useful only for byte-range streaming from servers; the writer would need a second pass for the hint tables.
- **Full PDF/A, PDF/X and PDF/UA conformance.** Font embedding and color profiles are the hard parts; Anne's Folio reports what stands in the way instead of claiming conformance.
- **JavaScript in documents.** Never executed; listed and removable (`dev.javaScriptInfo`, `protect.removeJavaScript`).
- **XFA forms.** Shown through their AcroForm fallback only.
