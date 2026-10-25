/** Application shell: title bar, Quick Access Bar, tabs + ribbon, document tabs, viewer, panes, status bar. */
import type { App, DocTab } from '../app';
import { getCommand, allCommands, searchCommands, type Command, type MenuEntry } from '../commands/registry';
import { h, icon, clear, isPhone } from './dom';
import { showMenu, closeMenus, openDialog, toast } from './dialog';
import { DEFAULT_TABS, tabsFor, type RibbonTab } from './ribbonLayout';
import { prettyKey, canonicalKey, keyName } from '../util/keys';
import { PANES, type PaneDef } from './panes';
import { customizeQat, customizeRibbon, customizeKeyboard } from './customize';
import { renderBackstage } from './backstage';
import { Viewer } from '../view/viewer';
import { QAT_STANDARD, QAT_EXTRAS } from '../prefs';

export class Shell {
  root: HTMLElement;
  titlebar!: HTMLElement;
  qatEl!: HTMLElement;
  qatBelow!: HTMLElement;
  qatBottom!: HTMLElement;
  tabsEl!: HTMLElement;
  ribbonEl!: HTMLElement;
  docTabsEl!: HTMLElement;
  workspace!: HTMLElement;
  paneEl!: HTMLElement;
  statusEl!: HTMLElement;
  backstageEl!: HTMLElement;
  titleBtn!: HTMLElement;
  currentTab = 'home';
  ribbonOpen = true;
  pane: { def: PaneDef; el: HTMLElement; opts: any } | null = null;
  statusMsg = '';
  private statusTimer: any;
  private lastContextual = '';

  constructor(public app: App) {
    this.root = app.host;
    this.build();
    this.applyPrefs();
    document.addEventListener('keydown', (e) => this.globalKey(e), true);
  }

  // ----------------------------------------------------------------------------------------
  // Layout

  build(): void {
    clear(this.root);
    this.root.className = 'ql-app';
    this.titlebar = h('header', { class: 'ql-titlebar' });
    const fileBtn = h('button', { class: 'ql-iconbtn ql-filebtn', title: 'File', 'aria-label': 'File menu', onclick: () => this.showBackstage() }, icon('menu'));
    this.qatEl = h('div', { class: 'ql-qat', role: 'toolbar', 'aria-label': 'Quick Access Bar' });
    this.titleBtn = h('button', { class: 'ql-title', title: 'Rename / document properties', onclick: () => this.renameDoc() }, 'Document');
    const search = h('button', { class: 'ql-iconbtn', title: 'Search commands (Alt+Q)', 'aria-label': 'Search commands', onclick: () => this.commandPalette() }, icon('search'));
    const read = h('button', { class: 'ql-btn ql-present', title: 'Read Mode (Ctrl+H)', onclick: () => this.app.exec('view.readMode') }, icon('menu_book'), h('span', { class: 'ql-present-label' }, ' Read'));
    const more = h('button', { class: 'ql-iconbtn', title: 'More', 'aria-label': 'More', onclick: (e: MouseEvent) => this.moreMenu(e.currentTarget as HTMLElement) }, icon('more_vert'));
    this.titlebar.append(fileBtn, this.qatEl, this.titleBtn, h('span', { class: 'ql-spacer' }), search, read, more);
    this.tabsEl = h('nav', { class: 'ql-tabs', role: 'tablist' });
    this.ribbonEl = h('div', { class: 'ql-ribbon', role: 'toolbar' });
    this.qatBelow = h('div', { class: 'ql-qat ql-qat-below', role: 'toolbar', 'aria-label': 'Quick Access Bar' });
    this.docTabsEl = h('div', { class: 'ql-doctabs' });
    this.workspace = h('div', { class: 'ql-workspace' });
    this.paneEl = h('aside', { class: 'ql-pane', 'aria-hidden': 'true' });
    const main = h('main', { class: 'ql-main' }, this.workspace, this.paneEl);
    this.qatBottom = h('div', { class: 'ql-qat ql-qat-bottom', role: 'toolbar', 'aria-label': 'Quick Access Bar' });
    this.statusEl = h('footer', { class: 'ql-status' });
    this.backstageEl = h('div', { class: 'ql-backstage', 'aria-hidden': 'true' });
    this.root.append(this.titlebar, this.tabsEl, this.ribbonEl, this.qatBelow, this.docTabsEl, main, this.qatBottom, this.statusEl, this.backstageEl, h('div', { class: 'ql-toasts' }));
    this.renderQat();
    this.renderTabs();
    this.renderRibbon();
  }

  rebuild(): void { this.renderQat(); this.renderTabs(); this.renderRibbon(); this.refresh(); }

  mountTab(tab: DocTab): void {
    const v = new Viewer(this.app, tab);
    tab.ui = v;
    tab.el = h('div', { class: 'qf-doc' }, v.el);
    this.workspace.appendChild(tab.el);
    v.onSelect = () => this.contextualCheck();
    requestAnimationFrame(() => v.layout());
  }

  // ----------------------------------------------------------------------------------------
  // Quick Access Bar

  renderQat(): void {
    const pos = this.app.prefs.qatPosition;
    const target = pos === 'bottom' ? this.qatBottom : pos === 'below' ? this.qatBelow : this.qatEl;
    clear(this.qatEl); clear(this.qatBottom); clear(this.qatBelow);
    for (const id of this.app.prefs.qat) {
      if (id === '|') { target.appendChild(h('span', { class: 'ql-qat-sep' })); continue; }
      const c = getCommand(id);
      if (!c) continue;
      target.appendChild(this.commandButton(c, 'qat'));
    }
    target.appendChild(h('button', { class: 'ql-iconbtn ql-qat-customize', title: 'Customize Quick Access Bar', 'aria-label': 'Customize Quick Access Bar', onclick: (e: MouseEvent) => this.qatMenu(e.currentTarget as HTMLElement) }, icon('arrow_drop_down')));
  }

  qatMenu(anchor: HTMLElement): void {
    const q = this.app.prefs.qat;
    const item = (id: string) => ({ id, label: getCommand(id)?.label || id, checked: q.includes(id), arg: '__toggle' });
    const present = (id: string) => !!getCommand(id);
    const pos = this.app.prefs.qatPosition;
    showMenu([
      { heading: 'Customize Quick Access Bar' },
      ...QAT_STANDARD.filter(present).map(item),
      { separator: true },
      ...QAT_EXTRAS.filter(present).map(item),
      { separator: true },
      { id: '__addAll', label: 'Add All Choices (Save, Print, then A–Z)', icon: 'sort_by_alpha' },
      { id: '__more', label: 'More Commands…', icon: 'library_add' },
      ...(pos !== 'top' ? [{ id: '__pos', arg: 'top', label: 'Show Above the Ribbon', icon: 'vertical_align_top' }] : []),
      ...(pos !== 'below' ? [{ id: '__pos', arg: 'below', label: 'Show Below the Ribbon', icon: 'vertical_align_center' }] : []),
      ...(pos !== 'bottom' ? [{ id: '__pos', arg: 'bottom', label: 'Show at the Bottom (near keyboard)', icon: 'vertical_align_bottom' }] : []),
      { id: '__labels', label: this.app.prefs.qatLabels ? 'Hide Command Labels' : 'Show Command Labels', icon: 'label' },
      { id: '__hide', label: 'Hide Quick Access Bar', icon: 'visibility_off' },
      { id: '__ribbon', label: this.app.prefs.ribbon === 'full' ? 'Collapse the Ribbon' : 'Show the Ribbon', icon: 'expand_less' },
    ], {
      anchor, onPick: (e) => {
        const p = this.app.prefs;
        if (e.arg === '__toggle' && e.id) { p.qat = q.includes(e.id) ? q.filter((x) => x !== e.id) : [...q, e.id]; }
        else if (e.id === '__addAll') { this.app.exec('view.qatAddAll'); return; }
        else if (e.id === '__more') { this.customizeQat(); return; }
        else if (e.id === '__pos') { this.app.exec('view.qatPosition', e.arg); return; }
        else if (e.id === '__labels') p.qatLabels = !p.qatLabels;
        else if (e.id === '__hide') { p.qatHidden = true; toast('Quick Access Bar hidden. Show it again from View ▸ Show Quick Access Bar or by long-pressing any ribbon command.', { ms: 5000 }); }
        else if (e.id === '__ribbon') p.ribbon = p.ribbon === 'full' ? 'tabs' : 'full';
        this.app.savePrefs();
        this.applyPrefs();
        this.renderQat();
        this.refresh();
      },
    });
  }

  // ----------------------------------------------------------------------------------------
  // Tabs and ribbon

  renderTabs(): void {
    clear(this.tabsEl);
    this.tabsEl.appendChild(h('button', { class: 'ql-tab ql-tab-file', role: 'tab', onclick: () => this.showBackstage() }, 'File'));
    for (const t of tabsFor(this.app)) {
      const b = h('button', { class: 'ql-tab' + (t.contextual ? ' ql-contextual' : '') + (t.id === this.currentTab ? ' ql-active' : ''), role: 'tab', 'data-tab': t.id, style: t.accent ? `--tab-accent:${t.accent}` : '' }, t.label);
      b.addEventListener('click', () => {
        if (this.currentTab === t.id && this.app.prefs.ribbon !== 'hidden') { this.ribbonOpen = !this.ribbonOpen; this.root.classList.toggle('ql-ribbon-closed', !this.ribbonOpen); return; }
        this.currentTab = t.id; this.ribbonOpen = true; this.root.classList.remove('ql-ribbon-closed');
        this.renderTabs(); this.renderRibbon(); this.refresh();
        b.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      });
      b.addEventListener('dblclick', () => { this.app.exec('view.collapseRibbon'); });
      this.tabsEl.appendChild(b);
    }
  }

  ribbonTab(): RibbonTab { return tabsFor(this.app).find((t) => t.id === this.currentTab) || DEFAULT_TABS[0]; }

  renderRibbon(): void {
    clear(this.ribbonEl);
    const tab = this.ribbonTab();
    for (const g of tab.groups) {
      const items = h('div', { class: 'ql-group-items' });
      for (const id of g.items) {
        const c = getCommand(id);
        if (!c) continue;
        items.appendChild(this.ribbonItem(c));
      }
      if (!items.children.length) continue;
      const label = h('div', { class: 'ql-group-label' }, g.label, g.launcher ? h('button', { class: 'ql-launcher', title: `${g.label} settings`, 'aria-label': `${g.label} settings`, onclick: () => this.app.exec(g.launcher!) }, icon('open_in_new')) : null);
      this.ribbonEl.appendChild(h('section', { class: 'ql-group', 'data-group': g.id }, items, label));
    }
    this.ribbonEl.scrollLeft = 0;
  }

  ribbonItem(c: Command): HTMLElement {
    switch (c.kind) {
      case 'size': return this.sizeBox(c);
      case 'gallery': return this.gallery(c);
      case 'combo': return this.comboBox(c);
      default: return this.commandButton(c, 'ribbon');
    }
  }

  commandButton(c: Command, where: 'ribbon' | 'qat' | 'mini'): HTMLElement {
    const showLabel = where === 'ribbon' || (where === 'qat' && this.app.prefs.qatLabels);
    const key = c.keys?.[0] ? ` (${prettyKey(c.keys[0])})` : '';
    const main = h('button', { class: 'ql-cmd', 'data-cmd': c.id, title: (c.tip ? `${c.label}: ${c.tip}` : c.label) + key, 'aria-label': c.label, type: 'button' }, icon(c.icon), showLabel ? h('span', { class: 'ql-cmd-label' }, c.label.replace(/…$/, '')) : null);
    if (c.kind === 'color') main.appendChild(h('span', { class: 'ql-colorbar' }));
    let longPress: any;
    main.addEventListener('pointerdown', () => { longPress = setTimeout(() => { longPress = 'fired'; this.longPress(c, main); }, 550); });
    main.addEventListener('pointerup', () => { if (longPress !== 'fired') clearTimeout(longPress); });
    main.addEventListener('pointerleave', () => { if (longPress !== 'fired') clearTimeout(longPress); });
    main.addEventListener('contextmenu', (e) => { e.preventDefault(); this.longPress(c, main); });
    main.addEventListener('click', () => {
      if (longPress === 'fired') { longPress = null; return; }
      if (c.kind === 'menu') { this.openCommandMenu(c, main); return; }
      this.app.exec(c.id);
      if (where !== 'qat' && !['menu', 'split', 'color'].includes(c.kind || '')) setTimeout(() => this.app.focus(), 0);
    });
    main.addEventListener('mousedown', (e) => e.preventDefault());
    if (c.kind === 'menu') main.appendChild(icon('arrow_drop_down', 'ql-caret'));
    if (c.kind === 'split' || c.kind === 'color') {
      const arrow = h('button', { class: 'ql-split-arrow', type: 'button', title: `${c.label} options`, 'aria-label': `${c.label} options` }, icon('arrow_drop_down'));
      arrow.addEventListener('mousedown', (e) => e.preventDefault());
      arrow.addEventListener('click', () => (c.kind === 'color' ? this.app.exec(c.id, 'menu') : this.openCommandMenu(c, wrap)));
      const wrap = h('span', { class: 'ql-split', 'data-cmd-wrap': c.id }, main, arrow);
      return wrap;
    }
    return main;
  }

  longPress(c: Command, el: HTMLElement): void {
    const inQat = this.app.prefs.qat.includes(c.id);
    showMenu([
      { id: '__qat', label: inQat ? 'Remove from Quick Access Bar' : 'Add to Quick Access Bar', icon: inQat ? 'remove_circle' : 'add_circle' },
      { id: '__customizeQat', label: 'Customize Quick Access Bar…', icon: 'tune' },
      ...(this.app.prefs.qatHidden ? [{ id: '__showQat', label: 'Show Quick Access Bar', icon: 'bolt' }] : []),
      { id: '__key', label: 'Assign Shortcut…', icon: 'keyboard' },
      { id: '__ribbon', label: this.app.prefs.ribbon === 'full' ? 'Collapse the Ribbon' : 'Show the Ribbon', icon: 'expand_less' },
      { id: '__info', label: `About: ${c.label}`, icon: 'info' },
    ], {
      anchor: el, onPick: (e) => {
        if (e.id === '__qat') { this.app.prefs.qat = inQat ? this.app.prefs.qat.filter((x) => x !== c.id) : [...this.app.prefs.qat, c.id]; this.app.savePrefs(); this.renderQat(); this.refresh(); toast(inQat ? 'Removed from Quick Access Bar' : 'Added to Quick Access Bar'); }
        if (e.id === '__customizeQat') this.customizeQat();
        if (e.id === '__showQat') this.app.exec('view.qatShow');
        if (e.id === '__key') this.customizeKeyboard(c.id);
        if (e.id === '__ribbon') this.app.exec('view.collapseRibbon');
        if (e.id === '__info') toast(`${c.label} — ${c.tab}${c.group ? ' ▸ ' + c.group : ''}${c.keys?.length ? ' — ' + c.keys.map(prettyKey).join(', ') : ''}${c.origin ? ' — inspired by ' + c.origin : ''}`, { ms: 5000 });
      },
    });
  }

  openCommandMenu(c: Command, anchor: HTMLElement): void {
    const entries = c.menu ? c.menu(this.app) : [];
    showMenu(entries, { anchor, onPick: (e) => this.pickEntry(c, e) });
  }

  pickEntry(c: Command, e: MenuEntry): void {
    if (!e.id) return;
    if (e.id === c.id) this.app.exec(c.id, e.arg);
    else this.app.exec(e.id, e.arg);
    setTimeout(() => this.app.focus(), 0);
  }

  sizeBox(c: Command): HTMLElement {
    const wrap = h('span', { class: 'ql-sizebox', 'data-cmd-wrap': c.id });
    const input = h('input', { class: 'ql-size-input', 'data-combo': c.id, inputmode: 'decimal', 'aria-label': c.label, title: c.label }) as HTMLInputElement;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); const val = parseFloat(input.value); if (!isNaN(val)) this.app.exec(c.id, val); this.app.focus(); }
      if (e.key === 'Escape') this.app.focus();
    });
    const arrow = h('button', { class: 'ql-split-arrow', type: 'button', 'aria-label': `${c.label} list` }, icon('arrow_drop_down'));
    arrow.addEventListener('mousedown', (e) => e.preventDefault());
    arrow.addEventListener('click', () => { if (c.menu) this.openCommandMenu(c, wrap); else this.app.exec(c.id); });
    wrap.append(input, arrow);
    return wrap;
  }

  comboBox(c: Command): HTMLElement {
    const b = h('button', { class: 'ql-combo ql-wide-combo', 'data-cmd': c.id, 'data-combo': c.id, title: c.label, type: 'button' }, h('span', { class: 'ql-combo-text' }, c.label), icon('arrow_drop_down'));
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => this.openCommandMenu(c, b));
    return b;
  }

  gallery(c: Command): HTMLElement {
    const wrap = h('div', { class: 'ql-gallery', 'data-gallery': c.id });
    const strip = h('div', { class: 'ql-gallery-strip' });
    const more = h('button', { class: 'ql-gallery-more', title: 'More', 'aria-label': `More ${c.label}` }, icon('expand_more'));
    more.addEventListener('mousedown', (e) => e.preventDefault());
    more.addEventListener('click', () => this.openCommandMenu(c, wrap));
    wrap.append(strip, more);
    return wrap;
  }

  fillGalleries(): void {
    this.ribbonEl.querySelectorAll<HTMLElement>('[data-gallery]').forEach((wrap) => {
      const id = wrap.dataset.gallery!;
      const c = getCommand(id);
      if (!c?.menu) return;
      const strip = wrap.querySelector('.ql-gallery-strip')!;
      const entries = c.menu(this.app).filter((e) => !e.heading && !e.separator).slice(0, 14);
      const sig = JSON.stringify(entries.map((e) => [e.label, e.checked, e.preview, e.swatch]));
      if (strip.getAttribute('data-sig') === sig) return;
      strip.setAttribute('data-sig', sig);
      clear(strip as HTMLElement);
      for (const e of entries) {
        const chip = h('button', { class: 'ql-gallery-item' + (e.checked ? ' ql-on' : ''), title: e.label || '', type: 'button' }, e.icon ? icon(e.icon) : null, h('span', { style: e.preview || '' }, e.label || ''));
        chip.addEventListener('mousedown', (ev) => ev.preventDefault());
        chip.addEventListener('click', () => { this.app.exec(e.id || id, e.arg); this.app.focus(); });
        strip.appendChild(chip);
      }
    });
  }

  // ----------------------------------------------------------------------------------------
  // Refresh (state → UI)

  private contextualCheck(): void {
    const sig = DEFAULT_TABS.filter((t) => t.contextual).map((t) => { try { return t.contextual!(this.app) ? 1 : 0; } catch { return 0; } }).join('');
    if (sig !== this.lastContextual) { this.lastContextual = sig; this.refresh(); }
  }

  refresh(): void {
    const app = this.app;
    if (!app.active) return;
    for (const t of DEFAULT_TABS.filter((x) => x.contextual)) {
      const el = this.tabsEl.querySelector<HTMLElement>(`[data-tab="${t.id}"]`);
      let show = false;
      try { show = t.contextual!(app); } catch { /* */ }
      if (el) el.style.display = show ? '' : 'none';
      if (!show && this.currentTab === t.id) { this.currentTab = 'home'; this.renderTabs(); this.renderRibbon(); }
    }
    for (const b of this.root.querySelectorAll<HTMLElement>('[data-cmd]')) {
      const c = getCommand(b.dataset.cmd!);
      if (!c) continue;
      let active = false, enabled = true;
      try { active = !!c.isActive?.(app); enabled = c.isEnabled ? c.isEnabled(app) : true; } catch { /* */ }
      b.classList.toggle('ql-on', active);
      b.setAttribute('aria-pressed', String(active));
      b.classList.toggle('ql-disabled', !enabled);
    }
    this.root.querySelectorAll<HTMLInputElement>('input[data-combo]').forEach((inp) => {
      if (document.activeElement === inp) return;
      const c = getCommand(inp.dataset.combo!);
      const v = c?.value?.(app);
      inp.value = v != null ? String(v) : '';
    });
    this.root.querySelectorAll<HTMLElement>('button[data-combo]').forEach((b) => {
      const c = getCommand(b.dataset.combo!);
      const v = c?.value?.(app);
      const t = b.querySelector('.ql-combo-text');
      if (t && v != null) t.textContent = String(v);
    });
    this.fillGalleries();
    this.renderStatus();
    if (this.pane?.def.update) this.pane.def.update(app, this.pane.el, this.pane.opts);
    this.titleBtn.textContent = app.tab.displayName + (app.tab.dirty ? ' •' : '');
  }

  // ----------------------------------------------------------------------------------------
  // Status bar

  renderStatus(): void {
    const app = this.app;
    const tab = app.tab;
    clear(this.statusEl);
    const item = (text: string, onclick?: () => void, title?: string, cls = '') => h('button', { class: 'ql-status-item ' + cls, onclick, title: title || text, type: 'button' }, text);
    const n = tab.doc.pageCount;
    const labels = (tab.ui as Viewer).pageLabels?.() || [];
    const cur = app.page;
    this.statusEl.appendChild(item(n ? `Page ${labels[cur] ? `${labels[cur]} (${cur + 1})` : cur + 1} of ${n}` : 'No pages', () => app.exec('nav.goTo'), 'Go to page…'));
    const tool = (tab.ui as Viewer).tool;
    if (tool && tool !== 'select') this.statusEl.appendChild(item(`Tool: ${tool.replace(/^field-/, 'field ')}`, () => app.exec('home.select'), 'Back to the Select tool', 'ql-status-mode'));
    if (app.recording) this.statusEl.appendChild(item(app.recordingPaused ? '⏸ Paused' : '● REC', () => app.exec('dev.stopRecording'), 'Stop recording macro', 'ql-status-rec'));
    if (tab.doc.security) this.statusEl.appendChild(item('🔒', () => app.exec('protect.securityInfo'), 'Encrypted: security settings'));
    if (tab.repair) this.statusEl.appendChild(item('Recovered', () => app.exec('file.recoveryReport'), 'This document was repaired; see the report'));
    if (tab.readOnly) this.statusEl.appendChild(h('span', { class: 'ql-status-msg' }, 'Read-only'));
    if (this.statusMsg) this.statusEl.appendChild(h('span', { class: 'ql-status-msg' }, this.statusMsg));
    this.statusEl.appendChild(h('span', { class: 'ql-spacer' }));
    const views: [string, string, string, string][] = [['continuous', 'view.continuous', 'view_agenda', 'Continuous'], ['single', 'view.single', 'crop_portrait', 'Single Page'], ['facing', 'view.facing', 'auto_stories', 'Facing Pages']];
    for (const [m, id, ic, l] of views) this.statusEl.appendChild(h('button', { class: 'ql-iconbtn ql-status-view' + (tab.view === m ? ' ql-on' : ''), title: l, 'aria-label': l, onclick: () => app.exec(id) }, icon(ic)));
    this.statusEl.appendChild(h('button', { class: 'ql-iconbtn ql-status-view' + (app.prefs.nightMode ? ' ql-on' : ''), title: 'Night Mode', 'aria-label': 'Night Mode', onclick: () => app.exec('view.nightMode') }, icon('dark_mode')));
    const z = tab.ui?.zoom || 1;
    const slider = h('input', { type: 'range', class: 'ql-zoom-slider', min: '10', max: '400', step: '5', value: String(Math.round(z * 100)), 'aria-label': 'Zoom' }) as HTMLInputElement;
    slider.addEventListener('input', () => tab.ui.setZoom(+slider.value / 100));
    this.statusEl.append(h('button', { class: 'ql-iconbtn', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => app.exec('view.zoomOut') }, icon('remove')), slider,
      h('button', { class: 'ql-iconbtn', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => app.exec('view.zoomIn') }, icon('add')),
      h('button', { class: 'ql-status-item ql-zoom', title: 'Zoom…', onclick: () => app.exec('view.zoom') }, `${Math.round(z * 100)}%`),
      h('button', { class: 'ql-iconbtn', title: 'Fit Width', 'aria-label': 'Fit width', onclick: () => app.exec('view.fitWidth') }, icon('fit_width')),
      h('button', { class: 'ql-iconbtn', title: 'Fit Page', 'aria-label': 'Fit page', onclick: () => app.exec('view.fitPage') }, icon('fit_screen')));
  }

  status(msg: string): void {
    this.statusMsg = msg;
    clearTimeout(this.statusTimer);
    if (msg && !msg.startsWith('●')) this.statusTimer = setTimeout(() => { this.statusMsg = ''; this.renderStatus(); }, 3000);
    this.renderStatus();
  }

  // ----------------------------------------------------------------------------------------
  // Document tabs strip and title

  tabsChanged(): void {
    const app = this.app;
    clear(this.docTabsEl);
    this.root.classList.toggle('ql-multi-doc', app.docs.length > 1);
    for (const d of app.docs) {
      const t = h('div', { class: 'ql-doctab' + (d === app.active ? ' ql-active' : ''), role: 'tab' },
        h('button', { class: 'ql-doctab-name', onclick: () => app.activate(d) }, d.displayName + (d.dirty ? ' •' : '')),
        h('button', { class: 'ql-doctab-close', 'aria-label': `Close ${d.displayName}`, onclick: () => { app.activate(d); app.exec('file.close', d.id); } }, icon('close')));
      this.docTabsEl.appendChild(t);
    }
    this.docTabsEl.appendChild(h('button', { class: 'ql-iconbtn', title: 'Open a document', 'aria-label': 'Open a document', onclick: () => app.exec('file.open') }, icon('add')));
    if (app.active) this.titleBtn.textContent = app.active.displayName + (app.active.dirty ? ' •' : '');
  }

  async renameDoc(): Promise<void> {
    const tab = this.app.tab;
    const r = await openDialog({ title: 'Document', fields: [{ key: 'name', label: 'File name', type: 'text', value: tab.fileName || tab.title }, { key: 'title', label: 'Title property', type: 'text', value: tab.doc.title }] });
    if (!r) return;
    tab.fileName = r.name; tab.title = r.name.replace(/\.[^.]+$/, '');
    if (r.title !== tab.doc.title) this.app.edit('Title', (doc) => { const { PdfString } = requireObjects(); doc.ensureInfo().set('Title', PdfString.fromText(r.title)); });
    this.tabsChanged();
  }

  moreMenu(anchor: HTMLElement): void {
    const app = this.app;
    showMenu([
      { id: 'file.save', label: 'Save', icon: 'save' }, { id: 'file.share', label: 'Share', icon: 'share' }, { id: 'file.print', label: 'Print', icon: 'print' },
      { separator: true },
      { id: 'view.readMode', label: 'Read Mode', icon: 'menu_book' }, { id: 'view.organize', label: 'Organize Pages', icon: 'grid_view' }, { id: 'view.comments', label: 'Comments', icon: 'forum' }, { id: 'edit.find', label: 'Find', icon: 'search' },
      { separator: true },
      { id: 'file.customizeQat', label: 'Customize Quick Access Bar…', icon: 'tune' }, { id: 'file.customizeRibbon', label: 'Customize Tabs…', icon: 'view_quilt' },
      { id: 'file.customizeKeyboard', label: 'Customize Keyboard…', icon: 'keyboard' }, { id: 'file.options', label: 'Options…', icon: 'settings' },
      { id: 'help.about', label: 'About', icon: 'info' },
    ], { anchor, onPick: (e) => e.id && app.exec(e.id, e.arg) });
  }

  // ----------------------------------------------------------------------------------------
  // Panes

  openPane(id: string, opts: any = {}): void {
    const def = PANES[id];
    if (!def) { toast(`Unknown pane ${id}`); return; }
    if (this.pane?.def.id === id) { this.pane.opts = opts; def.update?.(this.app, this.pane.el, opts); def.onOpen?.(this.app, this.pane.el, opts); return; }
    this.closePane();
    const body = h('div', { class: 'ql-pane-body' });
    const head = h('div', { class: 'ql-pane-head' }, h('h2', null, def.title), h('button', { class: 'ql-iconbtn', 'aria-label': 'Close pane', onclick: () => this.closePane() }, icon('close')));
    clear(this.paneEl);
    this.paneEl.append(head, body);
    this.paneEl.setAttribute('aria-hidden', 'false');
    this.root.classList.add('ql-pane-open');
    this.pane = { def, el: body, opts };
    def.render(this.app, body, opts);
    def.onOpen?.(this.app, body, opts);
    this.refresh();
    requestAnimationFrame(() => this.app.tab.ui.layout());
  }

  closePane(): void {
    if (!this.pane) return;
    this.pane.def.onClose?.(this.app);
    this.pane = null;
    clear(this.paneEl);
    this.paneEl.setAttribute('aria-hidden', 'true');
    this.root.classList.remove('ql-pane-open');
    this.app.refresh();
    requestAnimationFrame(() => this.app.tab?.ui.layout());
  }

  togglePane(id: string, opts?: any): void { if (this.pane?.def.id === id) this.closePane(); else this.openPane(id, opts); }
  paneOpen(id: string): boolean { return this.pane?.def.id === id; }

  // ----------------------------------------------------------------------------------------
  // Backstage

  showBackstage(page = 'home'): void {
    closeMenus();
    this.backstageEl.setAttribute('aria-hidden', 'false');
    this.root.classList.add('ql-backstage-open');
    renderBackstage(this.app, this.backstageEl, page);
  }
  hideBackstage(): void {
    this.backstageEl.setAttribute('aria-hidden', 'true');
    this.root.classList.remove('ql-backstage-open');
    clear(this.backstageEl);
  }

  customizeQat(): void { customizeQat(this.app); }
  customizeRibbon(): void { customizeRibbon(this.app); }
  customizeKeyboard(id?: string): void { customizeKeyboard(this.app, id); }

  // ----------------------------------------------------------------------------------------
  // Command palette

  commandPalette(): void {
    const app = this.app;
    const overlay = h('div', { class: 'ql-overlay ql-palette-overlay' });
    const input = h('input', { class: 'ql-palette-input', placeholder: `Search ${allCommands().length} commands… (e.g. "redact", "rotate", "fill")`, 'aria-label': 'Search commands' }) as HTMLInputElement;
    const list = h('div', { class: 'ql-palette-list', role: 'listbox' });
    const box = h('div', { class: 'ql-palette', role: 'dialog' }, input, list);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    let results: Command[] = [];
    let sel = 0;
    const close = () => { overlay.remove(); app.focus(); };
    const run = (c: Command) => { close(); if (c.kind === 'menu' && c.menu) this.openCommandMenu(c, this.anchorFor(c.id)); else app.exec(c.id); };
    const draw = () => {
      clear(list);
      const q = input.value.trim();
      results = q ? searchCommands(q, 80) : [...app.prefs.pinnedCommands.map((id) => getCommand(id)!).filter(Boolean), ...allCommands().filter((c) => c.popular).slice(0, 40)];
      results.forEach((c, i) => {
        const pinned = app.prefs.qat.includes(c.id);
        const row = h('div', { class: 'ql-palette-row' + (i === sel ? ' ql-sel' : ''), role: 'option' },
          icon(c.icon), h('span', { class: 'ql-palette-label' }, c.label), h('span', { class: 'ql-palette-tab' }, `${c.tab === 'Backstage' ? 'File' : c.tab}${c.group ? ' ▸ ' + c.group : ''}`),
          c.keys?.[0] ? h('kbd', null, prettyKey(c.keys[0])) : null,
          h('button', { class: 'ql-iconbtn ql-palette-pin', title: pinned ? 'Remove from Quick Access Bar' : 'Add to Quick Access Bar', onclick: (e: Event) => { e.stopPropagation(); app.prefs.qat = pinned ? app.prefs.qat.filter((x) => x !== c.id) : [...app.prefs.qat, c.id]; app.savePrefs(); this.renderQat(); draw(); } }, icon(pinned ? 'push_pin' : 'keep')));
        row.addEventListener('click', () => run(c));
        list.appendChild(row);
      });
      if (!results.length) list.appendChild(h('div', { class: 'ql-help' }, 'No matching commands.'));
    };
    input.addEventListener('input', () => { sel = 0; draw(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { sel = Math.min(results.length - 1, sel + 1); draw(); list.children[sel]?.scrollIntoView({ block: 'nearest' }); e.preventDefault(); }
      if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); list.children[sel]?.scrollIntoView({ block: 'nearest' }); e.preventDefault(); }
      if (e.key === 'Enter' && results[sel]) { e.preventDefault(); run(results[sel]); }
      if (e.key === 'Escape') close();
    });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    draw();
    setTimeout(() => input.focus(), 20);
  }

  // ----------------------------------------------------------------------------------------
  // Context menus

  pageContextMenu(x: number, y: number, page: number, hasAnnot: boolean, hasSelection: boolean): void {
    const app = this.app;
    const entries: MenuEntry[] = [];
    if (hasSelection) entries.push({ id: 'edit.copy', label: 'Copy', icon: 'content_copy' }, { id: 'comment.highlight', label: 'Highlight', icon: 'ink_highlighter' }, { id: 'comment.underline', label: 'Underline', icon: 'format_underlined' }, { id: 'comment.strikeout', label: 'Strikethrough', icon: 'strikethrough_s' }, { id: 'protect.redactText', label: 'Mark for Redaction', icon: 'block' }, { id: 'review.lookUp', label: 'Look Up', icon: 'travel_explore' }, { separator: true });
    if (hasAnnot) entries.push({ id: 'comment.properties', label: 'Properties…', icon: 'tune' }, { id: 'comment.reply', label: 'Reply…', icon: 'reply' }, { id: 'comment.setStatus', label: 'Set Status', icon: 'task_alt' }, { id: 'comment.delete', label: 'Delete', icon: 'delete' }, { separator: true });
    entries.push(
      { id: 'home.select', label: 'Select Tool', icon: 'text_select_start' }, { id: 'home.hand', label: 'Hand Tool', icon: 'pan_tool' },
      { id: 'comment.note', label: 'Add Note Here', icon: 'add_comment' }, { id: 'comment.freetext', label: 'Add Text Box', icon: 'text_fields' },
      { separator: true },
      { id: 'organize.rotateRight', label: 'Rotate Page Right', icon: 'rotate_right' }, { id: 'organize.rotateLeft', label: 'Rotate Page Left', icon: 'rotate_left' },
      { id: 'organize.insertBlank', label: 'Insert Blank Page After', icon: 'note_add' }, { id: 'organize.delete', label: 'Delete Page', icon: 'delete_sweep' },
      { separator: true },
      { id: 'home.snapshot', label: 'Snapshot…', icon: 'photo_camera' }, { id: 'tools.pageInfo', label: 'Page Info', icon: 'info' }, { id: 'file.properties', label: 'Document Properties…', icon: 'description' });
    (app.viewer as Viewer).selectPage(page);
    showMenu(entries, { x, y, onPick: (en) => { if (en.id) app.exec(en.id, en.arg); } });
  }

  thumbContextMenu(x: number, y: number): void {
    const app = this.app;
    showMenu([
      { id: 'organize.insertBlank', label: 'Insert Blank Page', icon: 'note_add' }, { id: 'organize.insertFromFile', label: 'Insert from File…', icon: 'file_open' },
      { id: 'organize.duplicate', label: 'Duplicate', icon: 'library_add' }, { id: 'organize.delete', label: 'Delete', icon: 'delete' }, { id: 'organize.extract', label: 'Extract…', icon: 'output' },
      { separator: true },
      { id: 'organize.rotateLeft', label: 'Rotate Left', icon: 'rotate_left' }, { id: 'organize.rotateRight', label: 'Rotate Right', icon: 'rotate_right' }, { id: 'organize.crop', label: 'Crop…', icon: 'crop' },
      { separator: true },
      { id: 'organize.move', label: 'Move to…', icon: 'low_priority' }, { id: 'organize.selectAll', label: 'Select All Pages', icon: 'select_all' }, { id: 'organize.pageLabels', label: 'Page Labels…', icon: 'label' },
    ], { x, y, onPick: (e) => e.id && app.exec(e.id, e.arg) });
  }

  // ----------------------------------------------------------------------------------------

  anchorFor(id: string): HTMLElement {
    const els = [...this.root.querySelectorAll<HTMLElement>(`[data-cmd-wrap="${id}"], [data-cmd="${id}"]`)].filter((e) => e.offsetParent);
    return els[0] || this.ribbonEl;
  }

  applyPrefs(): void {
    const p = this.app.prefs;
    const dark = p.theme === 'dark' || (p.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    this.root.classList.toggle('ql-ribbon-collapsed', p.ribbon !== 'full');
    this.root.classList.toggle('ql-qat-at-bottom', p.qatPosition === 'bottom');
    this.root.classList.toggle('ql-qat-below-ribbon', p.qatPosition === 'below');
    this.root.classList.toggle('ql-qat-hidden', p.qatHidden);
    this.root.classList.toggle('ql-touch', p.touchMode);
    this.root.classList.toggle('ql-high-contrast', p.highContrastUI);
    this.root.style.setProperty('--ql-ui-scale', String(p.uiScale || 1));
    if (!this.app.docs.length) return;
    this.renderQat();
    for (const d of this.app.docs) d.ui.layout();
    this.refresh();
  }

  globalKey(e: KeyboardEvent): void {
    const k = keyName(e);
    if (!k) return;
    if (e.key === 'Escape') {
      if (document.querySelector('.ql-menu')) { closeMenus(); return; }
      if (this.root.classList.contains('ql-backstage-open')) { this.hideBackstage(); return; }
    }
    if (document.querySelector('.ql-overlay')) return;
    const t = e.target as HTMLElement;
    const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    const id = this.app.keyIndex.get(canonicalKey(k));
    if (!id) return;
    if (inField) { if (!/^(file\.|view\.cmdSearch|edit\.find)/.test(id) || !(e.ctrlKey || e.metaKey || /^F\d+$/.test(e.key))) return; }
    e.preventDefault();
    this.app.exec(id);
  }

  async showShortcuts(): Promise<void> {
    const rows = allCommands().filter((c) => (c.keys && c.keys.length) || Object.values(this.app.prefs.keymap).includes(c.id));
    const custom = Object.entries(this.app.prefs.keymap);
    const nav: [string, string][] = [['Space / Shift+Space', 'Next / previous page'], ['PgDn / PgUp', 'Next / previous page (single page modes)'], ['Ctrl+Home / Ctrl+End', 'First / last page'], ['Esc', 'Back to the Select tool; deselect'], ['Delete', 'Delete the selected annotation or pages'], ['Ctrl+wheel, pinch', 'Zoom'], ['Enter / double-click', 'Finish a polygon']];
    const table = h('table', { class: 'ql-stats ql-shortcuts' },
      ...nav.map(([a, b]) => h('tr', null, h('td', null, b), h('td', null, a), h('td', { class: 'ql-help' }, 'Viewing'))),
      ...rows.sort((a, b) => a.tab.localeCompare(b.tab) || a.label.localeCompare(b.label)).map((c) => {
        const keys = [...(c.keys || []), ...custom.filter(([, id]) => id === c.id).map(([k2]) => k2)];
        return h('tr', null, h('td', null, c.label), h('td', null, keys.map(prettyKey).join(', ')), h('td', { class: 'ql-help' }, c.tab === 'Backstage' ? 'File' : c.tab));
      }));
    await openDialog({ title: 'Keyboard Shortcuts', wide: true, content: table, cancel: false });
  }

  async showCommandReference(): Promise<void> {
    const byTab = new Map<string, Command[]>();
    for (const c of allCommands()) { const t = c.tab === 'Backstage' ? 'File' : c.tab; if (!byTab.has(t)) byTab.set(t, []); byTab.get(t)!.push(c); }
    const div = h('div', { class: 'ql-cmdref' });
    div.appendChild(h('p', { class: 'ql-help' }, `${allCommands().length} commands. Every command can be added to the Quick Access Bar, a custom tab, a keyboard shortcut, or a macro.`));
    for (const [t, cs] of byTab) {
      div.appendChild(h('h3', null, `${t} (${cs.length})`));
      div.appendChild(h('ul', null, ...cs.sort((a, b) => a.label.localeCompare(b.label)).map((c) => h('li', null, h('b', null, c.label), c.keys?.length ? ` — ${c.keys.map(prettyKey).join(', ')}` : '', c.origin ? h('span', { class: 'ql-help' }, ` (from ${c.origin})`) : ''))));
    }
    await openDialog({ title: 'Command Reference', wide: true, content: div, cancel: false });
  }

  async tour(): Promise<void> {
    const steps = [
      ['Everything is a command', 'Every feature of Anne\'s Folio is a command you can find with the search button (or Alt+Q), place on the Quick Access Bar, put on your own tab, assign a key, or record in a macro.'],
      ['Quick Access Bar', 'Tap ▾ at the end of the Quick Access Bar to add common commands, or choose More Commands… to pick from the full library. Long-press or right-click any ribbon button to add it. You can move the bar below the ribbon or to the bottom, near the keyboard.'],
      ['Reading and marking up', 'Select text and use the Selected Text tab (or right-click) to highlight, underline, redact or look it up. The Comment tab has notes, text boxes, drawings, stamps and measurements. Double-click an annotation for its properties.'],
      ['Pages and forms', 'Organize Pages shows every page as a thumbnail you can drag, rotate, delete, extract or merge. The Forms tab fills existing fields and adds new ones; Fill & Sign puts your signature on any page.'],
      ['Files', 'Open any PDF, even a damaged one: Anne\'s Folio rebuilds what it can and shows a repair report. Images, text and Markdown files become PDFs. Save appends your changes so the original bytes stay intact; File ▸ Save As ▸ Rewrite makes a clean, smaller file.'],
    ];
    for (let i = 0; i < steps.length; i++) {
      const r = await openDialog({ title: `${steps[i][0]} (${i + 1}/${steps.length})`, content: h('p', { class: 'ql-msg' }, steps[i][1]), ok: i === steps.length - 1 ? 'Start' : 'Next', cancel: 'Skip tour' });
      if (!r) break;
    }
    this.app.prefs.firstRun = false;
    this.app.savePrefs();
  }
}

import * as objectsMod from '../pdf/objects';
function requireObjects() { return objectsMod; }
export const phone = isPhone;
