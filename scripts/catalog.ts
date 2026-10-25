/** Builds docs/COMMANDS.md from the live command registry (every command Anne's Folio defines). */
import { readFileSync } from 'node:fs';
import '../src/commands';
import { allCommands, getCommand } from '../src/commands/registry';
import { DEFAULT_TABS, idsInTabs } from '../src/ui/ribbonLayout';
import { plannedIds } from './plan-ids';

export function catalog(): string {
  const cmds = allCommands();
  const inTabs = idsInTabs();
  const mainTabs = DEFAULT_TABS.filter((t) => !t.contextual).map((t) => t.label);
  const contextualTabs = DEFAULT_TABS.filter((t) => t.contextual).map((t) => t.label);
  const order = ['Backstage', ...mainTabs, 'Navigation', 'Macros', ...contextualTabs];
  for (const t of new Set(cmds.map((c) => c.tab))) if (t && !order.includes(t)) order.push(t);
  const tabName = (t: string) => (t === 'Backstage' ? 'File' : contextualTabs.includes(t) ? `${t} (contextual)` : t);
  const key = (k: string) => k.replace(/Mod/g, 'Ctrl').replace(/-/g, '+').replace(/\+\+$/, '+-');
  const planned = plannedIds(readFileSync('docs/COMMANDS-PLAN.md', 'utf8'));
  const missing = planned.filter((id) => !getCommand(id));
  const lines: string[] = [];
  lines.push('# Anne\'s Folio Command Reference', '');
  lines.push(`Anne's Folio ships **${cmds.length} commands**. Every one can be placed on the Quick Access Bar, added to a custom tab, bound to a keyboard shortcut, recorded in a macro, or found with command search (Alt+Q).`, '');
  lines.push(`${cmds.filter((c) => !inTabs.has(c.id)).length} of them are "Commands Not in the Tabs" — reachable through the Quick Access Bar chooser, Customize Tabs, the command search, or menus — so nothing the app can do is hidden.`, '');
  lines.push(`Of the ${planned.length} command ids named in [COMMANDS-PLAN.md](COMMANDS-PLAN.md), ${planned.length - missing.length} are implemented and ${missing.length} are not yet; they are listed at the end of this file.`, '');
  lines.push('This file is generated from the source by `npm run catalog`; a unit test fails when it is out of date.', '');
  lines.push('## Default tab layout', '');
  for (const t of DEFAULT_TABS) lines.push(`- **${t.label}**${t.contextual ? ' (contextual)' : ''}: ${t.groups.map((g) => g.label).join(' · ')}`);
  lines.push('');
  for (const t of order) {
    const list = cmds.filter((c) => c.tab === t).sort((a, b) => (a.group || '').localeCompare(b.group || '') || a.label.localeCompare(b.label));
    if (!list.length) continue;
    lines.push(`## ${tabName(t)} (${list.length})`, '', '| Command | Group | Shortcut | ID | Notes |', '|---|---|---|---|---|');
    for (const c of list) lines.push(`| ${c.label.replace(/\|/g, '\\|')} | ${c.group || ''} | ${(c.keys || []).map(key).join(', ')} | \`${c.id}\` | ${[c.kind === 'menu' || c.kind === 'split' || c.kind === 'gallery' ? 'has options menu' : '', inTabs.has(c.id) ? '' : 'not in tabs', c.origin ? `inspired by ${c.origin}` : ''].filter(Boolean).join('; ')} |`);
    lines.push('');
  }
  lines.push(`## Planned, not yet implemented (${missing.length})`, '');
  lines.push('These ids are in the plan but have no command yet. A command is only registered when it works; nothing below is a placeholder in the app.', '');
  const byNs = new Map<string, string[]>();
  for (const id of missing) { const ns = id.split('.')[0]; if (!byNs.has(ns)) byNs.set(ns, []); byNs.get(ns)!.push(id); }
  for (const [ns, ids] of byNs) lines.push(`- **${ns}**: ${ids.map((i) => `\`${i}\``).join(', ')}`);
  lines.push('');
  return lines.join('\n');
}

