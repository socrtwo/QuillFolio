# Quick Access Bar plan

> **Plan.** QuillFolio has no code yet. This document fixes what the Quick Access Bar (QAT) will offer, so that nothing a desktop presentation program puts on its Quick Access Toolbar is missing. It follows the implementation already shipped in QuillGrid and QuillPen (`QAT_STANDARD`, `QAT_EXTRAS`, `addAllQatChoices` in the shared shell).

## Principles

- Every command is eligible. The QAT stores command ids; any of the commands in [COMMANDS-PLAN.md](COMMANDS-PLAN.md), plus macros and separators, can be placed on it.
- The drop-down arrow at the end of the bar offers the **standard choices** as a checklist, so the common ones are one tap away without opening a dialog.
- QuillFolio's checklist is the **union** of the choices that the desktop presentation program has offered across its versions, plus a few presentation extras. Nothing that any version offered is left out.
- The bar can sit at the top, below the ribbon, or **at the bottom near the on-screen keyboard** (a QuillPen/QuillGrid innovation), and can show or hide command labels.

## The desktop drop-down choices, by version

The table records the *Customize Quick Access Toolbar* drop-down in Microsoft PowerPoint for Windows. It was compiled from product knowledge and documentation of each release; it must be checked against installed copies before implementation (tracked in [ROADMAP.md](ROADMAP.md), M1). Because QuillFolio offers the union, an error in a single cell changes nothing in the plan except a footnote.

| Choice (desktop label) | 2007 | 2010 | 2013–2019 | Microsoft 365 (2021+) | QuillFolio command |
|---|---|---|---|---|---|
| AutoSave | — | — | — | Yes (appears when signed in; shown as a switch) | `file.autosave` |
| New | Yes | Yes | Yes | Yes | `file.new` |
| Open | Yes | Yes | Yes | Yes | `file.open` |
| Save | Yes | Yes | Yes | Yes | `file.save` |
| E-mail / Email | Yes | Yes | Yes | Yes | `file.email` |
| Quick Print | Yes | Yes | Yes | Yes | `file.quickPrint` |
| Print Preview (2007) / Print Preview and Print (2010+) | Yes | Yes | Yes | Yes | `file.print` (the print screen includes the preview) |
| Spelling | Yes | Yes | Yes | Yes | `review.spelling` |
| Undo | Yes | Yes | Yes | Yes | `edit.undo` |
| Redo (Repeat when nothing to redo) | Yes | Yes | Yes | Yes | `edit.redo` |
| Start From Beginning / From Beginning / Present from Beginning | Yes¹ | Yes | Yes | Yes | `show.fromStart` |
| Open Recent File | — | Yes | — | — | `file.openRecent` |
| Touch/Mouse Mode | — | — | Yes | Yes | `view.touchMode` |
| More Commands… | Yes | Yes | Yes | Yes | opens Customize Quick Access Bar (`file.customizeQat`) |
| Show Below the Ribbon / Show Above the Ribbon | Yes | Yes | Yes | Yes | `view.qatPosition` (adds *At the Bottom*) |
| Minimize the Ribbon / Collapse the Ribbon | Yes | Yes | Yes² | via Ribbon Display Options | `view.collapseRibbon` |
| Hide Quick Access Toolbar | — | — | — | Yes | `view.qatHide` (restore: `view.qatShow`) |
| Hide / Show command labels | — | — | — | Yes (simplified QAT) | `view.qatLabels` |

¹ Labeled *Slide Show From Beginning* or *Start From Beginning* depending on the release.
² Later releases moved this to the ribbon's own pin/collapse control and the right-click menu.

### Notes on other versions and related lists

- **Other Office applications** had different extras in the same drop-down: Word offered *Draw Table* (and *Spelling & Grammar*), Excel offered *Sort Ascending* and *Sort Descending*. *Form…* is an Excel command that was only available through *Commands Not in the Ribbon*. None of these was in PowerPoint's list. QuillFolio nevertheless offers **Draw Table** among its extras, because PowerPoint has the command (Insert ▸ Table ▸ Draw Table); a Form command does not apply to presentations (data-entry forms are covered by QuillGrid, and audience forms by Poll and Quiz).
- **PowerPoint for Mac** customizes its toolbar through a separate menu with a similar set (AutoSave, Home, Save, Undo, Redo, Print, and present commands). Any Mac-only choice found when verifying will be added to the extras.
- **PowerPoint for the web** gained a simplified Quick Access Toolbar with a shorter list; every item on it is already in the union above.
- The **right-click menu** on any command offers *Add to Quick Access Toolbar*, *Customize Quick Access Toolbar…*, *Show Quick Access Toolbar Below the Ribbon* and *Collapse the Ribbon*. QuillFolio offers the same on right-click and on **long-press** for touch.
- PowerPoint 2003 and earlier used toolbars, not a Quick Access Toolbar; their standard toolbar commands are all in the command inventory.

## QuillFolio's drop-down

Shown in this order, as in QuillGrid:

1. **Standard choices** (the union above): AutoSave, New, Open, Save, Email, Quick Print, Print Preview and Print, Spelling, Undo, Redo, Present from Beginning, Touch/Mouse Mode, Open Recent File.
2. **Presentation extras:** Present from Current Slide (`show.fromCurrent`), Presenter View (`show.presenterView`), New Slide (`slide.new`), Duplicate Slide (`slide.duplicate`), Save As (`file.saveAs`), Share (`file.share`), Export to PDF (`file.export.pdf`), Draw Table (`insert.drawTable`), Find (`edit.find`), Format Painter (`edit.formatPainter`), Search Commands (`view.cmdSearch`).
3. **Add All Choices (Save, Print first, then A–Z)** (`view.qatAddAll`): puts every choice from lists 1 and 2 on the bar: **Save** and **Print Preview and Print** first, then the remaining choices sorted alphabetically by label (case-insensitive), then anything else already on the bar in its existing order. Separators are kept. The same action is a button in the Customize Quick Access Bar dialog.
4. **More Commands…** (`file.customizeQat`).
5. **Show Above the Ribbon / Show Below the Ribbon / Show at the Bottom (near keyboard)** (`view.qatPosition`).
6. **Show / Hide Command Labels** (`view.qatLabels`).
7. **Hide Quick Access Bar** (`view.qatHide`; restore from View ▸ Show Quick Access Bar or by long-pressing any command).
8. **Collapse the Ribbon / Show the Ribbon** (`view.collapseRibbon`).

The result of **Add All Choices** with the default choices is:

| # | Command | id |
|---|---|---|
| 1 | Save | `file.save` |
| 2 | Print Preview and Print | `file.print` |
| 3 | AutoSave | `file.autosave` |
| 4 | Draw Table | `insert.drawTable` |
| 5 | Duplicate Slide | `slide.duplicate` |
| 6 | Email | `file.email` |
| 7 | Export to PDF | `file.export.pdf` |
| 8 | Find | `edit.find` |
| 9 | Format Painter | `edit.formatPainter` |
| 10 | New | `file.new` |
| 11 | New Slide | `slide.new` |
| 12 | Open | `file.open` |
| 13 | Open Recent File | `file.openRecent` |
| 14 | Present from Beginning | `show.fromStart` |
| 15 | Present from Current Slide | `show.fromCurrent` |
| 16 | Presenter View | `show.presenterView` |
| 17 | Quick Print | `file.quickPrint` |
| 18 | Redo | `edit.redo` |
| 19 | Save As | `file.saveAs` |
| 20 | Search Commands | `view.cmdSearch` |
| 21 | Share | `file.share` |
| 22 | Spelling | `review.spelling` |
| 23 | Touch/Mouse Mode | `view.touchMode` |
| 24 | Undo | `edit.undo` |

**Default bar** (new installs): Save, Undo, Redo, Present from Beginning, New Slide, Search Commands.

## Customize Quick Access Bar dialog

As in the sister apps, the dialog has a *Choose commands from* list with these categories:

- **Popular Commands**
- **Commands Not in the Tabs** (every command that has no default place on a tab; see the *not in tabs* column in COMMANDS-PLAN.md)
- **All Commands**
- each built-in tab, including contextual tabs (Shape Format, Picture Format, Table Design, Chart Design, Diagram Design, Video Playback…), and each custom tab
- **Macros**

Buttons: Add, Remove, Add Separator, Move Up, Move Down, Add All A–Z, Reset, Import/Export (JSON, shared format with QuillPen and QuillGrid so common commands carry over), and a *Show below/above/at the bottom* option. Each deck can optionally carry its own QAT additions (as desktop programs allow "for this document only"); they are stored in the native format and in a custom part of .pptx that other programs ignore.
