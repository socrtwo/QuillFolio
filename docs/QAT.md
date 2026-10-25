# The Quick Access Bar

The Quick Access Bar (QAT) is the row of always-visible buttons in the title bar. It can sit above the ribbon (default), below it, or at the bottom of the window near the on-screen keyboard (`view.qatPosition`), with or without labels (`view.qatLabels`), and it can be hidden (`view.qatHide`, `view.qatShow`).

## The drop-down checklist

The ▾ at the end of the bar lists the commands desktop programs have offered in their Quick Access drop-downs over the years, so that nothing a desktop PDF program puts there is missing. Anne's Folio's list is the **union** of the suite's standard choices plus its own extras.

**Standard choices (`QAT_STANDARD`):**

| | Command | Id |
|---|---|---|
| 1 | AutoSave | `file.autosave` |
| 2 | New | `file.new` |
| 3 | Open | `file.open` |
| 4 | Save | `file.save` |
| 5 | Email | `file.email` |
| 6 | Quick Print | `file.quickPrint` |
| 7 | Print | `file.print` |
| 8 | Spelling | `review.spelling` |
| 9 | Undo | `edit.undo` |
| 10 | Redo | `edit.redo` |
| 11 | Read Mode (this app's "present from beginning") | `view.readMode` |
| 12 | Touch/Mouse Mode | `view.touchMode` |
| 13 | Open Recent File | `file.openRecent` |

**Anne's Folio extras (`QAT_EXTRAS`):** Select (`home.select`), Hand (`home.hand`), Highlight (`comment.highlight`), Note (`comment.note`), Rotate Right (`organize.rotateRight`), Save As (`file.saveAs`), Share (`file.share`), Export Pages as Images (`file.export.images`), Find (`edit.find`), Fill Mode (`forms.fillMode`), Search Commands (`view.cmdSearch`).

**Default bar (`DEFAULT_QAT`):** Save, Undo, Redo, Select, Highlight, Search Commands.

## Add All Choices (A–Z)

`view.qatAddAll` puts every drop-down choice on the bar: **Save** and **Print** first (the two most used), then the rest in alphabetical order of their labels, then whatever else was already on the bar. The order, which the unit test checks:

| # | Command | Id |
|---|---|---|
| 1 | Save | `file.save` |
| 2 | Print | `file.print` |
| 3 | AutoSave | `file.autosave` |
| 4 | Email | `file.email` |
| 5 | Export Pages as Images | `file.export.images` |
| 6 | Fill Mode | `forms.fillMode` |
| 7 | Find | `edit.find` |
| 8 | Hand | `home.hand` |
| 9 | Highlight | `comment.highlight` |
| 10 | New | `file.new` |
| 11 | Note | `comment.note` |
| 12 | Open | `file.open` |
| 13 | Open Recent File | `file.openRecent` |
| 14 | Quick Print | `file.quickPrint` |
| 15 | Read Mode | `view.readMode` |
| 16 | Redo | `edit.redo` |
| 17 | Rotate Right | `organize.rotateRight` |
| 18 | Save As | `file.saveAs` |
| 19 | Search Commands | `view.cmdSearch` |
| 20 | Select | `home.select` |
| 21 | Share | `file.share` |
| 22 | Spelling | `review.spelling` |
| 23 | Touch/Mouse Mode | `view.touchMode` |
| 24 | Undo | `edit.undo` |

Running Add All again changes nothing (it is idempotent); separators and other commands stay after the choices.

## More commands

**More Commands…** (`file.customizeQat`) opens the customize dialog with every command in the app, by tab: add, remove, add a separator, move up or down, reset, and import or export the layout as JSON (the format is shared with the other Anne's Office apps). Long-press or right-click any ribbon button to add it to the bar. Macros appear in the list as `macro:<name>`.
