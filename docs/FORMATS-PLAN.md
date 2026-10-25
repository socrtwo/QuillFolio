# Formats plan

Every format Anne's Folio intends to open or save, detected by content (the bytes), not by extension. [FORMATS.md](FORMATS.md) says what works today.

| Format | Open | Save | Planned fidelity |
|---|---|---|---|
| PDF 1.0–1.7 and 2.0, including xref streams, object streams, hybrid files | Yes | Yes | Lossless: untouched objects are kept byte for byte; saves append an incremental update by default |
| Encrypted PDF: RC4 40/128, AES-128, AES-256 (revisions 2–6), empty or given user password, owner password | Yes | AES-256 | Permissions read and set; metadata encryption honored |
| Damaged PDF: missing header or %%EOF, broken or missing xref, wrong stream lengths, lost catalog or page tree, corrupt streams, truncation, PDF fused with other data | Yes (repair) | As rewritten PDF | [REPAIR.md](REPAIR.md) |
| PDF portfolios (collections) | Yes | Later | Embedded files listed and extracted; cover sheet shown |
| PDF/A, PDF/X, PDF/UA | Yes (as PDF) | Archival-ready; conforming output later | Checks report what blocks conformance |
| XFA forms | AcroForm fallback | – | XFA itself is not rendered |
| Form data: XFDF, FDF, CSV, JSON | Yes | Yes | Field names, values, choices; comments in XFDF |
| Comments: XFDF | Yes | Yes | Every annotation type Anne's Folio writes |
| Pictures: PNG, JPEG, GIF, WebP, BMP, TIFF (baseline, PackBits, LZW), SVG | As pages, overlays, stamps | PNG, JPEG per page | JPEG kept as is (DCTDecode); others decoded through the canvas |
| Text, Markdown, HTML | As pages | Text, Markdown, HTML | Simple typesetter: headings, paragraphs, lists; extraction with heading heuristics |
| CSV tables | – | Yes | Tables detected from text positions |
| ZIP of PDFs | Yes (combined) | Yes (split, batch, images) | |
| Anne's Folio review package (.qfr) | Yes | Yes | ZIP: `mimetype`, the PDF, XFDF comments, `report.json`, `audit-log.txt` |
| Office documents, e-mail | Through the sister apps' exports | Hand-off | Anne's Pen, Anne's Grid, Anne's Stage, Anne's Press export PDF; Anne's Post shares attachments |
| Scanned images (camera, scanner apps) | Yes | Searchable PDF | OCR text layer |
