// Gestionnaire de sites : liste, création, édition, clés SSH.
import { h, icon } from './util.js';
import { get, post, put, del } from './api.js';
import { sheet, toast, errToast, confirm } from './ui.js';

const COLORS = ['#0b7de0', '#1e9a5a', '#d6363f', '#e08a0b', '#8b4fd6', '#0fa3a3', '#d6428f', '#5c6b7a'];

export async function loadSites() {
  return get('sites');
}

export function sitesSheet(app) {
  const list = h('ul.site-list');
  const render = () => {
    const sites = app.sites;
    if (!sites.length) {
      list.replaceChildren(h('li.empty', { style: { padding: '24px 0' } }, icon('server'), h('h3', 'Aucun site'), h('p', { style: { margin: 0 } }, 'Ajoutez votre premier serveur SFTP.')));
      return;
    }
    list.replaceChildren(...sites.map((s) => {
      const active = app.siteId === s.id;
      const connected = active && app.connected;
      return h('li.site-item', { class: `site-item${active ? ' active' : ''}` },
        h('button.main', { onclick: () => { sh.close(); app.connect(s.id); } },
          h('span.sw', { style: { background: s.color || COLORS[0] } }, icon('server', 'sm')),
          h('span.info', h('b', s.name, connected ? ' ' : '', connected ? h('span.pill', 'connecté') : null), h('small', `${s.username}@${s.host}${s.port !== 22 ? ':' + s.port : ''}`))),
        connected ? h('button.icon-btn', { 'aria-label': 'Déconnecter', title: 'Déconnecter', onclick: () => { app.disconnect(); render(); } }, icon('logout')) : null,
        h('button.icon-btn', { 'aria-label': 'Modifier', title: 'Modifier', onclick: () => editSite(app, s, render) }, icon('edit')));
    }));
  };
  const sh = sheet({
    title: 'Sites',
    body: list,
    foot: [h('button.btn.primary', { onclick: () => editSite(app, null, render) }, icon('plus', 'sm'), 'Nouveau site')],
  });
  render();
  return sh;
}

export function editSite(app, site, onSaved) {
  const isNew = !site;
  const s = site || { port: 22, authType: 'password', color: COLORS[app.sites.length % COLORS.length], localDir: '/' };
  const f = {};
  const input = (name, attrs = {}) => (f[name] = h('input', { name, value: s[name] ?? '', autocomplete: 'off', autocapitalize: 'off', spellcheck: false, ...attrs }));
  let authType = s.authType || 'password';
  let color = s.color || COLORS[0];
  let genPublic = null;

  const pwField = h('label.field', h('span', 'Mot de passe'),
    input('password', { type: 'password', value: '', placeholder: s.hasPassword ? '•••••••• (enregistré, laisser vide pour garder)' : '', autocomplete: 'new-password' }));
  const keyArea = f.privateKey = h('textarea', { placeholder: s.hasKey ? 'Clé enregistrée — collez-en une autre pour la remplacer' : '-----BEGIN OPENSSH PRIVATE KEY-----\n…', spellcheck: false });
  const pubOut = h('div.callout', { hidden: true });
  const fileBtn = h('input', { type: 'file', hidden: true, onchange: async () => { const file = fileBtn.files[0]; if (file) keyArea.value = await file.text(); } });
  const keyField = h('div.form',
    h('label.field', h('span', 'Clé privée'), keyArea),
    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
      h('button.btn.small', { type: 'button', onclick: () => fileBtn.click() }, icon('upload', 'sm'), 'Importer un fichier'),
      h('button.btn.small', { type: 'button', onclick: generate }, icon('key', 'sm'), 'Générer une clé ed25519'),
      s.hasKey ? h('button.btn.small', { type: 'button', onclick: showPub }, icon('eye', 'sm'), 'Voir la clé publique') : null,
      fileBtn),
    pubOut,
    h('label.field', h('span', 'Phrase secrète (si la clé est protégée)'),
      input('passphrase', { type: 'password', value: '', placeholder: s.hasPassphrase ? '•••••••• (enregistrée)' : 'Aucune', autocomplete: 'new-password' })));

  const seg = h('div.seg', ['password', 'key'].map((t) => h('button', { type: 'button', class: authType === t ? 'on' : '', onclick: () => setAuth(t) }, t === 'password' ? 'Mot de passe' : 'Clé SSH')));
  function setAuth(t) {
    authType = t;
    [...seg.children].forEach((b, i) => b.classList.toggle('on', (i === 0 ? 'password' : 'key') === t));
    pwField.hidden = t !== 'password';
    keyField.hidden = t !== 'key';
  }

  async function generate() {
    try {
      const k = await post('keys/generate', { comment: `sftpad-${(f.name.value || f.host.value || 'site').replace(/\s+/g, '-')}` });
      keyArea.value = k.privateKey;
      f.passphrase.value = '';
      genPublic = k.publicKey;
      renderPub(k.publicKey, true);
    } catch (e) { errToast(e); }
  }
  async function showPub() {
    try { const r = await get(`sites/${s.id}/pubkey`); renderPub(r.publicKey); } catch (e) { errToast(e); }
  }
  function renderPub(pub, fresh) {
    pubOut.hidden = false;
    pubOut.replaceChildren(
      h('b', fresh ? 'Nouvelle clé générée. ' : 'Clé publique : '),
      fresh ? h('span', 'Ajoutez cette ligne dans ~/.ssh/authorized_keys sur le serveur, puis enregistrez le site.') : null,
      h('p.mono', { style: { margin: '8px 0', userSelect: 'all' } }, pub),
      h('button.btn.small', { type: 'button', onclick: () => navigator.clipboard?.writeText(pub).then(() => toast('Clé publique copiée'), () => {}) }, icon('copy', 'sm'), 'Copier'));
  }

  const colors = h('div.colors', COLORS.map((c) => h('button', { type: 'button', style: { background: c }, class: c === color ? 'on' : '', 'aria-label': c, onclick: (e) => { color = c; [...colors.children].forEach((b) => b.classList.toggle('on', b === e.currentTarget)); } })));
  const err = h('p.error', { hidden: true });

  const hostKeyBox = !isNew && s.hostKey ? h('div.callout',
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, icon('lock', 'sm'), h('b', "Clé d'hôte approuvée")),
    h('p.mono', { style: { margin: '6px 0' } }, s.hostKey),
    h('button.btn.small', { type: 'button', onclick: forgetHostKey }, 'Oublier cette clé')) : null;
  async function forgetHostKey() {
    try {
      await post(`remote/${s.id}/forget`);
      toast("Clé d'hôte oubliée : elle vous sera présentée à la prochaine connexion");
      hostKeyBox.remove();
      await app.reloadSites();
    } catch (e) { errToast(e); }
  }

  const form = h('form.form', { onsubmit: (e) => { e.preventDefault(); save(); } },
    h('label.field', h('span', 'Nom'), input('name', { placeholder: 'Mon serveur' })),
    h('div.row2',
      h('label.field', h('span', 'Hôte'), input('host', { placeholder: 'sftp.exemple.fr ou 192.168.1.10', inputmode: 'url', required: true })),
      h('label.field', h('span', 'Port'), input('port', { inputmode: 'numeric' }))),
    h('label.field', h('span', 'Identifiant'), input('username', { placeholder: 'utilisateur', required: true })),
    h('h4', 'Authentification'), seg, pwField, keyField,
    h('h4', 'Dossiers par défaut'),
    h('label.field', h('span', 'Dossier distant'), input('remoteDir', { placeholder: 'Dossier personnel' })),
    h('label.field', h('span', 'Dossier local (dans le stockage monté)'), input('localDir', { placeholder: '/' })),
    h('h4', 'Couleur'), colors,
    hostKeyBox, err);
  setAuth(authType);

  async function save() {
    err.hidden = true;
    const body = {
      name: f.name.value, host: f.host.value, port: f.port.value, username: f.username.value, authType,
      remoteDir: f.remoteDir.value, localDir: f.localDir.value || '/', color,
    };
    if (authType === 'password' && f.password.value) body.password = f.password.value;
    if (authType === 'key') {
      if (keyArea.value.trim()) body.privateKey = keyArea.value.trim() + '\n';
      if (f.passphrase.value) body.passphrase = f.passphrase.value;
      if (!keyArea.value.trim() && !s.hasKey) { err.textContent = 'Une clé privée est requise'; err.hidden = false; return; }
    }
    try {
      const saved = isNew ? await post('sites', body) : await put(`sites/${s.id}`, body);
      await app.reloadSites();
      sh.close();
      onSaved && onSaved();
      toast(isNew ? 'Site ajouté' : 'Site enregistré', 'ok');
      if (isNew) app.connect(saved.id);
      else if (app.siteId === saved.id) app.connect(saved.id);
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  }

  async function remove() {
    if (!await confirm({ title: 'Supprimer le site', message: `Supprimer « ${s.name} » et ses identifiants enregistrés ?`, ok: 'Supprimer', danger: true })) return;
    try {
      await del(`sites/${s.id}`);
      if (app.siteId === s.id) app.selectSite(null);
      await app.reloadSites();
      sh.close();
      onSaved && onSaved();
    } catch (e) { errToast(e); }
  }

  const sh = sheet({
    title: isNew ? 'Nouveau site' : `Modifier « ${s.name} »`,
    body: form,
    foot: [
      !isNew ? h('button.btn', { style: { flex: '0 0 auto', color: 'var(--danger)' }, onclick: remove, 'aria-label': 'Supprimer le site' }, icon('trash', 'sm')) : null,
      h('button.btn', { onclick: () => sh.close() }, 'Annuler'),
      h('button.btn.primary', { onclick: save }, isNew ? 'Ajouter' : 'Enregistrer'),
    ].filter(Boolean),
  });
  void genPublic;
}
