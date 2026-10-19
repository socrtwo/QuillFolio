import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import '../../src/commands/index';
import { allCommands, getCommand } from '../../src/commands/registry';
import { DEFAULT_TABS, BACKSTAGE_ITEMS } from '../../src/ui/ribbonLayout';
import { QAT_STANDARD, QAT_CHOICES, DEFAULT_QAT, addAllQatChoices } from '../../src/prefs';
import { plannedIds } from '../../scripts/plan-ids';
import { catalog } from '../../scripts/catalog';

const label = (id: string) => getCommand(id)?.label;

describe('command registry', () => {
  it('every command has a label, an icon and a tab', () => {
    for (const c of allCommands()) {
      expect(c.label, c.id).toBeTruthy();
      expect(c.icon, c.id).toBeTruthy();
      expect(c.tab, c.id).toBeTruthy();
      expect(c.id, c.id).toMatch(/^[a-z]+\.[A-Za-z0-9.]+$/);
    }
  });

  it('has several hundred commands', () => {
    expect(allCommands().length).toBeGreaterThan(300);
  });

  it('every id on a ribbon tab, the backstage and the default QAT exists', () => {
    for (const t of DEFAULT_TABS) for (const g of t.groups) for (const id of g.items) expect(getCommand(id), `${t.id} ▸ ${g.id} ▸ ${id}`).toBeTruthy();
    for (const id of [...BACKSTAGE_ITEMS, ...DEFAULT_QAT]) expect(getCommand(id), id).toBeTruthy();
  });

  it('menus and galleries offer entries', () => {
    for (const c of allCommands()) if (c.kind === 'gallery' || c.kind === 'menu') expect(typeof c.menu, c.id).toBe('function');
  });

  it('every id the UI code executes exists', () => {
    for (const id of ['comment.toolDone', 'comment.moveAnnotation', 'edit.pickAt', 'organize.moveTo', 'organize.insertFiles', 'file.openDropped', 'file.recoverUnsaved', 'file.recoveryReport', 'protect.securityInfo', 'nav.goTo', 'home.select', 'view.organize', 'view.presentation', 'dev.stopRecording', 'tools.editBookmark', 'tools.deleteBookmark', 'tools.openAttachment', 'tools.saveAttachment', 'forms.fillValue', 'forms.properties', 'comment.properties', 'comment.reply', 'comment.delete']) expect(getCommand(id), id).toBeTruthy();
  });

  it('docs/COMMANDS.md is up to date (run npm run catalog)', () => {
    expect(readFileSync('docs/COMMANDS.md', 'utf8')).toBe(catalog());
  });

  it('reports coverage of the planned inventory', () => {
    const planned = plannedIds(readFileSync('docs/COMMANDS-PLAN.md', 'utf8'));
    const done = planned.filter((id) => getCommand(id));
    expect(planned.length).toBeGreaterThan(300);
    expect(done.length / planned.length).toBeGreaterThan(0.9);
  });
});

describe('Quick Access Bar choices', () => {
  it('every drop-down choice is a registered command', () => {
    for (const id of QAT_CHOICES) expect(getCommand(id), id).toBeTruthy();
  });

  it('covers the union of the desktop drop-down lists', () => {
    for (const id of ['file.autosave', 'file.new', 'file.open', 'file.save', 'file.email', 'file.quickPrint', 'file.print', 'review.spelling', 'edit.undo', 'edit.redo', 'view.readMode', 'view.touchMode', 'file.openRecent']) expect(QAT_STANDARD).toContain(id);
  });

  it('Add All gives the order documented in docs/QAT.md', () => {
    const out = addAllQatChoices(DEFAULT_QAT, label);
    expect(out.slice(0, QAT_CHOICES.length)).toEqual([
      'file.save', 'file.print', 'file.autosave', 'file.email', 'file.export.images', 'forms.fillMode', 'edit.find', 'home.hand', 'comment.highlight',
      'file.new', 'comment.note', 'file.open', 'file.openRecent', 'file.quickPrint', 'view.readMode', 'edit.redo', 'organize.rotateRight', 'file.saveAs',
      'view.cmdSearch', 'home.select', 'file.share', 'review.spelling', 'view.touchMode', 'edit.undo',
    ]);
  });

  it('Add All keeps other items after the choices and is idempotent', () => {
    const out = addAllQatChoices([...DEFAULT_QAT, '|', 'comment.pen'], label);
    expect(out.slice(QAT_CHOICES.length)).toEqual(['|', 'comment.pen']);
    expect(addAllQatChoices(out, label)).toEqual(out);
  });
});
