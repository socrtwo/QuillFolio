# The AI tab

AI features are optional. Nothing is sent anywhere until you run an AI command, and the first use of a cloud provider asks for consent and says where the text goes.

## Setup

**AI ▸ Set Up AI** (`ai.setup`) is the suite's wizard. Choices, free ones first:

- **On this device:** a small model downloaded once (Transformers.js) that runs in the browser or app, offline, with no account. Good for summaries, clean-up and classification; slower and weaker than hosted models.
- **Free cloud tiers** of several providers (your own key; free tiers may use what you send to improve their models).
- **Your own computer:** a local server speaking the OpenAI-compatible API (Ollama, LM Studio and similar).
- **Paid keys** for OpenAI-, Anthropic- and Gemini-style APIs, OpenRouter (with sign-in) and others.

**Providers & Models** (`ai.providers`) switches providers, picks a fast and a quality model, tests and removes keys. **AI Settings** (`ai.settings`) turns AI off entirely, sets the language of generated text and a style guide, and shows usage. Keys are stored on the device only (the platform keystore on Android, encrypted storage on the desktop, local storage in browsers) and never written into documents, drafts or exported settings.

## Several AIs

**Several AIs** (`ai.ensembleMode`) sends one request to several providers: one AI combines the others' answers (**master**), or they deliberate Quaker-style, uniting, standing aside or blocking until they agree (**consensus**). See [ENSEMBLE.md](ENSEMBLE.md).

## What the commands do

Every command sends only the text it needs, shows the answer for review, and applies changes (notes, field tooltips, OCR corrections, bookmarks, redaction marks) as one undoable step.

**Understand:** Summarize Document (`ai.summarize`), Summarize Page (`ai.summarizePage`), Explain Selection (`ai.explain`), Ask the Document (`ai.askDocument`, which first picks the pages whose words match the question and sends those), Key Points (`ai.keyPoints`).

**Extract:** Extract Table (`ai.extractTable`, CSV from a flattened table), Extract Entities (`ai.extractEntities`), Label Form Fields (`ai.classifyFields`, tooltips suggested from the nearby text and applied to the fields you keep).

**Write:** Translate (`ai.translate`), Rewrite Comment and Draft Reply (`ai.rewriteComment`, `ai.replyComment`, on the selected annotation), Clean OCR Text (`ai.cleanOcr`, corrections to the recognized text layer of the current page, applied word by word), Alt Text for Images (`ai.altText`, the page's pictures are sent to a vision-capable provider; the text is stored on each image object).

**Review:** Suggest Redactions (`ai.suggestRedactions`, patterns plus the AI's reading, merged into a checklist that marks the pages), Describe Page (`ai.describePage`), Suggest Bookmarks (`ai.suggestBookmarks`).

**More:** AI Assistant (`ai.assistant`, a conversation with the document text sent once), Prompt Library (`ai.prompts`, your own prompts on the selection, the page or the document).

Results can be copied, saved as text or CSV, added as a note on the page, or appended as new pages.

## Privacy

- **QuillFolio has no server.** Requests go directly from the device to the provider you chose.
- Only the text a command works on is sent: the selection, the current page, the matching pages for a question, or the document text (truncated to about 24,000 characters) for whole-document commands. Pictures are sent only by Alt Text for Images.
- The on-device model never sends anything.
- **AI & Privacy** (`ai.privacy`) shows the active provider and what is sent; **Stop AI** (`ai.stop`) cancels a request.

## Other online services

Text recognition downloads language data (about 2–15 MB per language) from the tessdata mirror tesseract.js uses, once per language, after a consent dialog; the page images are processed on the device. Spelling dictionaries for other languages are downloaded from the catalog's sources on request. Both are documented in [LEGAL.md](LEGAL.md).
