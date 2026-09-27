// SFTPad — point d'entrée de l'interface.
import { h, icon, $, $$, size, pjoin, store, debounce, isWide, vibrate } from './js/util.js';
import { get, post, put, setUnauthorizedHandler, connectWS, uploadFiles, qs } from './js/api.js';
import { toast, errToast, sheet, confirm, choose, menu } from './js/ui.js';
import { Pane } from './js/pane.js';
import { Queue } from './js/queue.js';
import { sitesSheet, editSite } from './js/sites.js';

const ON_EXISTS = [
  { value: 'resume', label: 'Reprendre ou ignorer si identique', hint: 'Complète les fichiers partiels, ignore ceux de même taille (recommandé)' },
  { value: 'overwrite', label: 'Écraser', hint: 'Remplace systématiquement les fichiers existants' },
  { value: 'newer', label: 'Écraser si plus récent', hint: 'Remplace seulement si la source est plus récente' },
  { value: 'skip', label: 'Ignorer', hint: 'Ne transfère pas les fichiers déjà présents' },
  { value: 'rename', label: 'Renommer', hint: 'Garde les deux : « fichier (1).ext »' },
];

class App {
  constructor() {
    this.sites = [];
    this.siteId = null;
    this.connected = false;
    this.connecting = false;
    this.remoteStart = null;
    this.settings = {};
    this.info = {};
    this.disk = null;
    this.active = store.get('tab', 'local');
    this.focused = 'local';
    this.dragSide = null;
    this.installPrompt = null;
  }

  get site() { return this.sites.find((s) => s.id === this.siteId) || null; }
  pane(side) { return side === 'local' ? this.local : this.remote; }

  // ---------- Démarrage ----------
  async boot() {
    applyTheme(store.get('theme', 'auto'));
    setUnauthorizedHandler(() => { if (!this.authShown) location.reload(); });
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); this.installPrompt = e; });
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    let state;
    try { state = await get('auth/state'); } catch (e) {
      document.body.append(h('div.auth', h('div.auth-card', h('h1', 'SFTPad'), h('p.error', e.message), h('button.btn.primary', { onclick: () => location.reload() }, 'Réessayer'))));
      return;
    }
    if (!state.authed) return this.showAuth(state.needsSetup);
    this.start();
  }

  showAuth(setup) {
    this.authShown = true;
    const box = $('#auth');
    box.hidden = false;
    $('#auth-sub').textContent = setup ? 'Première utilisation : choisissez un mot de passe administrateur.' : 'Connexion';
    $('#auth-pw2-wrap').hidden = !setup;
    $('#auth-btn').textContent = setup ? 'Créer et continuer' : 'Se connecter';
    $('#auth-pw').autocomplete = setup ? 'new-password' : 'current-password';
    setTimeout(() => $('#auth-pw').focus(), 50);
    $('#auth-form').onsubmit = async (e) => {
      e.preventDefault();
      const err = $('#auth-err');
      err.hidden = true;
      const pw = $('#auth-pw').value;
      try {
        if (setup) {
          if (pw !== $('#auth-pw2').value) throw new Error('Les mots de passe ne correspondent pas');
          await post('auth/setup', { password: pw });
        } else await post('auth/login', { password: pw, remember: true });
        box.hidden = true;
        this.authShown = false;
        this.start();
      } catch (ex) { err.textContent = ex.message; err.hidden = false; vibrate(30); }
    };
  }

  async start() {
    $('#app').hidden = false;
    this.local = new Pane('local', $('#pane-local'), this);
    this.remote = new Pane('remote', $('#pane-remote'), this);
    this.queue = new Queue(this);
    this.bindChrome();
    this.setTab(this.active);
    try {
      this.info = await get('info');
      this.settings = this.info.settings;
      this.disk = this.info.disk;
      this.sites = await get('sites');
    } catch (e) { errToast(e); }
    this.local.load(store.get('local.path', '/'));
    const last = store.get('site', null);
    if (last && this.sites.some((s) => s.id === last)) this.connect(last, { switchTab: false });
    else { this.selectSite(null); if (!this.sites.length) setTimeout(() => this.openSites(), 400); }
    this.ws = connectWS((m) => this.onWS(m), (on) => this.setOnline(on));
    setInterval(() => get('info').then((i) => { this.disk = i.disk; this.local.updateFoot(); }).catch(() => {}), 60000);
  }

  bindChrome() {
    $('#site-btn').addEventListener('click', () => this.openSites());
    $('#settings-btn').addEventListener('click', () => this.openSettings());
    $$('#tabs button').forEach((b) => b.addEventListener('click', () => this.setTab(b.dataset.pane)));
    const sb = $('#selbar');
    sb.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const p = this.selPane();
      if (!p) return;
      const act = b.dataset.act;
      if (act === 'sel-cancel') p.clearSel();
      else if (act === 'sel-all') p.selectAll();
      else if (act === 'sel-delete') p.remove([...p.sel]);
      else if (act === 'sel-transfer') this.transfer(p, [...p.sel]);
      else if (act === 'sel-more') this.selMenu(e);
    });
    $('#file-input').addEventListener('change', (e) => this.onPicked(e.target));
    $('#folder-input').addEventListener('change', (e) => this.onPicked(e.target));
    // Empêche le navigateur d'ouvrir un fichier lâché hors d'un panneau.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea, select') || $('#layer').children.length) return;
      if (e.key === 'Tab' && isWide()) { e.preventDefault(); this.focusPane(this.focused === 'local' ? 'remote' : 'local', true); }
    });
  }

  setTab(side) {
    this.active = side;
    store.set('tab', side);
    $('#panes').dataset.active = side;
    $('#tabs').dataset.active = side;
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.pane === side));
    this.focusPane(side);
  }

  focusPane(side, kbd) {
    this.focused = side;
    this.local.root.classList.toggle('focus', side === 'local');
    this.remote.root.classList.toggle('focus', side === 'remote');
    if (kbd) this.pane(side).wrap.focus();
  }

  setOnline(on) {
    let bar = $('.offline');
    if (on) { if (bar) bar.remove(); if (this.wasOffline) { this.local.refresh(true); if (this.connected) this.remote.refresh(true); } this.wasOffline = false; return; }
    this.wasOffline = true;
    if (!bar) document.body.append(h('div.offline', 'Connexion au serveur SFTPad perdue — reconnexion…'));
  }

  // ---------- WebSocket ----------
  onWS(m) {
    if (m.type === 'queue') this.queue.setAll(m.jobs, m.paused);
    else if (m.type === 'jobs') this.queue.update(m.jobs);
    else if (m.type === 'paused') this.queue.setPaused(m.paused);
    else if (m.type === 'siteStatus') { if (m.siteId === this.siteId) this.updateTop(m.status === 'connected'); }
    else if (m.type === 'dirChanged') this.dirChanged(m);
  }

  dirChanged(m) {
    this._pending = this._pending || new Set();
    const p = m.side === 'local' ? this.local : this.remote;
    if (m.side === 'remote' && m.siteId !== this.siteId) return;
    if (p.path !== m.path) return;
    this._pending.add(m.side);
    this._flushDir = this._flushDir || debounce(() => {
      for (const side of this._pending) this.pane(side).refresh(true);
      this._pending.clear();
    }, 700);
    this._flushDir();
  }

  onJobError(j) {
    const now = Date.now();
    if (this._lastErr && now - this._lastErr < 4000) return;
    this._lastErr = now;
    toast(`Échec du transfert « ${j.name} » : ${j.error}`, 'err');
  }

  // ---------- Sites & connexion ----------
  async reloadSites() {
    this.sites = await get('sites');
    this.updateTop();
  }

  openSites() { sitesSheet(this); }

  selectSite(id) {
    this.siteId = id;
    this.connected = false;
    store.set('site', id);
    this.remote.path = null;
    this.remote.scrollMemo.clear();
    this.updateTop();
    this.remote.renderDisconnected();
    this.updateSelBar();
  }

  updateTop(live) {
    const s = this.site;
    const dot = $('#site-dot');
    $('#site-name').textContent = s ? s.name : 'Aucun site';
    dot.style.background = '';
    dot.className = `site-dot${this.connecting ? ' busy' : this.connected ? ' on' : ''}`;
    if (s && this.connected && live === false) dot.className = 'site-dot';
    $('#site-sub').textContent = !s ? 'Toucher pour choisir un serveur'
      : this.connecting ? 'Connexion…'
        : this.connected ? `${s.username}@${s.host}${live === false ? ' · en veille' : ''}` : 'Déconnecté';
    const tab = $('#tabs button[data-pane="remote"]');
    tab.lastChild.textContent = ` ${s ? s.name : 'Distant'}`;
  }

  async connect(id, { switchTab = true } = {}) {
    if (this.connecting) return;
    if (id !== this.siteId) this.selectSite(id);
    const s = this.site;
    if (!s) return;
    this.connecting = true;
    this.updateTop();
    this.remote.setLoading(true);
    try {
      const r = await post(`remote/${id}/connect`);
      this.connected = true;
      this.remoteStart = r.start;
      const saved = store.get(`remote.path.${id}`, null);
      await this.remote.load(saved || r.start);
      if (this.remote.error && saved) await this.remote.load(r.start);
      if (s.localDir && s.localDir !== '/' && this._lastLocalSite !== id) this.local.load(s.localDir);
      this._lastLocalSite = id;
      if (switchTab && !isWide()) this.setTab('remote');
    } catch (e) {
      this.connected = false;
      await this.handleRemoteError(e, () => this.connect(id));
    } finally {
      this.connecting = false;
      this.remote.setLoading(false);
      this.updateTop();
      if (!this.connected) this.remote.renderDisconnected();
      this.updateSelBar();
    }
  }

  disconnect() {
    if (!this.siteId) return;
    post(`remote/${this.siteId}/disconnect`).catch(() => {});
    this.connected = false;
    this.remote.path = null;
    this.updateTop();
    this.remote.renderDisconnected();
    this.updateSelBar();
  }

  async handleRemoteError(e, retry) {
    const s = this.site;
    if (e.code === 'HOSTKEY_UNKNOWN' && s) {
      const ok = await confirm({
        title: 'Nouveau serveur',
        message: h('div.form',
          h('p', { style: { margin: 0 } }, `Première connexion à ${s.host}:${s.port}. Vérifiez que l'empreinte de la clé d'hôte correspond bien à celle de votre serveur :`),
          h('div.callout', h('small.muted', e.data.type), h('p.mono', { style: { margin: '4px 0 0' } }, e.data.fingerprint)),
          h('p.muted', { style: { margin: 0, fontSize: '13px' } }, 'Sur le serveur : ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub')),
        ok: 'Faire confiance',
      });
      if (!ok) return;
      await post(`remote/${s.id}/trust`, { fingerprint: e.data.fingerprint });
      await this.reloadSites();
      this.connecting = false;
      return retry && retry();
    }
    if (e.code === 'HOSTKEY_MISMATCH' && s) {
      const ok = await confirm({
        title: "⚠ Clé d'hôte modifiée",
        message: h('div.form',
          h('div.callout.danger', h('b', "La clé d'hôte de ce serveur a changé."), h('p', { style: { margin: '6px 0 0' } }, "Cela arrive après une réinstallation du serveur… ou lors d'une attaque de l'homme du milieu. Ne continuez que si vous savez pourquoi.")),
          h('dl.kv', h('dt', 'Connue'), h('dd.mono', e.data.known), h('dt', 'Reçue'), h('dd.mono', e.data.fingerprint))),
        ok: 'Remplacer la clé',
        danger: true,
      });
      if (!ok) return;
      await post(`remote/${s.id}/trust`, { fingerprint: e.data.fingerprint });
      await this.reloadSites();
      this.connecting = false;
      return retry && retry();
    }
    if (e.code === 'AUTH' && s) {
      toast(`${s.name} : ${e.message}. Vérifiez l'identifiant et le mot de passe ou la clé.`, 'err');
      return;
    }
    errToast(e);
  }

  // ---------- Sélection ----------
  selPane() { return this.local.sel.size ? this.local : this.remote.sel.size ? this.remote : null; }

  updateSelBar() {
    const p = this.selPane();
    const bar = $('#selbar');
    bar.hidden = !p;
    if (!p) return;
    $('#selcount').textContent = `${p.sel.size}`;
    const btn = $('#sel-transfer');
    btn.querySelector('span').textContent = p.isLocal ? 'Envoyer' : 'Télécharger';
    btn.querySelector('use').setAttribute('href', p.isLocal ? '#i-send' : '#i-receive');
    btn.disabled = !p.other.ready;
    btn.title = p.other.ready ? `Vers ${p.other.path}` : 'Connectez-vous à un serveur';
  }

  selMenu(e) {
    const p = this.selPane();
    if (!p) return;
    const names = [...p.sel];
    const one = names.length === 1 ? names[0] : null;
    const hasFiles = names.some((n) => p.entry(n)?.type === 'file');
    const isCtx = e && e.type === 'contextmenu';
    const r = !isCtx && e && e.target.closest ? e.target.closest('button').getBoundingClientRect() : null;
    menu([
      { label: p.isLocal ? 'Envoyer sur le serveur' : 'Télécharger en local', icon: p.isLocal ? 'send' : 'receive', primary: true, disabled: !p.other.ready, action: () => this.transfer(p, names) },
      { label: 'Transférer avec options…', icon: 'queue', disabled: !p.other.ready, action: () => this.transfer(p, names, null, true) },
      hasFiles ? { label: "Enregistrer sur l'appareil", icon: 'phone', action: () => p.toDevice(names) } : null,
      '-',
      one ? { label: 'Renommer', icon: 'edit', action: () => p.rename(one) } : null,
      { label: 'Déplacer…', icon: 'receive', action: () => p.move(names) },
      { label: 'Permissions', icon: 'lock', action: () => p.chmod(names) },
      { label: 'Inverser la sélection', icon: 'selectall', action: () => p.invertSel() },
      '-',
      { label: `Supprimer (${names.length})`, icon: 'trash', danger: true, action: () => p.remove(names) },
    ], { x: isCtx ? e.clientX : r ? r.left : undefined, y: isCtx ? e.clientY : r ? r.top - 330 : undefined });
  }

  // ---------- Transferts ----------
  async transfer(from, names, targetDir, ask = false) {
    const to = from.other;
    if (!to.ready || !to.path) { toast(from.isLocal ? 'Connectez-vous d\'abord à un serveur' : 'Panneau local indisponible', 'err'); return; }
    const dir = targetDir || to.path;
    const entries = names.map((n) => from.entry(n)).filter(Boolean);
    if (!entries.length) return;
    let onExists = this.settings.onExists || 'resume';
    const clashes = dir === to.path ? entries.filter((e) => to.entry(e.name)) : [];
    if (ask || clashes.length) {
      const msg = clashes.length
        ? `${clashes.length === 1 ? `« ${clashes[0].name} » existe déjà` : `${clashes.length} éléments existent déjà`} dans ${dir}. Pour les fichiers déjà présents :`
        : `Destination : ${dir}. Si un fichier existe déjà :`;
      const v = await choose({ title: 'Fichiers existants', message: msg, options: ON_EXISTS, value: onExists, ok: 'Transférer' });
      if (!v) return;
      onExists = v;
    }
    const body = {
      siteId: this.siteId,
      dir: from.isLocal ? 'up' : 'down',
      onExists,
      items: entries.map((e) => ({ src: pjoin(from.path, e.name), dst: pjoin(dir, e.name), kind: e.type === 'dir' ? 'dir' : 'file', size: e.size })),
    };
    try {
      await post('transfers', body);
      vibrate(10);
      const n = entries.length;
      toast(`${n > 1 ? n + ' éléments' : '« ' + entries[0].name + ' »'} ${from.isLocal ? '→ serveur' : '→ local'} : ${dir}`);
      from.clearSel();
    } catch (e) { errToast(e); }
  }

  // ---------- Envois depuis l'appareil ----------
  pickDeviceFiles(pane, folder = false) {
    if (!pane.ready) return;
    this.pickTarget = pane;
    const input = folder ? $('#folder-input') : $('#file-input');
    input.value = '';
    input.click();
  }

  onPicked(input) {
    const pane = this.pickTarget;
    const files = [...input.files].map((f) => ({ file: f, rel: f.webkitRelativePath || f.name }));
    if (pane && files.length) this.uploadFromDevice(pane, files, pane.path);
  }

  async uploadFromDevice(pane, files, dir) {
    const total = files.reduce((a, f) => a + f.file.size, 0);
    const url = pane.isLocal ? `local/upload?${qs({ path: dir })}` : `remote/${this.siteId}/upload?${qs({ path: dir })}`;
    const name = files.length === 1 ? files[0].rel : `${files.length} fichiers`;
    const job = this.queue.addDevice({ id: 'dev-' + Math.random().toString(36).slice(2), device: true, name, dst: dir, size: total, done: 0, speed: 0, status: 'running', createdAt: Date.now() });
    let lock = null;
    try { lock = await navigator.wakeLock?.request('screen'); } catch { /* */ }
    let lastT = performance.now(); let lastB = 0;
    const req = uploadFiles(url, files, (loaded) => {
      job.done = loaded;
      const now = performance.now();
      if (now - lastT > 800) { const inst = ((loaded - lastB) * 1000) / (now - lastT); job.speed = job.speed ? job.speed * 0.6 + inst * 0.4 : inst; lastT = now; lastB = loaded; }
      this.queue.changed();
    });
    job.abort = () => req.abort();
    toast(`Envoi de ${name} (${size(total)}) vers ${dir}`);
    try {
      await req;
      job.status = 'done';
      job.done = total;
      toast(`${name} envoyé${files.length > 1 ? 's' : ''}`, 'ok');
      if (pane.path === dir) pane.refresh(true);
    } catch (e) {
      job.status = e.status === 499 ? 'canceled' : 'error';
      job.error = e.message;
      if (e.status !== 499) errToast(e);
    } finally {
      job.speed = 0;
      job.finishedAt = Date.now();
      job.abort = null;
      try { lock && lock.release(); } catch { /* */ }
      this.queue.changed();
    }
  }

  // ---------- Réglages ----------
  openSettings() {
    const s = this.settings;
    const conc = h('select', [1, 2, 3, 4, 5, 6, 8, 10].map((n) => h('option', { value: n, selected: Number(s.concurrency) === n }, String(n))));
    const onEx = h('select', ON_EXISTS.map((o) => h('option', { value: o.value, selected: s.onExists === o.value }, o.label)));
    const mode = h('input', { value: s.localFileMode || '', placeholder: 'par défaut (umask)', inputmode: 'numeric', maxlength: 4 });
    const theme = store.get('theme', 'auto');
    const seg = h('div.seg', [['auto', 'Auto'], ['light', 'Clair'], ['dark', 'Sombre']].map(([v, l]) => h('button', {
      type: 'button', class: theme === v ? 'on' : '',
      onclick: (e) => { store.set('theme', v); applyTheme(v); [...seg.children].forEach((b) => b.classList.toggle('on', b === e.currentTarget)); },
    }, l)));
    const saveSettings = async () => {
      try {
        this.settings = await put('settings', { concurrency: conc.value, onExists: onEx.value, localFileMode: mode.value });
        toast('Réglages enregistrés', 'ok');
      } catch (e) { errToast(e); }
    };
    [conc, onEx].forEach((x) => x.addEventListener('change', saveSettings));
    mode.addEventListener('change', saveSettings);
    const disk = this.disk;
    const body = h('div.form',
      h('h4', 'Transferts'),
      h('label.field', h('span', 'Transferts simultanés'), conc),
      h('label.field', h('span', 'Si le fichier existe déjà'), onEx),
      h('label.field', h('span', 'Permissions des fichiers créés en local'), mode, h('span.hint', 'Octal, ex. 664. Laisser vide pour le comportement par défaut.')),
      h('h4', 'Affichage'),
      seg,
      this.installPrompt ? h('button.btn', { onclick: async () => { this.installPrompt.prompt(); this.installPrompt = null; } }, icon('download', 'sm'), "Installer l'application") : null,
      h('h4', 'Sécurité'),
      this.info.authDisabled ? h('p.callout.warn', { style: { margin: 0 } }, 'Authentification intégrée désactivée (AUTH=none) : l\'accès doit être protégé par votre reverse proxy.')
        : this.info.envPassword ? h('p.muted', { style: { margin: 0 } }, 'Mot de passe défini par la variable ADMIN_PASSWORD.')
          : h('button.btn', { onclick: () => changePassword() }, icon('key', 'sm'), 'Changer le mot de passe'),
      !this.info.authDisabled ? h('button.btn', { style: { color: 'var(--danger)' }, onclick: async () => { await post('auth/logout'); location.reload(); } }, icon('logout', 'sm'), 'Se déconnecter de SFTPad') : null,
      h('h4', 'À propos'),
      h('dl.kv',
        h('dt', 'Version'), h('dd', this.info.version || ''),
        h('dt', 'Stockage local'), h('dd.mono', this.info.dataDir || ''),
        h('dt', 'Utilisateur'), h('dd.mono', this.info.runAs || ''),
        disk ? h('dt', 'Espace libre') : null, disk ? h('dd', `${size(disk.free)} sur ${size(disk.total)}`) : null));
    sheet({ title: 'Réglages', body });
  }
}

function changePassword() {
  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const nx = h('input', { type: 'password', autocomplete: 'new-password' });
  const nx2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const err = h('p.error', { hidden: true });
  const s = sheet({
    title: 'Changer le mot de passe',
    body: h('form.form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      h('label.field', h('span', 'Mot de passe actuel'), cur),
      h('label.field', h('span', 'Nouveau mot de passe (8 caractères min.)'), nx),
      h('label.field', h('span', 'Confirmer'), nx2), err),
    foot: [h('button.btn', { onclick: () => s.close() }, 'Annuler'), h('button.btn.primary', { onclick: () => go() }, 'Changer')],
  });
  async function go() {
    err.hidden = true;
    if (nx.value !== nx2.value) { err.textContent = 'Les mots de passe ne correspondent pas'; err.hidden = false; return; }
    try { await post('auth/password', { current: cur.value, next: nx.value }); s.close(); toast('Mot de passe modifié. Les autres appareils sont déconnectés.', 'ok'); } catch (e) { err.textContent = e.message; err.hidden = false; }
  }
}

function applyTheme(v) {
  if (v === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = v;
  const dark = v === 'dark' || (v === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  $$('meta[name="theme-color"]').forEach((m) => { m.content = dark ? '#121b25' : '#ffffff'; m.removeAttribute('media'); });
}

window.sftpad = new App();
window.sftpad.boot();
void editSite;
