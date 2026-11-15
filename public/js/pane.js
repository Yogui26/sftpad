// Un panneau de fichiers (local ou distant) : navigation, sélection, gestes tactiles, glisser-déposer.
import { h, icon, size, date, perms, octal, ftype, typeIcon, previewable, pjoin, pdir, pbase, store, vibrate, isTouch } from './util.js';
import { get, post, qs } from './api.js';
import { t, tn, LOCALE } from './i18n.js';
import { toast, errToast, confirm, prompt, menu, sheet, viewer, downloadUrl } from './ui.js';

const LONG_PRESS = 450;
const SWIPE_TRIGGER = 96;

export class Pane {
  constructor(side, root, app) {
    this.side = side;
    this.root = root;
    this.app = app;
    this.path = null;
    this.entries = [];
    this.sel = new Set();
    this.anchor = null;
    this.selecting = false;
    this.filter = '';
    this.loadingCount = 0;
    this.error = null;
    this.scrollMemo = new Map();
    const prefs = store.get(`pane.${side}`, {});
    this.sort = prefs.sort || { key: 'name', dir: 1 };
    this.showHidden = !!prefs.showHidden;
    this.build();
  }

  get isLocal() { return this.side === 'local'; }
  get siteId() { return this.app.siteId; }
  get ready() { return this.isLocal || (this.app.site && this.app.connected); }
  get other() { return this.app.pane(this.isLocal ? 'remote' : 'local'); }
  savePrefs() { store.set(`pane.${this.side}`, { sort: this.sort, showHidden: this.showHidden }); }

  // ---------- API ----------
  base() { return this.isLocal ? 'local' : `remote/${this.siteId}`; }
  listApi(p) { return get(`${this.base()}/list?${qs({ path: p || '' })}`); }
  fileUrl(p, inline) { return `api/${this.base()}/download?${qs({ path: p, ...(inline ? { inline: '1' } : {}) })}`; }

  // ---------- Construction du DOM ----------
  build() {
    const title = this.isLocal ? t('Local') : t('Distant');
    this.labelEl = h('span.label', icon(this.isLocal ? 'disk' : 'server', 'sm'), h('span', title));
    this.btnSearch = h('button.icon-btn', { title: t('Filtrer'), 'aria-label': t('Filtrer'), onclick: () => this.toggleFilter() }, icon('search'));
    this.btnNew = h('button.icon-btn', { title: t('Nouveau dossier'), 'aria-label': t('Nouveau dossier'), onclick: () => this.mkdir() }, icon('newfolder'));
    this.btnUpload = h('button.icon-btn', { title: t("Envoyer depuis l'appareil"), 'aria-label': t("Envoyer depuis l'appareil"), onclick: () => this.app.pickDeviceFiles(this) }, icon('upload'));
    this.btnRefresh = h('button.icon-btn', { title: t('Actualiser'), 'aria-label': t('Actualiser'), onclick: () => this.refresh() }, icon('refresh'));
    this.btnMore = h('button.icon-btn', { title: t('Options'), 'aria-label': t('Options'), onclick: (e) => this.paneMenu(e) }, icon('more'));
    this.crumbs = h('div.crumbs');
    this.filterInput = h('input', { type: 'search', placeholder: t('Filtrer les noms…'), enterkeyhint: 'search', oninput: () => { this.filter = this.filterInput.value.trim().toLowerCase(); this.renderList(); } });
    this.filterRow = h('div.filter', { hidden: true }, this.filterInput,
      h('button.icon-btn', { 'aria-label': t('Fermer le filtre'), onclick: () => this.toggleFilter(false) }, icon('x')));
    this.cols = h('div.cols',
      h('span'),
      this.colBtn('name', t('Nom')), this.colBtn('size', t('Taille'), true), this.colBtn('mtime', t('Modifié')),
      h('span', t('Droits')), h('span'));
    this.list = h('ul.list', { role: 'listbox', 'aria-multiselectable': 'true' });
    this.loadingEl = h('div.loading', { hidden: true });
    this.wrap = h('div.list-wrap', { tabindex: '0' }, this.cols, this.list);
    this.foot = h('div.pane-foot', h('span.info'), h('span.spacer'), h('span.extra'));
    this.root.append(
      h('div.pane-head',
        h('div.pane-title', this.labelEl, this.btnSearch, this.btnNew, this.btnUpload, this.btnRefresh, this.btnMore),
        this.crumbs, this.filterRow),
      this.loadingEl, this.wrap, this.foot);
    this.bindGestures();
    this.bindDnD();
    this.bindKeys();
    this.root.addEventListener('pointerdown', () => this.app.focusPane(this.side), true);
  }

  colBtn(key, label, num) {
    const b = h('button', { class: num ? 'num' : '', onclick: () => this.setSort(key) }, label);
    b.dataset.key = key;
    return b;
  }

  setSort(key, dir) {
    if (dir) this.sort = { key, dir };
    else this.sort = this.sort.key === key ? { key, dir: -this.sort.dir } : { key, dir: key === 'name' ? 1 : -1 };
    this.savePrefs();
    this.renderList();
  }

  toggleFilter(force) {
    const show = force ?? this.filterRow.hidden;
    this.filterRow.hidden = !show;
    if (show) setTimeout(() => this.filterInput.focus(), 30);
    else { this.filterInput.value = ''; this.filter = ''; this.renderList(); }
  }

  setLoading(on) {
    this.loadingCount += on ? 1 : -1;
    this.loadingEl.hidden = this.loadingCount <= 0;
  }

  // ---------- Navigation ----------
  async load(p, { keepSel = false, keepScroll = false, silent = false } = {}) {
    if (!this.ready) { this.renderDisconnected(); return; }
    const prevPath = this.path;
    const scroll = this.wrap.scrollTop;
    if (!silent) this.setLoading(true);
    try {
      const res = await this.listApi(p);
      if (prevPath && prevPath !== res.path) this.scrollMemo.set(prevPath, scroll);
      this.path = res.path;
      this.entries = res.entries;
      this.error = null;
      if (!keepSel || prevPath !== res.path) this.clearSel(false);
      else for (const n of [...this.sel]) if (!this.entries.some((e) => e.name === n)) this.sel.delete(n);
      if (prevPath !== res.path && !this.filterRow.hidden) this.toggleFilter(false);
      this.remember();
      this.render();
      if (keepScroll && prevPath === res.path) this.wrap.scrollTop = scroll;
      else this.wrap.scrollTop = this.scrollMemo.get(res.path) || 0;
    } catch (e) {
      if (e.code === 'HOSTKEY_UNKNOWN' || e.code === 'HOSTKEY_MISMATCH' || e.status === 401 || e.status === 502 || e.status === 504) {
        this.app.handleRemoteError(e);
      }
      if (!this.path || !silent) {
        if (this.path && p !== this.path) errToast(e);
        else { this.error = e; this.path = this.path || p; this.render(); }
      }
    } finally {
      if (!silent) this.setLoading(false);
    }
  }
  refresh(silent = false) { return this.load(this.path, { keepSel: true, keepScroll: true, silent }); }
  open(name) { return this.load(pjoin(this.path, name)); }
  up() { if (this.path && this.path !== '/') return this.load(pdir(this.path)); }
  remember() {
    if (this.isLocal) store.set('local.path', this.path);
    else if (this.siteId) store.set(`remote.path.${this.siteId}`, this.path);
  }

  // ---------- Rendu ----------
  render() {
    this.renderCrumbs();
    this.renderList();
    this.btnNew.disabled = this.btnUpload.disabled = this.btnRefresh.disabled = this.btnSearch.disabled = !this.ready;
    if (!this.isLocal) {
      const s = this.app.site;
      this.labelEl.lastChild.textContent = s ? s.name : t('Distant');
    }
  }

  renderDisconnected() {
    this.path = null;
    this.entries = [];
    this.clearSel(false);
    this.crumbs.replaceChildren();
    this.btnNew.disabled = this.btnUpload.disabled = this.btnRefresh.disabled = this.btnSearch.disabled = true;
    this.labelEl.lastChild.textContent = t('Distant');
    const s = this.app.site;
    this.list.replaceChildren(h('li.empty',
      icon('server'),
      h('h3', s ? s.name : t('Aucun serveur')),
      h('p', { style: { margin: 0 } }, s ? `${s.username}@${s.host}` : t('Choisissez ou créez un site SFTP pour commencer.')),
      s ? h('button.btn.primary', { onclick: () => this.app.connect(s.id) }, icon('plug', 'sm'), t('Se connecter'))
        : h('button.btn.primary', { onclick: () => this.app.openSites() }, icon('server', 'sm'), t('Gestionnaire de sites'))));
    this.foot.querySelector('.info').textContent = '';
    this.foot.querySelector('.extra').textContent = '';
  }

  renderCrumbs() {
    const parts = (this.path || '/').split('/').filter(Boolean);
    const kids = [this.crumb('/', icon(this.isLocal ? 'disk' : 'server', 'sm'))];
    let acc = '';
    for (const part of parts) {
      acc += '/' + part;
      kids.push(icon('chev', 'crumb-sep'), this.crumb(acc, h('span', part)));
    }
    this.crumbs.replaceChildren(...kids);
    requestAnimationFrame(() => { this.crumbs.scrollLeft = this.crumbs.scrollWidth; });
  }

  crumb(path, content) {
    const b = h('button.crumb', { onclick: () => this.load(path), title: path }, content);
    b.dataset.path = path;
    return b;
  }

  visibleEntries() {
    const f = this.filter;
    const { key, dir } = this.sort;
    const coll = new Intl.Collator(LOCALE, { numeric: true, sensitivity: 'base' });
    return this.entries
      .filter((e) => (this.showHidden || !e.name.startsWith('.')) && (!f || e.name.toLowerCase().includes(f)))
      .sort((a, b) => {
        const da = a.type === 'dir' ? 0 : 1; const db = b.type === 'dir' ? 0 : 1;
        if (da !== db) return da - db;
        let r = 0;
        if (key === 'size') r = a.size - b.size;
        else if (key === 'mtime') r = a.mtime - b.mtime;
        if (!r) r = coll.compare(a.name, b.name);
        return r * dir;
      });
  }

  renderList() {
    if (!this.ready) return this.renderDisconnected();
    for (const b of this.cols.querySelectorAll('button')) {
      b.classList.toggle('sorted', b.dataset.key === this.sort.key);
      b.textContent = { name: t('Nom'), size: t('Taille'), mtime: t('Modifié') }[b.dataset.key] + (b.dataset.key === this.sort.key ? (this.sort.dir > 0 ? ' ↑' : ' ↓') : '');
    }
    if (this.error) {
      this.list.replaceChildren(h('li.empty', icon('x'), h('h3', t("Impossible d'afficher ce dossier")), h('p', { style: { margin: 0 } }, this.error.message),
        h('div', { style: { display: 'flex', gap: '8px' } },
          this.path !== '/' ? h('button.btn', { onclick: () => this.load(pdir(this.path || '/')) }, icon('up', 'sm'), t('Dossier parent')) : null,
          h('button.btn.primary', { onclick: () => this.load(this.path) }, icon('refresh', 'sm'), t('Réessayer')))));
      this.foot.querySelector('.info').textContent = '';
      return;
    }
    const items = this.visibleEntries();
    this.visible = items;
    const frag = document.createDocumentFragment();
    if (this.path && this.path !== '/') frag.append(this.row({ name: '..', type: 'dir', up: true }));
    for (const e of items) frag.append(this.row(e));
    if (!items.length) {
      frag.append(h('li.empty', { style: { padding: '36px 24px' } }, icon(this.filter ? 'search' : 'folder'),
        h('p', { style: { margin: 0 } }, this.filter ? t('Aucun résultat') : t('Dossier vide'))));
    }
    this.list.replaceChildren(frag);
    this.root.classList.toggle('selecting', this.selecting || this.sel.size > 0);
    this.updateFoot();
  }

  row(e) {
    const isDir = e.type === 'dir';
    const kind = isDir ? 'dir' : ftype(e.name);
    const meta = e.up ? t('Dossier parent') : isDir ? date(e.mtime) : `${size(e.size)} · ${date(e.mtime)}`;
    const li = h('li.row-wrap', { role: 'option' },
      h('div.row', {
        class: `row${isDir ? ' dir' : ''}${e.up ? ' up' : ''}${this.sel.has(e.name) ? ' sel' : ''}${e.name.startsWith('.') && !e.up ? ' hidden-file' : ''}`,
        draggable: !e.up && !isTouch() ? 'true' : null,
      },
        h('span.ic', { class: `ic t-${kind}` }, icon(e.up ? 'up' : isDir ? 'folder' : typeIcon(kind))),
        h('span.nm', h('span.n', e.up ? '..' : e.name, e.link ? h('span.muted', ' ↪') : null), h('span.m', meta)),
        h('span.x.num', e.up || isDir ? '' : size(e.size)),
        h('span.x', e.up ? '' : date(e.mtime)),
        h('span.x.mono', e.up ? '' : perms(e.mode, isDir)),
        e.up ? h('span') : h('span.chk', icon('check', 'sm'))));
    li.dataset.name = e.name;
    if (e.up) li.dataset.up = '1';
    li.setAttribute('aria-selected', this.sel.has(e.name) ? 'true' : 'false');
    return li;
  }

  updateFoot() {
    const items = this.visible || [];
    const dirs = items.filter((e) => e.type === 'dir').length;
    const files = items.length - dirs;
    const total = items.reduce((a, e) => a + (e.type === 'dir' ? 0 : e.size), 0);
    let txt = `${tn(dirs, '{n} dossier', '{n} dossiers')}, ${tn(files, '{n} fichier', '{n} fichiers')} · ${size(total)}`;
    if (this.sel.size) {
      const sz = [...this.sel].reduce((a, n) => { const e = this.entry(n); return a + (e && e.type !== 'dir' ? e.size : 0); }, 0);
      txt = `${tn(this.sel.size, '{n} sélectionné', '{n} sélectionnés')} · ${size(sz)} — ${txt}`;
    }
    this.foot.querySelector('.info').textContent = txt;
    const extra = this.foot.querySelector('.extra');
    if (this.isLocal && this.app.disk) extra.textContent = t('{size} libres', { size: size(this.app.disk.free) });
    else if (!this.isLocal && this.app.site) extra.textContent = `${this.app.site.username}@${this.app.site.host}`;
  }

  entry(name) { return this.entries.find((e) => e.name === name); }
  rowEl(name) { return [...this.list.children].find((li) => li.dataset.name === name && !li.dataset.up); }

  // ---------- Sélection ----------
  setSel(names, anchor) {
    if (names.size && this.other.sel.size) this.other.clearSel();
    this.sel = names;
    if (anchor !== undefined) this.anchor = anchor;
    if (!this.sel.size) this.selecting = false;
    for (const li of this.list.children) {
      if (!li.dataset.name || li.dataset.up) continue;
      const on = this.sel.has(li.dataset.name);
      li.firstChild.classList.toggle('sel', on);
      li.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    this.root.classList.toggle('selecting', this.selecting || this.sel.size > 0);
    this.updateFoot();
    this.app.updateSelBar();
  }
  toggle(name) {
    const s = new Set(this.sel);
    if (s.has(name)) s.delete(name); else s.add(name);
    this.setSel(s, name);
  }
  clearSel(render = true) {
    this.sel = new Set();
    this.selecting = false;
    if (render) this.setSel(new Set());
  }
  selectAll() {
    const all = (this.visible || []).map((e) => e.name);
    this.selecting = true;
    this.setSel(this.sel.size === all.length ? new Set() : new Set(all));
  }
  invertSel() {
    this.selecting = true;
    this.setSel(new Set((this.visible || []).map((e) => e.name).filter((n) => !this.sel.has(n))));
  }
  rangeTo(name) {
    const names = (this.visible || []).map((e) => e.name);
    const a = names.indexOf(this.anchor ?? name); const b = names.indexOf(name);
    if (a < 0 || b < 0) return this.setSel(new Set([name]), name);
    const [x, y] = a < b ? [a, b] : [b, a];
    this.setSel(new Set(names.slice(x, y + 1)));
  }
  selectedEntries() { return [...this.sel].map((n) => this.entry(n)).filter(Boolean); }

  // ---------- Gestes : appui, appui long, glissement ----------
  bindGestures() {
    let st = null;
    let lastTouchUp = 0;
    let lastPtr = 'mouse';
    this.list.addEventListener('pointerdown', (e) => { lastPtr = e.pointerType; }, true);
    const rowOf = (el) => el && el.closest && el.closest('.row-wrap[data-name]');

    this.list.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      const li = rowOf(e.target);
      if (!li) return;
      st = { id: e.pointerId, x: e.clientX, y: e.clientY, li, moved: false, long: false, swipe: false, dx: 0 };
      st.timer = setTimeout(() => {
        if (!st || st.moved) return;
        st.long = true;
        vibrate(15);
        if (li.dataset.up) return;
        this.selecting = true;
        const s = new Set(this.sel);
        s.add(li.dataset.name);
        this.setSel(s, li.dataset.name);
      }, LONG_PRESS);
    });

    this.list.addEventListener('pointermove', (e) => {
      if (!st || e.pointerId !== st.id) return;
      const dx = e.clientX - st.x; const dy = e.clientY - st.y;
      if (!st.moved && Math.hypot(dx, dy) > 10) { st.moved = true; clearTimeout(st.timer); }
      if (!st.swipe && st.moved && !st.long && !this.selecting && !st.li.dataset.up && Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        st.swipe = true;
        st.row = st.li.firstChild;
        st.bg = h('div.swipe-bg',
          h('span.l', icon(this.isLocal ? 'send' : 'receive', 'sm'), this.isLocal ? t('Envoyer') : t('Télécharger')),
          h('span.r', t('Actions'), icon('more', 'sm')));
        st.li.classList.add('row-wrap');
        st.li.style.position = 'relative';
        st.li.style.overflow = 'hidden';
        st.li.prepend(st.bg);
        st.row.classList.add('swiping');
        st.li.setPointerCapture && st.li.setPointerCapture(e.pointerId);
      }
      if (st.swipe) {
        const lim = st.li.offsetWidth * 0.6;
        st.dx = Math.max(-lim, Math.min(lim, dx));
        st.row.style.transform = `translateX(${st.dx}px)`;
        st.bg.className = `swipe-bg ${st.dx > 0 ? 'right' : 'left'}${Math.abs(st.dx) > SWIPE_TRIGGER ? ' armed' : ''}`;
        if (Math.abs(st.dx) > SWIPE_TRIGGER && !st.buzzed) { vibrate(8); st.buzzed = true; }
        if (Math.abs(st.dx) < SWIPE_TRIGGER) st.buzzed = false;
      }
    });

    const end = (e, cancelled) => {
      if (!st || e.pointerId !== st.id) return;
      clearTimeout(st.timer);
      const s = st; st = null;
      if (s.swipe) {
        const name = s.li.dataset.name;
        const fire = !cancelled && Math.abs(s.dx) > SWIPE_TRIGGER;
        s.row.classList.remove('swiping');
        s.row.classList.add('swipe-back');
        s.row.style.transform = '';
        setTimeout(() => { s.bg.remove(); s.row.classList.remove('swipe-back'); }, 220);
        if (fire) {
          if (s.dx > 0) this.app.transfer(this, [name]);
          else this.itemMenu(name);
        }
        lastTouchUp = Date.now();
        return;
      }
      if (cancelled) return;
      lastTouchUp = Date.now();
      if (s.long || s.moved) return;
      // L'action est exécutée sur le « click » qui suit, sinon ce clic fantôme atterrirait
      // sur la feuille qui vient de s'ouvrir sous le doigt.
      pendingTap = s.li;
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(runPending, 450);
    };
    let pendingTap = null;
    let pendingTimer = null;
    const runPending = () => {
      clearTimeout(pendingTimer);
      const li = pendingTap;
      pendingTap = null;
      if (li && li.isConnected) this.tap(li);
    };
    this.list.addEventListener('pointerup', (e) => end(e, false));
    this.list.addEventListener('pointercancel', (e) => end(e, true));

    // Souris : clic = sélection, double-clic = ouvrir / transférer, clic droit = menu.
    this.list.addEventListener('click', (e) => {
      if (pendingTap) { e.stopPropagation(); runPending(); return; }
      if (Date.now() - lastTouchUp < 700) return;
      const li = rowOf(e.target);
      if (!li) { if (!e.ctrlKey && !e.metaKey) this.clearSel(); return; }
      if (li.dataset.up) return;
      const name = li.dataset.name;
      if (e.shiftKey) this.rangeTo(name);
      else if (e.ctrlKey || e.metaKey) this.toggle(name);
      else this.setSel(new Set([name]), name);
    });
    this.list.addEventListener('dblclick', (e) => {
      if (Date.now() - lastTouchUp < 700) return;
      const li = rowOf(e.target);
      if (!li) return;
      if (li.dataset.up) return this.up();
      const en = this.entry(li.dataset.name);
      if (!en) return;
      if (en.type === 'dir') this.open(en.name);
      else this.app.transfer(this, [en.name]);
    });
    this.wrap.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (lastPtr !== 'mouse' || Date.now() - lastTouchUp < 700) return;
      const li = rowOf(e.target);
      if (!li || li.dataset.up) return this.paneMenu(e);
      const name = li.dataset.name;
      if (!this.sel.has(name)) this.setSel(new Set([name]), name);
      if (this.sel.size > 1) this.app.selMenu(e);
      else this.itemMenu(name, e);
    });
  }

  tap(li) {
    if (li.dataset.up) return this.up();
    const name = li.dataset.name;
    if (this.selecting || this.sel.size) return this.toggle(name);
    const en = this.entry(name);
    if (!en) return;
    if (en.type === 'dir') this.open(name);
    else this.itemMenu(name);
  }

  // ---------- Clavier (bureau) ----------
  bindKeys() {
    this.wrap.addEventListener('keydown', (e) => {
      if (e.target !== this.wrap) return;
      const one = this.sel.size === 1 ? [...this.sel][0] : null;
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') { e.preventDefault(); this.selectAll(); }
      else if (e.key === 'Escape') this.clearSel();
      else if (e.key === 'Backspace') { e.preventDefault(); this.up(); }
      else if (e.key === 'Delete') { if (this.sel.size) this.remove([...this.sel]); }
      else if (e.key === 'F2') { if (one) this.rename(one); }
      else if (e.key === 'F5') { e.preventDefault(); this.refresh(); }
      else if (e.key === 'Enter' && one) {
        const en = this.entry(one);
        if (en && en.type === 'dir') this.open(one); else if (en) this.app.transfer(this, [one]);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const names = (this.visible || []).map((x) => x.name);
        if (!names.length) return;
        let i = names.indexOf(this.anchor);
        i = e.key === 'ArrowDown' ? Math.min(names.length - 1, i + 1) : Math.max(0, i - 1);
        if (e.shiftKey) this.rangeTo(names[i]); else this.setSel(new Set([names[i]]), names[i]);
        this.anchor = e.shiftKey ? this.anchor : names[i];
        const el = this.rowEl(names[i]);
        el && el.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  // ---------- Glisser-déposer (souris) ----------
  bindDnD() {
    const TYPE = 'application/x-sftpad';
    this.list.addEventListener('dragstart', (e) => {
      const li = e.target.closest && e.target.closest('.row-wrap[data-name]');
      if (!li || li.dataset.up) return;
      if (!this.sel.has(li.dataset.name)) this.setSel(new Set([li.dataset.name]), li.dataset.name);
      e.dataTransfer.setData(TYPE, JSON.stringify({ side: this.side, names: [...this.sel] }));
      e.dataTransfer.effectAllowed = 'copyMove';
      this.app.dragSide = this.side;
    });
    this.list.addEventListener('dragend', () => { this.app.dragSide = null; });
    const targetDir = (e) => {
      const li = e.target.closest && e.target.closest('.row-wrap[data-name]');
      if (li && li.dataset.up) return { dir: pdir(this.path), li };
      const en = li && this.entry(li.dataset.name);
      if (en && en.type === 'dir') return { dir: pjoin(this.path, en.name), li, name: en.name };
      const cr = e.target.closest && e.target.closest('.crumb');
      if (cr) return { dir: cr.dataset.path, li: cr };
      return { dir: this.path, li: null };
    };
    let hl = null;
    const clearHl = () => { if (hl) { hl.firstChild && hl.firstChild.classList ? hl.firstChild.classList.remove('drop-target') : null; hl.classList.remove('drop-hover'); } hl = null; this.root.classList.remove('dragover'); };
    this.root.addEventListener('dragover', (e) => {
      const types = [...e.dataTransfer.types];
      const internal = types.includes(TYPE);
      const files = types.includes('Files');
      if ((!internal && !files) || !this.ready) return;
      const t = targetDir(e);
      if (internal && this.app.dragSide === this.side && !t.name && !(t.li && t.li.classList.contains('crumb')) && !(t.li && t.li.dataset.up)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = internal && this.app.dragSide === this.side ? 'move' : 'copy';
      const el = t.li;
      if (el !== hl) {
        clearHl();
        hl = el;
        if (el) { if (el.classList.contains('crumb')) el.classList.add('drop-hover'); else el.firstChild.classList.add('drop-target'); }
      }
      if (!el) this.root.classList.add('dragover');
    });
    this.root.addEventListener('dragleave', (e) => { if (!this.root.contains(e.relatedTarget)) clearHl(); });
    this.root.addEventListener('drop', async (e) => {
      const t = targetDir(e);
      clearHl();
      const raw = e.dataTransfer.getData(TYPE);
      e.preventDefault();
      if (raw) {
        const { side, names } = JSON.parse(raw);
        if (side === this.side) return this.moveInto(names, t.dir);
        return this.app.transfer(this.app.pane(side), names, t.dir);
      }
      if (e.dataTransfer.items && e.dataTransfer.items.length) {
        const files = await collectDropped(e.dataTransfer.items);
        if (files.length) this.app.uploadFromDevice(this, files, t.dir);
      }
    });
  }

  // ---------- Opérations ----------
  async mkdir() {
    const name = await prompt({ title: t('Nouveau dossier'), label: t('Nom du dossier'), ok: t('Créer'), validate: validName });
    if (!name) return;
    try {
      await post(`${this.base()}/mkdir`, { path: pjoin(this.path, name) });
      await this.refresh();
      this.setSel(new Set([name]), name);
      const el = this.rowEl(name); el && el.scrollIntoView({ block: 'center' });
    } catch (e) { errToast(e); }
  }

  async rename(name) {
    const dot = name.lastIndexOf('.');
    const nn = await prompt({ title: t('Renommer'), label: t('Nouveau nom'), value: name, ok: t('Renommer'), validate: validName, select: dot > 0 && this.entry(name)?.type !== 'dir' ? [0, dot] : null });
    if (!nn || nn === name) return;
    try {
      await post(`${this.base()}/rename`, { from: pjoin(this.path, name), to: pjoin(this.path, nn) });
      await this.refresh();
      this.setSel(new Set([nn]), nn);
    } catch (e) { errToast(e); }
  }

  async move(names) {
    const dest = await prompt({ title: names.length > 1 ? t('Déplacer {n} éléments', { n: names.length }) : t('Déplacer « {name} »', { name: names[0] }), label: t('Dossier de destination (sur ce même côté)'), value: this.path, ok: t('Déplacer'), validate: (v) => (!v.startsWith('/') ? t('Chemin absolu requis (commence par /)') : null) });
    if (!dest || dest === this.path) return;
    await this.moveInto(names, dest);
  }

  async moveInto(names, dir) {
    if (!dir || dir === this.path) return;
    const errs = [];
    for (const n of names) {
      const from = pjoin(this.path, n);
      if (dir === from || dir.startsWith(from + '/')) { errs.push(t('{name} : impossible de déplacer un dossier dans lui-même', { name: n })); continue; }
      try { await post(`${this.base()}/rename`, { from, to: pjoin(dir, n) }); } catch (e) { errs.push(t('{name} : {error}', { name: n, error: e.message })); }
    }
    if (errs.length) toast(errs.join('\n'), 'err');
    else toast(tn(names.length, '{n} élément déplacé', '{n} éléments déplacés'), 'ok');
    this.refresh();
  }

  async remove(names) {
    if (!names.length) return;
    const dirs = names.filter((n) => this.entry(n)?.type === 'dir').length;
    const msg = names.length === 1
      ? (dirs ? t('Supprimer définitivement « {name} » et tout son contenu ?', { name: names[0] }) : t('Supprimer définitivement « {name} » ?', { name: names[0] }))
      : (dirs ? tn(dirs, 'Supprimer définitivement {count} éléments (dont {n} dossier et leur contenu) ?', 'Supprimer définitivement {count} éléments (dont {n} dossiers et leur contenu) ?', { count: names.length })
        : t('Supprimer définitivement {n} éléments ?', { n: names.length }));
    const ok = await confirm({ title: this.isLocal ? t('Supprimer (local)') : t('Supprimer (serveur)'), message: msg, ok: t('Supprimer'), danger: true });
    if (!ok) return;
    this.setLoading(true);
    try {
      await post(`${this.base()}/delete`, { paths: names.map((n) => pjoin(this.path, n)) });
      toast(tn(names.length, '{n} élément supprimé', '{n} éléments supprimés'), 'ok');
    } catch (e) { errToast(e); }
    this.setLoading(false);
    this.clearSel();
    this.refresh();
  }

  async chmod(names) {
    const first = this.entry(names[0]);
    let mode = first ? first.mode & 0o777 : 0o644;
    const boxes = [];
    const octIn = h('input', { value: octal(mode), inputmode: 'numeric', maxlength: 4, style: { fontFamily: 'ui-monospace, monospace' } });
    const sync = () => { octIn.value = octal(mode); boxes.forEach((b) => { b.checked = !!(mode & b.bit); }); };
    const grid = h('div.perm-grid', h('span'), h('span.h', t('Lecture')), h('span.h', t('Écriture')), h('span.h', t('Exécution')),
      [[t('Propriétaire'), 6], [t('Groupe'), 3], [t('Autres'), 0]].map(([label, sh]) => [h('span.r', label), [4, 2, 1].map((b) => {
        const inp = h('input', { type: 'checkbox', onchange: () => { mode = inp.checked ? mode | inp.bit : mode & ~inp.bit; sync(); } });
        inp.bit = b << sh;
        boxes.push(inp);
        return h('label', inp);
      })]));
    octIn.addEventListener('input', () => { if (/^[0-7]{3,4}$/.test(octIn.value)) { mode = parseInt(octIn.value, 8); boxes.forEach((b) => { b.checked = !!(mode & b.bit); }); } });
    sync();
    const s = sheet({
      title: names.length > 1 ? t('Permissions ({n} éléments)', { n: names.length }) : t('Permissions'),
      body: h('div.form', names.length === 1 ? h('p.muted', { style: { margin: 0 } }, names[0]) : null, grid, h('label.field', h('span', t('Valeur octale')), octIn),
        h('p.muted', { style: { margin: 0, fontSize: '13px' } }, t('Appliqué aux éléments sélectionnés uniquement (non récursif).'))),
      foot: [h('button.btn', { onclick: () => s.close() }, t('Annuler')), h('button.btn.primary', {
        onclick: async () => {
          s.close();
          try { await post(`${this.base()}/chmod`, { paths: names.map((n) => pjoin(this.path, n)), mode: octal(mode) }); toast(t('Permissions modifiées'), 'ok'); this.refresh(); } catch (e) { errToast(e); }
        },
      }, t('Appliquer'))],
    });
  }

  preview(name) {
    const en = this.entry(name);
    const t = ftype(name);
    const p = pjoin(this.path, name);
    viewer({ name, url: this.fileUrl(p, true), kind: ['image', 'video', 'audio', 'pdf'].includes(t) ? t : 'text', download: () => downloadUrl(this.fileUrl(p)) });
    void en;
  }

  toDevice(names) {
    const files = names.filter((n) => this.entry(n)?.type === 'file');
    if (!files.length) return toast(t("Seuls les fichiers peuvent être téléchargés sur l'appareil. Pour un dossier, transférez-le."), 'err');
    files.forEach((n, i) => setTimeout(() => downloadUrl(this.fileUrl(pjoin(this.path, n))), i * 400));
    if (files.length < names.length) toast(t('Les dossiers ont été ignorés'));
  }

  copyPath(name) {
    const p = pjoin(this.path, name);
    navigator.clipboard?.writeText(p).then(() => toast(t('Chemin copié')), () => toast(p));
  }

  // ---------- Menus ----------
  itemMenu(name, e) {
    const en = this.entry(name);
    if (!en) return;
    const isDir = en.type === 'dir';
    const canXfer = this.other.ready;
    const kind = isDir ? 'dir' : ftype(name);
    const header = h('div.menu-head', h('span.ic', { class: `ic${isDir ? ' dir' : ''}` }, icon(isDir ? 'folder' : typeIcon(kind))),
      h('div', { style: { minWidth: 0 } }, h('b', name), h('small', isDir ? date(en.mtime, true) : `${size(en.size)} · ${date(en.mtime, true)}`)));
    menu([
      isDir ? { label: t('Ouvrir'), icon: 'folder', action: () => this.open(name) } : null,
      { label: this.isLocal ? t('Envoyer sur le serveur') : t('Télécharger en local'), icon: this.isLocal ? 'send' : 'receive', primary: true, disabled: !canXfer, action: () => this.app.transfer(this, [name]) },
      !isDir && previewable(name, en.size) ? { label: t('Aperçu'), icon: 'eye', action: () => this.preview(name) } : null,
      !isDir ? { label: t("Enregistrer sur l'appareil"), icon: 'phone', action: () => this.toDevice([name]) } : null,
      '-',
      { label: t('Renommer'), icon: 'edit', action: () => this.rename(name) },
      { label: t('Déplacer…'), icon: 'receive', action: () => this.move([name]) },
      { label: t('Permissions'), icon: 'lock', action: () => this.chmod([name]) },
      { label: t('Copier le chemin'), icon: 'copy', action: () => this.copyPath(name) },
      { label: t('Sélectionner'), icon: 'selectall', action: () => { this.selecting = true; this.setSel(new Set([...this.sel, name]), name); } },
      '-',
      { label: t('Supprimer'), icon: 'trash', danger: true, action: () => this.remove([name]) },
    ], { x: e && e.clientX, y: e && e.clientY, header });
  }

  paneMenu(e) {
    const r = e && e.currentTarget && e.currentTarget.getBoundingClientRect ? e.currentTarget.getBoundingClientRect() : null;
    const x = e && e.type === 'contextmenu' ? e.clientX : r ? r.right - 230 : undefined;
    const y = e && e.type === 'contextmenu' ? e.clientY : r ? r.bottom + 4 : undefined;
    const sortItem = (key, label) => ({ label: `${this.sort.key === key ? '✓ ' : ''}${label}`, icon: 'sort', action: () => this.setSort(key, this.sort.key === key ? this.sort.dir : (key === 'name' ? 1 : -1)) });
    menu([
      this.ready ? { label: t('Nouveau dossier'), icon: 'newfolder', action: () => this.mkdir() } : null,
      this.ready ? { label: t("Envoyer des fichiers depuis l'appareil"), icon: 'upload', action: () => this.app.pickDeviceFiles(this) } : null,
      this.ready ? { label: t("Envoyer un dossier depuis l'appareil"), icon: 'folder', action: () => this.app.pickDeviceFiles(this, true) } : null,
      this.ready ? { label: t('Aller à…'), icon: 'chev', action: () => this.goto() } : null,
      this.ready ? { label: this.isLocal ? t('Dossier local du site') : t('Dossier personnel'), icon: 'home', action: () => this.home() } : null,
      this.ready && this.entries.length ? { label: t('Tout sélectionner'), icon: 'selectall', action: () => this.selectAll() } : null,
      '-',
      sortItem('name', t('Trier par nom')), sortItem('size', t('Trier par taille')), sortItem('mtime', t('Trier par date')),
      { label: this.sort.dir > 0 ? t('Ordre décroissant') : t('Ordre croissant'), icon: 'sort', action: () => this.setSort(this.sort.key, -this.sort.dir) },
      { label: this.showHidden ? t('Masquer les fichiers cachés') : t('Afficher les fichiers cachés'), icon: 'eye', action: () => { this.showHidden = !this.showHidden; this.savePrefs(); this.renderList(); } },
      !this.isLocal && this.app.connected ? '-' : null,
      !this.isLocal && this.app.connected ? { label: t('Se déconnecter'), icon: 'logout', danger: true, action: () => this.app.disconnect() } : null,
    ], { x, y });
  }

  async goto() {
    const p = await prompt({ title: t('Aller à'), label: t('Chemin'), value: this.path, ok: t('Ouvrir'), validate: (v) => (!v.startsWith('/') ? t('Chemin absolu requis') : null) });
    if (p) this.load(p);
  }

  home() {
    if (this.isLocal) this.load((this.app.site && this.app.site.localDir) || '/');
    else this.load(this.app.remoteStart || '');
  }
}

function validName(v) {
  if (!v) return t('Nom requis');
  if (v.includes('/')) return t('Le nom ne peut pas contenir « / »');
  if (v === '.' || v === '..') return t('Nom invalide');
  return null;
}

// Récupère les fichiers (et dossiers) déposés depuis le système, avec leurs chemins relatifs.
async function collectDropped(items) {
  const out = [];
  const entries = [...items].map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
  if (!entries.length) {
    for (const it of items) { const f = it.getAsFile && it.getAsFile(); if (f) out.push({ file: f, rel: f.name }); }
    return out;
  }
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file: f, rel: prefix + f.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
      } while (batch.length);
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

export { pbase };
