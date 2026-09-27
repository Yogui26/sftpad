// File de transferts : état temps réel (WebSocket), dock en bas d'écran et feuille détaillée.
import { h, icon, size, speed, eta, $ } from './util.js';
import { post } from './api.js';
import { sheet, errToast, confirm } from './ui.js';

const ACTIVE = new Set(['queued', 'running']);
const TABS = [
  { key: 'active', label: 'En cours', test: (j) => ACTIVE.has(j.status) },
  { key: 'error', label: 'Échecs', test: (j) => j.status === 'error' || j.status === 'canceled' },
  { key: 'done', label: 'Terminés', test: (j) => j.status === 'done' || j.status === 'skipped' },
];
const RENDER_LIMIT = 300;

export class Queue {
  constructor(app) {
    this.app = app;
    this.jobs = new Map();
    this.paused = false;
    this.device = new Map(); // envois depuis l'appareil (côté navigateur)
    this.view = null;
    this.tab = 'active';
    this.batchDone = 0;
    this.batchTotal = 0;
    $('#dock').addEventListener('click', () => this.open());
    $('#queue-btn').addEventListener('click', () => this.open());
  }

  // ---------- Données ----------
  setAll(list, paused) {
    this.jobs = new Map(list.map((j) => [j.id, j]));
    this.paused = !!paused;
    this.changed();
  }
  update(list) {
    for (const j of list) {
      if (j.removed) this.jobs.delete(j.id);
      else {
        const prev = this.jobs.get(j.id);
        if (prev && ACTIVE.has(prev.status) && j.status === 'error') this.app.onJobError(j);
        this.jobs.set(j.id, j);
      }
    }
    this.changed();
  }
  setPaused(p) { this.paused = p; this.changed(); }

  all() { return [...this.jobs.values(), ...this.device.values()]; }

  stats() {
    let active = 0; let running = 0; let errors = 0; let bytes = 0; let done = 0; let spd = 0;
    for (const j of this.all()) {
      if (ACTIVE.has(j.status)) {
        active++;
        if (j.status === 'running') { running++; spd += j.speed || 0; }
        if (j.kind !== 'dir') { bytes += j.size || 0; done += j.done || 0; }
      } else if (j.status === 'error') errors++;
    }
    return { active, running, errors, bytes, done, speed: spd };
  }

  changed() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this.renderDock(); if (this.view) this.renderView(); });
  }

  // ---------- Dock ----------
  renderDock() {
    const s = this.stats();
    const badge = $('#queue-badge');
    badge.hidden = !(s.active || s.errors);
    badge.textContent = s.active || s.errors;
    badge.classList.toggle('err', !s.active && s.errors > 0);
    const dock = $('#dock');
    // Suivi d'un « lot » pour une barre de progression globale lisible.
    if (s.active === 0) { this.batchDone = 0; this.batchTotal = 0; }
    const show = s.active > 0;
    dock.hidden = !show || !!this.view;
    if (!show) return;
    dock.classList.toggle('err', s.errors > 0);
    const pct = s.bytes ? Math.min(100, (s.done / s.bytes) * 100) : 0;
    $('#dock-fill').style.width = `${pct}%`;
    $('#dock-text').textContent = this.paused
      ? `En pause · ${s.active} en attente`
      : `${s.active} transfert${s.active > 1 ? 's' : ''} · ${size(s.done)} / ${size(s.bytes)}`;
    const left = s.speed > 0 ? eta((s.bytes - s.done) / s.speed) : '';
    $('#dock-speed').textContent = [speed(s.speed), left].filter(Boolean).join(' · ');
  }

  // ---------- Feuille détaillée ----------
  open() {
    if (this.view) return;
    const s = this.stats();
    if (!s.active && this.tab === 'active') this.tab = s.errors ? 'error' : 'done';
    this.tabsEl = h('div.qtabs');
    this.toolsEl = h('div.qtools');
    this.listEl = h('ul.qlist');
    this.view = sheet({
      title: 'Transferts',
      wide: true,
      body: this.listEl,
      onClose: () => { this.view = null; this.nodes = null; this.renderDock(); },
    });
    const body = this.view.body;
    body.before(this.tabsEl, this.toolsEl);
    this.nodes = new Map();
    this.renderView(true);
    this.renderDock();
  }

  renderView(full) {
    const all = this.all();
    // Onglets
    this.tabsEl.replaceChildren(...TABS.map((t) => h('button', {
      class: this.tab === t.key ? 'on' : '',
      onclick: () => { this.tab = t.key; this.listEl.replaceChildren(); this.nodes = new Map(); this.renderView(true); },
    }, t.label, h('span.n', all.filter(t.test).length))));
    // Outils
    const tools = [];
    if (this.tab === 'active') {
      tools.push(h('button.btn.small', { onclick: () => post('transfers/pause', { paused: !this.paused }).catch(errToast) }, icon(this.paused ? 'play' : 'pause', 'sm'), this.paused ? 'Reprendre' : 'Pause'));
      if (all.some((j) => ACTIVE.has(j.status) && !j.device)) {
        tools.push(h('button.btn.small', {
          onclick: async () => {
            if (await confirm({ title: 'Tout annuler', message: 'Annuler tous les transferts en cours et en attente ?', ok: 'Tout annuler', danger: true })) {
              post('transfers/cancel', { ids: [...this.jobs.values()].filter((j) => ACTIVE.has(j.status)).map((j) => j.id) }).catch(errToast);
            }
          },
        }, icon('x', 'sm'), 'Tout annuler'));
      }
    } else if (this.tab === 'error') {
      tools.push(h('button.btn.small', { onclick: () => post('transfers/retry', { ids: [...this.jobs.values()].filter((j) => j.status === 'error' || j.status === 'canceled').map((j) => j.id) }).catch(errToast) }, icon('retry', 'sm'), 'Tout réessayer'));
      tools.push(h('button.btn.small', { onclick: () => { post('transfers/clear', { statuses: ['error', 'canceled'] }).catch(errToast); this.clearDevice(['error', 'canceled']); } }, icon('trash', 'sm'), 'Vider'));
    } else {
      tools.push(h('button.btn.small', { onclick: () => { post('transfers/clear', { statuses: ['done', 'skipped'] }).catch(errToast); this.clearDevice(['done', 'skipped']); } }, icon('trash', 'sm'), 'Vider la liste'));
    }
    this.toolsEl.replaceChildren(...tools);

    // Liste (mise à jour incrémentale pour rester fluide pendant les transferts)
    const tab = TABS.find((t) => t.key === this.tab);
    let items = all.filter(tab.test);
    if (this.tab !== 'active') items = items.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
    else items = items.sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1));
    const shown = items.slice(0, RENDER_LIMIT);
    const keep = new Set(shown.map((j) => j.id));
    for (const [id, node] of this.nodes) if (!keep.has(id)) { node.remove(); this.nodes.delete(id); }
    let prev = null;
    for (const j of shown) {
      let node = this.nodes.get(j.id);
      if (!node) { node = this.jobNode(j); this.nodes.set(j.id, node); }
      else this.fillJob(node, j);
      const expected = prev ? prev.nextSibling : this.listEl.firstChild;
      if (expected !== node) this.listEl.insertBefore(node, expected);
      prev = node;
    }
    let more = this.listEl.querySelector('.qmore');
    if (items.length > RENDER_LIMIT) {
      if (!more) { more = h('li.qempty.qmore'); this.listEl.append(more); }
      more.textContent = `… et ${items.length - RENDER_LIMIT} autres`;
      this.listEl.append(more);
    } else if (more) more.remove();
    let empty = this.listEl.querySelector('.qempty:not(.qmore)');
    if (!shown.length) {
      if (!empty) this.listEl.append(h('li.qempty', { tab: this.tab }, this.tab === 'active' ? 'Aucun transfert en cours' : this.tab === 'error' ? 'Aucun échec' : 'Rien pour le moment'));
    } else if (empty) empty.remove();
    void full;
  }

  jobNode(j) {
    const node = h('li.job',
      h('span.dir'),
      h('div.t', h('b'), h('small.sub'), h('div.bar', h('i')), h('small.stat')),
      h('div.acts'));
    this.fillJob(node, j);
    return node;
  }

  fillJob(node, j) {
    const sig = `${j.status}|${j.done}|${Math.round(j.speed || 0)}|${j.error}|${j.name}`;
    if (node._sig === sig) return;
    node._sig = sig;
    node.className = `job ${j.status}`;
    const dirIcon = j.device ? 'phone' : j.kind === 'dir' ? 'folder' : j.dir === 'up' ? 'upload' : 'download';
    const d = node.querySelector('.dir');
    if (d._ic !== dirIcon) { d.replaceChildren(icon(dirIcon, 'sm')); d._ic = dirIcon; }
    node.querySelector('b').textContent = j.name;
    const from = j.device ? "Depuis l'appareil" : (j.dir === 'up' ? 'Local → ' : `${j.siteName} → `);
    node.querySelector('.sub').textContent = `${from}${j.device ? ' → ' + j.dst : j.dst}`;
    const bar = node.querySelector('.bar');
    const showBar = j.status === 'running' && j.kind !== 'dir';
    bar.hidden = !showBar;
    if (showBar) bar.firstChild.style.width = `${j.size ? Math.min(100, (j.done / j.size) * 100) : 0}%`;
    const stat = node.querySelector('.stat');
    stat.classList.toggle('e', j.status === 'error');
    let txt = '';
    if (j.status === 'running') {
      txt = j.kind === 'dir' ? 'Analyse du dossier…' : `${size(j.done)} / ${size(j.size)} · ${speed(j.speed) || '…'}${j.speed > 0 ? ' · ' + eta((j.size - j.done) / j.speed) : ''}`;
    } else if (j.status === 'queued') txt = j.error ? j.error : `En attente · ${j.kind === 'dir' ? 'dossier' : size(j.size)}`;
    else if (j.status === 'done') txt = j.kind === 'dir' ? `Dossier : ${j.size} élément${j.size > 1 ? 's' : ''} ajouté${j.size > 1 ? 's' : ''}` : `Terminé · ${size(j.size)}`;
    else if (j.status === 'skipped') txt = j.error || 'Ignoré';
    else if (j.status === 'canceled') txt = 'Annulé';
    else if (j.status === 'error') txt = j.error || 'Erreur';
    stat.textContent = txt;
    const acts = node.querySelector('.acts');
    const btns = [];
    if (j.device) {
      if (ACTIVE.has(j.status) && j.abort) btns.push(h('button.icon-btn', { 'aria-label': 'Annuler', onclick: () => j.abort() }, icon('x')));
      else if (!ACTIVE.has(j.status)) btns.push(h('button.icon-btn', { 'aria-label': 'Retirer', onclick: () => { this.device.delete(j.id); this.changed(); } }, icon('trash')));
    } else if (ACTIVE.has(j.status)) btns.push(h('button.icon-btn', { 'aria-label': 'Annuler', title: 'Annuler', onclick: () => post('transfers/cancel', { ids: [j.id] }).catch(errToast) }, icon('x')));
    else {
      if (j.status === 'error' || j.status === 'canceled') btns.push(h('button.icon-btn', { 'aria-label': 'Réessayer', title: 'Réessayer', onclick: () => post('transfers/retry', { ids: [j.id] }).catch(errToast) }, icon('retry')));
      btns.push(h('button.icon-btn', { 'aria-label': 'Retirer', title: 'Retirer de la liste', onclick: () => post('transfers/remove', { ids: [j.id] }).catch(errToast) }, icon('trash')));
    }
    acts.replaceChildren(...btns);
  }

  // ---------- Envois depuis l'appareil ----------
  addDevice(job) {
    this.device.set(job.id, job);
    this.changed();
    return job;
  }
  clearDevice(statuses) {
    for (const [id, j] of this.device) if (statuses.includes(j.status)) this.device.delete(id);
    this.changed();
  }
}
