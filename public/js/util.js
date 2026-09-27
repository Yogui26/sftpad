// Utilitaires de formatage et de chemins.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Création d'éléments : h('div.cls#id', {attrs}, ...enfants)
export function h(tag, attrs, ...kids) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag);
  const el = document.createElement((m && m[1]) || 'div');
  if (m && m[2]) for (const part of m[2].match(/[.#][\w-]+/g)) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

export function icon(name, cls = '') {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('class', `ico ${cls}`.trim());
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(ns, 'use');
  u.setAttribute('href', `#i-${name}`);
  s.append(u);
  return s;
}

const nf1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
export function size(n) {
  if (n == null || isNaN(n)) return '';
  if (n < 1024) return `${n} o`;
  const u = ['Kio', 'Mio', 'Gio', 'Tio', 'Pio'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n < 10 ? nf1.format(n) : nf0.format(n)} ${u[i]}`;
}
export const speed = (b) => (b > 0 ? `${size(Math.round(b))}/s` : '');
export function eta(sec) {
  if (!isFinite(sec) || sec <= 0) return '';
  if (sec < 60) return `${Math.ceil(sec)} s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min ${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  return `${Math.floor(sec / 3600)} h ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`;
}

const dfToday = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
const dfYear = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const dfFull = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const dfLong = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
export function date(ms, long = false) {
  if (!ms) return '';
  const d = new Date(ms);
  if (long) return dfLong.format(d);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `Aujourd'hui ${dfToday.format(d)}`;
  if (d.getFullYear() === now.getFullYear()) return `${dfYear.format(d)} ${dfToday.format(d)}`;
  return dfFull.format(d);
}

export function perms(mode, isDir) {
  if (mode == null) return '';
  const r = (m, s) => (m & 4 ? 'r' : '-') + (m & 2 ? 'w' : '-') + (m & 1 ? (s ? 's' : 'x') : (s ? 'S' : '-'));
  return (isDir ? 'd' : '-') + r(mode >> 6, mode & 0o4000) + r(mode >> 3, mode & 0o2000) + r(mode, false);
}
export const octal = (mode) => (mode & 0o7777).toString(8).padStart(3, '0');

const TYPES = {
  image: 'jpg jpeg png gif webp svg bmp tif tiff heic heif avif ico raw cr2 nef arw dng',
  video: 'mp4 mkv avi mov wmv flv webm m4v mpg mpeg ts m2ts 3gp vob',
  audio: 'mp3 flac wav ogg m4a aac opus wma alac aiff',
  archive: 'zip rar 7z tar gz tgz bz2 xz zst iso img dmg deb rpm apk jar',
  code: 'js mjs ts tsx jsx json py rb php go rs java c h cpp hpp cs sh bash zsh ps1 bat html htm css scss vue svelte sql xml yml yaml toml ini conf cfg env dockerfile lua pl swift kt',
  text: 'txt md log csv nfo srt ass sub rtf readme',
  pdf: 'pdf',
};
const EXT = {};
for (const [t, list] of Object.entries(TYPES)) for (const e of list.split(' ')) EXT[e] = t;
export function ftype(name) {
  const m = /\.([^.]+)$/.exec(name.toLowerCase());
  return (m && EXT[m[1]]) || 'file';
}
export const typeIcon = (t) => ({ image: 'image', video: 'video', audio: 'audio', archive: 'archive', code: 'code', text: 'text', pdf: 'pdf' }[t] || 'file');
export const previewable = (name, sz) => {
  const t = ftype(name);
  return ['image', 'video', 'audio', 'pdf'].includes(t) || ((t === 'text' || t === 'code') && sz < 2 * 1024 * 1024);
};

export const pjoin = (a, b) => (a.endsWith('/') ? a : a + '/') + b;
export const pdir = (p) => { const i = p.replace(/\/+$/, '').lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
export const pbase = (p) => p.replace(/\/+$/, '').split('/').pop() || '/';

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const store = {
  get(k, d) { try { const v = localStorage.getItem('sftpad.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sftpad.' + k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
};

export const vibrate = (ms = 12) => { try { navigator.vibrate && navigator.vibrate(ms); } catch { /* */ } };
export const isTouch = () => matchMedia('(pointer: coarse)').matches;
export const isWide = () => matchMedia('(min-width: 860px)').matches;
