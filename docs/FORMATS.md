# File formats (as built)

Detection is by content: the sniffing in `src/io/index.ts` looks at the bytes first and at the extension second, so a PDF renamed `.txt` still opens as a PDF and a damaged file with objects but no header still reaches the repair pipeline.

## Opening

| Format | Result |
|---|---|
| PDF, any version; xref tables, xref streams, object streams, hybrid files | Opens in the engine; pdf.js renders |
| Encrypted PDF (RC4, AES-128, AES-256) | Opens with the empty user password or asks for one; the lock in the status bar shows the security settings |
| Damaged PDF | Repaired on open when the normal parse fails or finds no pages; `File ▸ Open and Repair` forces the full pipeline and shows the report |
| FDF, XFDF | Form data and comments are applied to the open document (`Forms ▸ Import Data`, `Comment ▸ Import Comments`); opening one directly explains this |
| PNG, JPEG, GIF, WebP, BMP, TIFF, SVG | A new PDF with one page sized to the picture (JPEG embedded as is) |
| TXT, Markdown, HTML | A new PDF typeset with Helvetica (headings, paragraphs, lists) |
| ZIP of PDFs | The PDFs combined into one document, in name order |
| QuillFolio review package (.qfr) | The PDF with the package's XFDF comments applied |
| PDF portfolio | The cover document; the embedded files are in the Attachments pane |

## Saving

| Choice | What is written |
|---|---|
| Save (default) | An incremental update appended to the original bytes: fast, keeps signatures, keeps earlier versions |
| Save As ▸ PDF (rewrite) | A full rewrite: objects renumbered, unused objects dropped, no earlier versions |
| Save As ▸ PDF (optimized) | A rewrite with recompressed streams and object streams |
| Save As ▸ Flattened PDF | A copy with comments and form fields drawn into the pages |
| Save As ▸ Review package | A ZIP with the PDF, XFDF comments, audit log and report |
| Protect ▸ Encrypt | AES-256 with an open and/or a permissions password; the open document is replaced by the encrypted one in memory and Save writes it |
| Export | Pages as PNG/JPEG (one file or a ZIP), text, Markdown, HTML, CSV tables, images, attachments, form data (XFDF, FDF, CSV, JSON), comments (XFDF) |

## Limits

- Image streams compressed with JBIG2 or JPEG 2000 are displayed (pdf.js decodes them) but cannot be extracted, recompressed or redacted pixel by pixel by the engine; redaction removes the whole image when it overlaps a mark.
- Text in CID (composite) fonts is read for extraction and search but edited by overlay only.
- Fonts are not embedded by QuillFolio; new text uses the standard 14 fonts.
- XFA form content is not rendered.
