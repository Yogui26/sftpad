// Composants d'interface : toasts, feuilles (bottom sheets), menus, dialogues, visionneuse.
import { h, icon, $, isWide } from './util.js';

const layer = () => $('#layer');

export function toast(msg, type = '', ms = 3200) {
  const t = h('div.toast', { class: `toast ${type}` },
    icon(type === 'err' ? 'x' : type === 'ok' ? 'check' : 'info'), h('span', msg));
  $('#toasts').append(t);
  const close = () => { t.classList.add('out'); setTimeout(() => t.remove(), 220); };
  t.addEventListener('click', close);
  setTimeout(close, type === 'err' ? Math.max(ms, 5000) : ms);
}
export const errToast = (e) => toast(e && e.message ? e.message : String(e), 'err');

// Pile des couches ouvertes, pour que le bouton « retour » d'Android ferme la dernière.
const stack = [];
window.addEventListener('popstate', () => {
  const top = stack[stack.length - 1];
  if (top) top.close(true);
});
function pushLayer(entry) {
  stack.push(entry);
  history.pushState({ layer: stack.length }, '');
}
function popLayer(entry, fromHistory) {
  const i = stack.indexOf(entry);
  if (i === -1) return;
  stack.splice(i, 1);
  if (!fromHistory) history.back();
}
export const hasLayers = () => stack.length > 0;

// Feuille : sur mobile elle monte du bas, sur grand écran c'est une fenêtre centrée.
export function sheet({ title, body, foot, wide = false, onClose, headExtra }) {
  const scrim = h('div.scrim');
  const box = h('div.sheet', { class: `sheet${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
    h('div.grab'),
    h('div.sheet-head', h('h2', title || ''), headExtra || null,
      h('button.icon-btn', { 'aria-label': 'Fermer', onclick: () => api.close() }, icon('x'))),
    h('div.sheet-body', body),
    foot ? h('div.sheet-foot', foot) : null);
  let closed = false;
  const entry = {
    close(fromHistory) {
      if (closed) return;
      closed = true;
      popLayer(entry, fromHistory);
      box.classList.add('closing');
      scrim.style.opacity = '0';
      scrim.style.transition = 'opacity .18s';
      setTimeout(() => { box.remove(); scrim.remove(); }, 190);
      onClose && onClose();
    },
  };
  const api = { el: box, body: box.querySelector('.sheet-body'), close: () => entry.close(false), setTitle: (t) => { box.querySelector('h2').textContent = t; } };
  const opened = Date.now();
  scrim.addEventListener('click', () => { if (Date.now() - opened > 350) api.close(); });
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); api.close(); } });
  enableSwipeDown(box, api.close);
  layer().append(scrim, box);
  pushLayer(entry);
  setTimeout(() => {
    const f = box.querySelector('[autofocus]');
    if (f && !matchMedia('(pointer: coarse)').matches) f.focus();
    else if (f && f.dataset.forcefocus) f.focus();
  }, 60);
  return api;
}

// Glisser la poignée vers le bas pour fermer une feuille (mobile).
function enableSwipeDown(box, close) {
  let y0 = null; let dy = 0;
  const head = () => [box.querySelector('.grab'), box.querySelector('.sheet-head')];
  box.addEventListener('touchstart', (e) => {
    if (isWide() || !head().some((x) => x && x.contains(e.target))) return;
    y0 = e.touches[0].clientY; dy = 0; box.style.transition = 'none';
  }, { passive: true });
  box.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    box.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  box.addEventListener('touchend', () => {
    if (y0 == null) return;
    y0 = null; box.style.transition = ''; box.style.transform = '';
    if (dy > 90) close();
  });
}

// Menu : feuille d'actions sur écran tactile, menu contextuel positionné à la souris.
// items: [{ label, icon, action, danger, primary } | '-']
export function menu(items, { x, y, header } = {}) {
  const list = items.filter(Boolean);
  if (x != null && !matchMedia('(pointer: coarse)').matches) {
    const scrim = h('div', { style: { position: 'fixed', inset: '0', zIndex: 59 } });
    const pop = h('div.popmenu', h('ul.menu-list', list.map((it) => it === '-' ? h('li.menu-sep') : h('li',
      h('button.menu-item', { class: `menu-item${it.danger ? ' danger' : ''}${it.primary ? ' primary' : ''}`, disabled: !!it.disabled, onclick: () => { close(); it.action(); } },
        icon(it.icon || 'chev'), h('span', it.label))))));
    const close = () => { scrim.remove(); pop.remove(); document.removeEventListener('keydown', esc); };
    const esc = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', esc);
    scrim.addEventListener('pointerdown', close);
    scrim.addEventListener('contextmenu', (e) => { e.preventDefault(); close(); });
    layer().append(scrim, pop);
    const r = pop.getBoundingClientRect();
    pop.style.left = `${Math.max(6, Math.min(x, innerWidth - r.width - 6))}px`;
    pop.style.top = `${Math.max(6, Math.min(y, innerHeight - r.height - 6))}px`;
    return;
  }
  let s;
  const body = h('div', header || null, h('ul.menu-list', list.map((it) => it === '-' ? h('li.menu-sep') : h('li',
    h('button.menu-item', { class: `menu-item${it.danger ? ' danger' : ''}${it.primary ? ' primary' : ''}`, disabled: !!it.disabled, onclick: () => { s.close(); setTimeout(it.action, 60); } },
      icon(it.icon || 'chev'), h('span', it.label))))));
  s = sheet({ title: '', body });
  s.el.querySelector('.sheet-body').style.padding = '0';
  s.el.querySelector('.sheet-head').style.display = isWide() ? '' : 'none';
}

export function confirm({ title, message, ok = 'Confirmer', danger = false, cancel = 'Annuler' }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); s.close(); } };
    const s = sheet({
      title,
      body: typeof message === 'string' ? h('p', { style: { margin: 0, whiteSpace: 'pre-wrap' } }, message) : message,
      foot: [
        h('button.btn', { onclick: () => finish(false) }, cancel),
        h('button.btn', { class: `btn ${danger ? 'danger' : 'primary'}`, autofocus: true, onclick: () => finish(true) }, ok),
      ],
      onClose: () => { if (!done) { done = true; resolve(false); } },
    });
  });
}

export function prompt({ title, label, value = '', ok = 'OK', placeholder = '', select = null, validate }) {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { value, placeholder, autocomplete: 'off', autocapitalize: 'off', spellcheck: false, autofocus: true, 'data-forcefocus': '1' });
    const err = h('p.error', { hidden: true });
    const submit = (e) => {
      e && e.preventDefault();
      const v = input.value.trim();
      const msg = validate ? validate(v) : (!v ? 'Valeur requise' : null);
      if (msg) { err.textContent = msg; err.hidden = false; return; }
      done = true; resolve(v); s.close();
    };
    const form = h('form.form', { onsubmit: submit }, h('label.field', h('span', label || ''), input), err);
    const s = sheet({
      title, body: form,
      foot: [h('button.btn', { onclick: () => s.close() }, 'Annuler'), h('button.btn.primary', { onclick: submit }, ok)],
      onClose: () => { if (!done) resolve(null); },
    });
    setTimeout(() => {
      input.focus();
      if (select) input.setSelectionRange(select[0], select[1]); else input.select();
    }, 80);
  });
}

// Choix parmi des options (liste de boutons radio).
export function choose({ title, message, options, ok = 'Continuer', value }) {
  return new Promise((resolve) => {
    let done = false;
    let cur = value || options[0].value;
    const items = options.map((o) => h('label.check', { style: { alignItems: 'flex-start', padding: '6px 0' } },
      h('input', { type: 'radio', name: 'choice', value: o.value, checked: o.value === cur, onchange: () => { cur = o.value; } }),
      h('span', h('b', o.label), o.hint ? h('small.muted', { style: { display: 'block' } }, o.hint) : null)));
    const s = sheet({
      title,
      body: h('div.form', message ? h('p', { style: { margin: 0 } }, message) : null, h('div', items)),
      foot: [h('button.btn', { onclick: () => s.close() }, 'Annuler'), h('button.btn.primary', { onclick: () => { done = true; resolve(cur); s.close(); } }, ok)],
      onClose: () => { if (!done) resolve(null); },
    });
  });
}

// Visionneuse plein écran.
export function viewer({ name, url, kind, download }) {
  const body = h('div.viewer-body');
  const v = h('div.viewer',
    h('div.viewer-head', h('b', name),
      download ? h('button.icon-btn', { 'aria-label': 'Télécharger', onclick: download }, icon('download')) : null,
      h('button.icon-btn', { 'aria-label': 'Fermer', onclick: () => entry.close() }, icon('x'))),
    body);
  let closed = false;
  const entry = {
    close(fromHistory) {
      if (closed) return; closed = true;
      popLayer(entry, fromHistory);
      body.querySelectorAll('video,audio').forEach((m) => { m.pause(); m.src = ''; });
      v.remove();
    },
  };
  if (kind === 'image') body.append(h('img', { src: url, alt: name }));
  else if (kind === 'video') body.append(h('video', { src: url, controls: true, autoplay: true, playsinline: true }));
  else if (kind === 'audio') body.append(h('audio', { src: url, controls: true, autoplay: true }));
  else if (kind === 'pdf') body.append(h('iframe', { src: url, title: name }));
  else {
    const pre = h('pre', 'Chargement…');
    body.append(pre);
    fetch(url).then((r) => r.text()).then((t) => { pre.textContent = t; }).catch((e) => { pre.textContent = e.message; });
  }
  v.addEventListener('keydown', (e) => { if (e.key === 'Escape') entry.close(); });
  layer().append(v);
  pushLayer(entry);
}

// Déclenche un téléchargement vers l'appareil.
export function downloadUrl(url) {
  const a = h('a', { href: url, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}
