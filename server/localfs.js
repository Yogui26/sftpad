'use strict';
// Côté « local » : le stockage monté dans le conteneur/LXC (DATA_DIR, /data par défaut).
// Tous les chemins exposés à l'interface sont relatifs à DATA_DIR ("/" = racine de DATA_DIR).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data');

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Normalise un chemin virtuel ("/films/../x" → "/x") et refuse toute sortie de DATA_DIR.
function virt(p) {
  const v = path.posix.normalize('/' + String(p || '/').replace(/\\/g, '/'));
  return v.length > 1 && v.endsWith('/') ? v.slice(0, -1) : v;
}

function real(p) {
  const v = virt(p);
  const r = path.join(DATA_DIR, v);
  if (r !== DATA_DIR && !r.startsWith(DATA_DIR + path.sep)) throw new HttpError(400, 'Chemin hors du stockage');
  return r;
}

function entryFromStat(name, st, lst) {
  return {
    name,
    type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
    size: st.isDirectory() ? 0 : st.size,
    mtime: Math.floor(st.mtimeMs),
    mode: (st.mode & 0o7777),
    link: lst ? lst.isSymbolicLink() : false,
  };
}

async function list(p) {
  const dir = real(p);
  const names = await fsp.readdir(dir).catch(mapErr);
  const out = [];
  await Promise.all(names.map(async (name) => {
    const full = path.join(dir, name);
    try {
      const lst = await fsp.lstat(full);
      let st = lst;
      if (lst.isSymbolicLink()) st = await fsp.stat(full).catch(() => lst);
      out.push(entryFromStat(name, st, lst));
    } catch { /* fichier disparu entre-temps */ }
  }));
  return { path: virt(p), entries: out };
}

async function stat(p) {
  const st = await fsp.stat(real(p)).catch(mapErr);
  return entryFromStat(path.posix.basename(virt(p)) || '/', st);
}

async function mkdir(p) {
  await fsp.mkdir(real(p), { recursive: true }).catch(mapErr);
}

async function rename(from, to) {
  const dst = real(to);
  if (fs.existsSync(dst)) throw new HttpError(409, 'La destination existe déjà');
  await fsp.rename(real(from), dst).catch(mapErr);
}

async function remove(p) {
  if (virt(p) === '/') throw new HttpError(400, 'Impossible de supprimer la racine');
  await fsp.rm(real(p), { recursive: true, force: false }).catch(mapErr);
}

async function chmod(p, mode) {
  await fsp.chmod(real(p), mode).catch(mapErr);
}

async function diskInfo() {
  try {
    const s = await fsp.statfs(DATA_DIR);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch { return null; }
}

function mapErr(e) {
  const map = {
    ENOENT: [404, 'Fichier ou dossier introuvable'],
    EACCES: [403, 'Permission refusée'],
    EPERM: [403, 'Opération non permise'],
    EEXIST: [409, 'Existe déjà'],
    ENOTEMPTY: [409, 'Dossier non vide'],
    ENOTDIR: [400, "N'est pas un dossier"],
    EISDIR: [400, 'Est un dossier'],
    ENOSPC: [507, 'Plus de place sur le disque'],
    EXDEV: [400, 'Déplacement entre deux volumes impossible, utilisez copier'],
  };
  const m = map[e.code];
  if (m) throw new HttpError(m[0], m[1], e.code);
  throw e;
}

module.exports = { DATA_DIR, HttpError, virt, real, list, stat, mkdir, rename, remove, chmod, diskInfo, mapErr };
