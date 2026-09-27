'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const Busboy = require('busboy');
const { WebSocketServer } = require('ws');
const { utils: sshUtils } = require('ssh2');

const store = require('./store');
const cr = require('./crypto');
const localfs = require('./localfs');
const { HttpError } = localfs;
const { SftpManager, sftpErr, promisify: p } = require('./sftp');
const { TransferQueue, ON_EXISTS } = require('./transfers');
const fastio = require('./fastio');
const pkg = require('../package.json');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const AUTH_DISABLED = /^(none|off|false|0)$/i.test(process.env.AUTH || '');
const COOKIE = 'sftpad_sid';
const SESSION_DAYS = 30;

store.ensureDir();
cr.key();

// ---------- État persistant ----------
const config = new store.JsonDoc('config.json', { passwordHash: null, settings: {} });
const sitesDoc = new store.JsonDoc('sites.json', { sites: [] });
const sessionsDoc = new store.JsonDoc('sessions.json', { sessions: {} });

const DEFAULT_SETTINGS = { concurrency: 2, onExists: 'resume', localFileMode: '' };
const settings = () => ({ ...DEFAULT_SETTINGS, ...(config.data.settings || {}) });

const envPasswordHash = process.env.ADMIN_PASSWORD ? cr.hashPassword(process.env.ADMIN_PASSWORD) : null;
const passwordHash = () => envPasswordHash || config.data.passwordHash;

const getSite = (id) => sitesDoc.data.sites.find((s) => s.id === id);

const sftp = new SftpManager(getSite);
const queue = new TransferQueue({ sftp, getSite, getSettings: settings });

// ---------- Sessions ----------
const hashTok = (t) => crypto.createHash('sha256').update(t).digest('hex');
function createSession(res, req, remember) {
  const tok = cr.token();
  const exp = Date.now() + (remember ? SESSION_DAYS : 1) * 86400e3;
  sessionsDoc.data.sessions[hashTok(tok)] = { exp, ua: String(req.headers['user-agent'] || '').slice(0, 120), created: Date.now() };
  sessionsDoc.save(true);
  res.cookie(COOKIE, tok, {
    httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/',
    ...(remember ? { maxAge: SESSION_DAYS * 86400e3 } : {}),
  });
}
function sessionValid(tok) {
  if (AUTH_DISABLED) return true;
  if (!tok) return false;
  const s = sessionsDoc.data.sessions[hashTok(tok)];
  if (!s) return false;
  if (s.exp < Date.now()) { delete sessionsDoc.data.sessions[hashTok(tok)]; sessionsDoc.save(); return false; }
  return true;
}
function pruneSessions() {
  const now = Date.now();
  for (const [k, s] of Object.entries(sessionsDoc.data.sessions)) if (s.exp < now) delete sessionsDoc.data.sessions[k];
  sessionsDoc.save();
}
setInterval(pruneSessions, 3600e3).unref();

// Anti force brute très simple : délai croissant après des échecs.
const fails = new Map();
function loginThrottle(ip) {
  const f = fails.get(ip);
  if (f && f.until > Date.now()) throw new HttpError(429, `Trop d'essais, réessayez dans ${Math.ceil((f.until - Date.now()) / 1000)} s`);
}
function loginFailed(ip) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) f.until = Date.now() + Math.min(15 * 60e3, 30e3 * 2 ** (f.n - 5));
  fails.set(ip, f);
}

// ---------- App ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY ? (isNaN(process.env.TRUST_PROXY) ? process.env.TRUST_PROXY : Number(process.env.TRUST_PROXY)) : 'loopback, uniquelocal');
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

const api = express.Router();

// Protection CSRF : toute requête d'écriture doit porter l'en-tête X-SFTPad (impossible depuis un autre site sans CORS).
api.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('x-sftpad') !== '1') {
    return next(new HttpError(403, 'En-tête X-SFTPad manquant'));
  }
  next();
});

api.get('/auth/state', (req, res) => {
  res.json({
    authDisabled: AUTH_DISABLED,
    needsSetup: !AUTH_DISABLED && !passwordHash(),
    authed: sessionValid(req.cookies[COOKIE]),
    version: pkg.version,
  });
});

api.post('/auth/setup', (req, res) => {
  if (passwordHash()) throw new HttpError(409, 'Mot de passe déjà défini');
  const pw = String(req.body.password || '');
  if (pw.length < 8) throw new HttpError(400, 'Au moins 8 caractères');
  config.data.passwordHash = cr.hashPassword(pw);
  config.save(true);
  createSession(res, req, true);
  res.json({ ok: true });
});

api.post('/auth/login', (req, res) => {
  const ip = req.ip;
  loginThrottle(ip);
  if (!cr.verifyPassword(String(req.body.password || ''), passwordHash())) {
    loginFailed(ip);
    throw new HttpError(401, 'Mot de passe incorrect');
  }
  fails.delete(ip);
  createSession(res, req, req.body.remember !== false);
  res.json({ ok: true });
});

api.post('/auth/logout', (req, res) => {
  const tok = req.cookies[COOKIE];
  if (tok) { delete sessionsDoc.data.sessions[hashTok(tok)]; sessionsDoc.save(true); }
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

// Tout ce qui suit nécessite d'être connecté.
api.use((req, res, next) => {
  if (!sessionValid(req.cookies[COOKIE])) return next(new HttpError(401, 'Non connecté', 'NOAUTH'));
  next();
});

api.post('/auth/password', (req, res) => {
  if (envPasswordHash) throw new HttpError(400, 'Mot de passe défini par la variable ADMIN_PASSWORD');
  if (!cr.verifyPassword(String(req.body.current || ''), passwordHash())) throw new HttpError(401, 'Mot de passe actuel incorrect');
  const pw = String(req.body.next || '');
  if (pw.length < 8) throw new HttpError(400, 'Au moins 8 caractères');
  config.data.passwordHash = cr.hashPassword(pw);
  sessionsDoc.data.sessions = {};
  sessionsDoc.save(true);
  config.save(true);
  createSession(res, req, true);
  res.json({ ok: true });
});

api.get('/info', async (req, res) => {
  res.json({ version: pkg.version, runAs: localfs.whoami(), dataDir: localfs.DATA_DIR, disk: await localfs.diskInfo(), settings: settings(), authDisabled: AUTH_DISABLED, envPassword: !!envPasswordHash });
});

api.put('/settings', (req, res) => {
  const s = { ...settings() };
  const b = req.body || {};
  if (b.concurrency != null) s.concurrency = Math.max(1, Math.min(10, parseInt(b.concurrency, 10) || 2));
  if (b.onExists != null && ON_EXISTS.includes(b.onExists)) s.onExists = b.onExists;
  if (b.localFileMode != null) {
    const m = String(b.localFileMode).trim();
    if (m && !/^[0-7]{3,4}$/.test(m)) throw new HttpError(400, 'Mode octal invalide (ex. 664)');
    s.localFileMode = m;
  }
  config.data.settings = s;
  config.save(true);
  queue.pump();
  res.json(s);
});

// ---------- Sites ----------
function publicSite(s) {
  return {
    id: s.id, name: s.name, host: s.host, port: s.port, username: s.username,
    authType: s.authType, hasPassword: !!s.password, hasKey: !!s.privateKey, hasPassphrase: !!s.passphrase,
    hostKey: s.hostKey || null, remoteDir: s.remoteDir || '', localDir: s.localDir || '/',
    color: s.color || '', status: sftp.status(s.id),
  };
}
function applySite(s, b, isNew) {
  const str = (v, max = 500) => String(v == null ? '' : v).trim().slice(0, max);
  if (b.name != null) s.name = str(b.name, 100);
  const oldTarget = `${s.host}:${s.port}`;
  if (b.host != null) s.host = str(b.host, 255);
  if (b.port != null) s.port = Math.max(1, Math.min(65535, parseInt(b.port, 10) || 22));
  if (b.username != null) s.username = str(b.username, 255);
  if (b.authType != null) s.authType = b.authType === 'key' ? 'key' : 'password';
  if (b.remoteDir != null) s.remoteDir = str(b.remoteDir, 1000);
  if (b.localDir != null) s.localDir = localfs.virt(b.localDir);
  if (b.color != null) s.color = /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '';
  if (b.password) s.password = cr.encrypt(b.password);
  if (b.clearPassword) s.password = null;
  if (b.privateKey) {
    try { const k = sshUtils.parseKey(b.privateKey, b.passphrase || undefined); if (k instanceof Error) throw k; }
    catch (e) { throw new HttpError(400, `Clé privée invalide : ${e.message}`); }
    s.privateKey = cr.encrypt(b.privateKey);
  }
  if (b.passphrase) s.passphrase = cr.encrypt(b.passphrase);
  if (b.clearPassphrase) s.passphrase = null;
  if (!s.name) s.name = s.host;
  if (!s.host) throw new HttpError(400, "L'hôte est obligatoire");
  if (!s.username) throw new HttpError(400, "L'identifiant est obligatoire");
  if (!isNew && oldTarget !== `${s.host}:${s.port}`) s.hostKey = null;
}

api.get('/sites', (req, res) => res.json(sitesDoc.data.sites.map(publicSite)));

api.post('/sites', (req, res) => {
  const s = { id: cr.id(), port: 22, authType: 'password', createdAt: Date.now() };
  applySite(s, req.body || {}, true);
  sitesDoc.data.sites.push(s);
  sitesDoc.save(true);
  res.json(publicSite(s));
});

api.put('/sites/:id', (req, res) => {
  const s = getSite(req.params.id);
  if (!s) throw new HttpError(404, 'Site inconnu');
  const copy = { ...s };
  applySite(copy, req.body || {}, false);
  Object.assign(s, copy);
  sitesDoc.save(true);
  sftp.disconnect(s.id);
  res.json(publicSite(s));
});

api.delete('/sites/:id', (req, res) => {
  sftp.disconnect(req.params.id);
  sitesDoc.data.sites = sitesDoc.data.sites.filter((s) => s.id !== req.params.id);
  sitesDoc.save(true);
  res.json({ ok: true });
});

api.post('/sites/reorder', (req, res) => {
  const order = Array.isArray(req.body.ids) ? req.body.ids : [];
  sitesDoc.data.sites.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  sitesDoc.save(true);
  res.json({ ok: true });
});

api.get('/sites/:id/pubkey', (req, res) => {
  const s = getSite(req.params.id);
  if (!s || !s.privateKey) throw new HttpError(404, 'Pas de clé pour ce site');
  const k = sshUtils.parseKey(cr.decrypt(s.privateKey), cr.decrypt(s.passphrase) || undefined);
  if (k instanceof Error) throw new HttpError(400, k.message);
  const one = Array.isArray(k) ? k[0] : k;
  res.json({ publicKey: `${one.type} ${one.getPublicSSH().toString('base64')} sftpad` });
});

api.post('/keys/generate', (req, res) => {
  const comment = String((req.body && req.body.comment) || 'sftpad').replace(/[^\w@.\-]/g, '').slice(0, 60) || 'sftpad';
  const kp = sshUtils.generateKeyPairSync('ed25519', { comment });
  res.json({ privateKey: kp.private, publicKey: kp.public });
});

// ---------- Distant (SFTP) ----------
const conn = (req) => {
  if (!getSite(req.params.id)) throw new HttpError(404, 'Site inconnu');
  return sftp.get(req.params.id);
};
const rp = (v) => {
  const s = String(v || '');
  if (!s) return '';
  return path.posix.normalize(s);
};

api.post('/remote/:id/connect', async (req, res) => {
  const c = conn(req);
  await c.connect();
  const site = getSite(req.params.id);
  let start = site.remoteDir || c.home;
  if (start && !start.startsWith('/')) start = path.posix.join(c.home, start);
  res.json({ ok: true, home: c.home, start });
});

api.post('/remote/:id/trust', (req, res) => {
  const s = getSite(req.params.id);
  if (!s) throw new HttpError(404, 'Site inconnu');
  const fp = String(req.body.fingerprint || '');
  if (!/^SHA256:[A-Za-z0-9+/]+$/.test(fp)) throw new HttpError(400, 'Empreinte invalide');
  s.hostKey = fp;
  sitesDoc.save(true);
  sftp.disconnect(s.id);
  res.json({ ok: true });
});

api.post('/remote/:id/forget', (req, res) => {
  const s = getSite(req.params.id);
  if (!s) throw new HttpError(404, 'Site inconnu');
  s.hostKey = null;
  sitesDoc.save(true);
  sftp.disconnect(s.id);
  res.json({ ok: true });
});

api.post('/remote/:id/disconnect', (req, res) => {
  sftp.disconnect(req.params.id);
  res.json({ ok: true });
});

api.get('/remote/:id/list', async (req, res) => res.json(await conn(req).list(rp(req.query.path))));
api.post('/remote/:id/mkdir', async (req, res) => { await conn(req).mkdirp(rp(req.body.path)); res.json({ ok: true }); });
api.post('/remote/:id/rename', async (req, res) => { await conn(req).rename(rp(req.body.from), rp(req.body.to)); res.json({ ok: true }); });
api.post('/remote/:id/delete', async (req, res) => {
  const c = conn(req);
  const errors = [];
  for (const t of req.body.paths || []) {
    const x = rp(t);
    if (!x || x === '/') { errors.push(`${t} : refusé`); continue; }
    try { await c.remove(x); } catch (e) { errors.push(`${t} : ${sftpErr(e).message}`); }
  }
  if (errors.length) throw new HttpError(500, errors.join('\n'));
  res.json({ ok: true });
});
api.post('/remote/:id/chmod', async (req, res) => {
  const mode = parseInt(String(req.body.mode), 8);
  if (isNaN(mode) || mode < 0 || mode > 0o7777) throw new HttpError(400, 'Mode invalide');
  const c = conn(req);
  for (const t of req.body.paths || []) await c.chmod(rp(t), mode);
  res.json({ ok: true });
});

function parseRange(h, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(h || '');
  if (!m) return null;
  let start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
  let end = m[1] !== '' && m[2] !== '' ? Number(m[2]) : size - 1;
  if (isNaN(start) || start < 0) start = 0;
  if (end >= size) end = size - 1;
  if (start > end) return false;
  return { start, end };
}

function contentDisposition(name, inline) {
  const safe = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/wav',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', json: 'text/plain; charset=utf-8',
  conf: 'text/plain; charset=utf-8', yml: 'text/plain; charset=utf-8', yaml: 'text/plain; charset=utf-8', ini: 'text/plain; charset=utf-8', sh: 'text/plain; charset=utf-8', nfo: 'text/plain; charset=utf-8', srt: 'text/plain; charset=utf-8',
};
const mimeOf = (name) => MIME[(path.extname(name).slice(1) || '').toLowerCase()] || 'application/octet-stream';

api.get('/remote/:id/download', async (req, res) => {
  const c = conn(req);
  const target = rp(req.query.path);
  const st = await c.stat(target);
  if (st.isDirectory()) throw new HttpError(400, 'Téléchargement de dossier vers l\'appareil non pris en charge (transférez-le côté local)');
  const ch = await c.channel();
  const name = path.posix.basename(target);
  const inline = req.query.inline === '1';
  let start = 0; let end = st.size - 1;
  const range = parseRange(req.headers.range, st.size);
  if (range === false) { ch.end(); res.status(416).setHeader('Content-Range', `bytes */${st.size}`); return res.end(); }
  if (range) { ({ start, end } = range); res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`); }
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', st.size === 0 ? 0 : end - start + 1);
  res.setHeader('Content-Type', inline ? mimeOf(name) : 'application/octet-stream');
  res.setHeader('Content-Disposition', contentDisposition(name, inline));
  if (inline) res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  if (st.size === 0) { ch.end(); return res.end(); }
  const rs = fastio.readStream(ch, target, start, end);
  const done = () => { rs.destroy(); ch.end(); };
  res.on('close', done);
  rs.on('error', (e) => { if (!res.headersSent) res.status(500); res.destroy(e); done(); });
  rs.pipe(res);
});

// ---------- Local (stockage monté) ----------
api.get('/local/list', async (req, res) => res.json(await localfs.list(req.query.path)));
api.post('/local/mkdir', async (req, res) => { await localfs.mkdir(req.body.path); res.json({ ok: true }); });
api.post('/local/rename', async (req, res) => { await localfs.rename(req.body.from, req.body.to); res.json({ ok: true }); });
api.post('/local/delete', async (req, res) => {
  const errors = [];
  for (const t of req.body.paths || []) {
    try { await localfs.remove(t); } catch (e) { errors.push(`${t} : ${e.message}`); }
  }
  if (errors.length) throw new HttpError(500, errors.join('\n'));
  res.json({ ok: true });
});
api.post('/local/chmod', async (req, res) => {
  const mode = parseInt(String(req.body.mode), 8);
  if (isNaN(mode) || mode < 0 || mode > 0o7777) throw new HttpError(400, 'Mode invalide');
  for (const t of req.body.paths || []) await localfs.chmod(t, mode);
  res.json({ ok: true });
});
api.get('/local/download', async (req, res) => {
  const real = localfs.real(req.query.path);
  const st = await fsp.stat(real).catch(localfs.mapErr);
  if (st.isDirectory()) throw new HttpError(400, 'Téléchargement de dossier vers l\'appareil non pris en charge');
  const name = path.basename(real);
  const inline = req.query.inline === '1';
  res.setHeader('Content-Disposition', contentDisposition(name, inline));
  if (inline) res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.sendFile(real, { dotfiles: 'allow', headers: { 'Content-Type': inline ? mimeOf(name) : 'application/octet-stream' } });
});

// Nettoie un chemin relatif envoyé par le navigateur (envoi de dossier) : pas de "..", pas de chemin absolu.
function safeRel(name) {
  const parts = String(name || '').replace(/\\/g, '/').split('/').filter((x) => x && x !== '.' && x !== '..');
  if (!parts.length) throw new HttpError(400, 'Nom de fichier invalide');
  return parts.map((x) => x.replace(/[\x00]/g, '')).join('/');
}

// Envoi depuis l'appareil, en flux (aucun fichier temporaire), vers le local ou le distant.
function handleUpload(req, res, target) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({ headers: req.headers, preservePath: true, limits: { fields: 20, files: 10000 } });
    } catch (e) { return reject(new HttpError(400, e.message)); }
    const tasks = [];
    const saved = [];
    let failed = null;
    bb.on('file', (_field, stream, info) => {
      let rel;
      try { rel = safeRel(info.filename); } catch (e) { stream.resume(); failed = failed || e; return; }
      tasks.push(target(rel, stream).then((name) => saved.push(name)).catch((e) => { stream.resume(); failed = failed || e; }));
    });
    bb.on('error', (e) => reject(new HttpError(400, e.message)));
    bb.on('close', async () => {
      await Promise.all(tasks);
      if (failed) return reject(failed);
      resolve(saved);
    });
    req.on('aborted', () => reject(new HttpError(499, 'Envoi interrompu')));
    req.pipe(bb);
  }).then((saved) => res.json({ ok: true, saved }));
}

api.post('/local/upload', async (req, res) => {
  const base = localfs.virt(req.query.path);
  const policy = req.query.onExists || 'rename';
  await handleUpload(req, res, async (rel, stream) => {
    let v = localfs.virt(path.posix.join(base, rel));
    let real = localfs.real(v);
    await fsp.mkdir(path.dirname(real), { recursive: true }).catch((e) => { throw localfs.explainWrite(e, v); });
    if (fs.existsSync(real)) {
      if (policy === 'skip') { stream.resume(); return null; }
      if (policy === 'rename') {
        const ext = path.extname(real); const b = real.slice(0, real.length - ext.length);
        let i = 1; while (fs.existsSync(`${b} (${i})${ext}`)) i++;
        real = `${b} (${i})${ext}`;
        v = localfs.virt(path.relative(localfs.DATA_DIR, real));
      }
    }
    const tmp = `${real}.sftpad-part`;
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(tmp);
      stream.on('error', reject);
      ws.on('error', (e) => { stream.resume(); reject(e); });
      ws.on('finish', resolve);
      req.on('aborted', () => { ws.destroy(); reject(new HttpError(499, 'Envoi interrompu')); });
      stream.pipe(ws);
    }).catch(async (e) => { await fsp.rm(tmp, { force: true }).catch(() => {}); throw e.code ? localfs.explainWrite(e, v) : e; });
    await fsp.rename(tmp, real);
    if (settings().localFileMode) await fsp.chmod(real, parseInt(settings().localFileMode, 8)).catch(() => {});
    return v;
  });
  wsBroadcast({ type: 'dirChanged', side: 'local', path: base });
});

api.post('/remote/:id/upload', async (req, res) => {
  const c = conn(req);
  const base = rp(req.query.path);
  if (!base) throw new HttpError(400, 'Dossier distant manquant');
  const policy = req.query.onExists || 'rename';
  const ch = await c.channel();
  try {
    await handleUpload(req, res, async (rel, stream) => {
      let dst = path.posix.join(base, rel);
      await c.mkdirp(path.posix.dirname(dst), ch);
      if (await p((cb) => ch.stat(dst, cb)).catch(() => null)) {
        if (policy === 'skip') { stream.resume(); return null; }
        if (policy === 'rename') {
          const ext = path.posix.extname(dst); const b = dst.slice(0, dst.length - ext.length);
          let i = 1; while (await p((cb) => ch.stat(`${b} (${i})${ext}`, cb)).catch(() => null)) i++;
          dst = `${b} (${i})${ext}`;
        }
      }
      await new Promise((resolve, reject) => {
        const ws = ch.createWriteStream(dst);
        stream.on('error', reject);
        ws.on('error', (e) => { stream.resume(); reject(sftpErr(e, dst)); });
        ws.on('close', resolve);
        stream.pipe(ws);
      });
      return dst;
    });
  } finally { ch.end(); }
  wsBroadcast({ type: 'dirChanged', side: 'remote', siteId: req.params.id, path: base });
});

// ---------- Transferts ----------
api.get('/transfers', (req, res) => res.json(queue.list()));
api.post('/transfers', (req, res) => {
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) throw new HttpError(400, 'Aucun élément');
  for (const it of items) {
    if (!it.src || !it.dst) throw new HttpError(400, 'Élément invalide');
    if (b.dir === 'up') localfs.real(it.src); else localfs.real(it.dst);
  }
  res.json({ ids: queue.add(b.siteId, b.dir, items, b.onExists) });
});
api.post('/transfers/cancel', (req, res) => { queue.cancel(req.body.ids || []); res.json({ ok: true }); });
api.post('/transfers/retry', (req, res) => { queue.retry(req.body.ids || []); res.json({ ok: true }); });
api.post('/transfers/remove', (req, res) => { queue.remove(req.body.ids || []); res.json({ ok: true }); });
api.post('/transfers/clear', (req, res) => { queue.clear(req.body.statuses); res.json({ ok: true }); });
api.post('/transfers/pause', (req, res) => { queue.setPaused(!!req.body.paused); res.json({ ok: true, paused: queue.paused }); });

api.use((req, res, next) => next(new HttpError(404, 'Route inconnue')));

app.use('/api', api);

// ---------- Fichiers statiques (PWA) ----------
const PUBLIC = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC, {
  index: 'index.html',
  setHeaders: (res, file) => {
    if (/(sw\.js|index\.html|manifest\.webmanifest)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
  },
}));
app.get('/{*splat}', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

// ---------- Erreurs ----------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500 && !(err instanceof HttpError)) console.error('[erreur]', req.method, req.path, err);
  if (res.headersSent) return res.destroy();
  res.status(status).json({ error: err.message || 'Erreur', code: err.code || null, data: err.data || null });
});

// ---------- WebSocket (progression en temps réel) ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) return socket.destroy();
  const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((x) => x[0]));
  if (!sessionValid(cookies[COOKIE])) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({ type: 'queue', ...queue.list() }));
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000).unref();

function wsBroadcast(msg) {
  const s = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(s);
}
queue.on((evt, data) => {
  if (evt === 'jobs') wsBroadcast({ type: 'jobs', jobs: data });
  else if (evt === 'paused') wsBroadcast({ type: 'paused', paused: data });
  else if (evt === 'dirChanged') wsBroadcast({ type: 'dirChanged', ...data });
});
sftp.on((evt, siteId, status) => { if (evt === 'status') wsBroadcast({ type: 'siteStatus', siteId, status }); });

server.listen(PORT, HOST, () => {
  console.log(`SFTPad ${pkg.version} — http://${HOST}:${PORT}`);
  console.log(`  config : ${store.CONFIG_DIR}`);
  console.log(`  local  : ${localfs.DATA_DIR}`);
  if (AUTH_DISABLED) console.log('  ⚠ authentification désactivée (AUTH=none) : protégez l\'accès via votre reverse proxy');
});

function shutdown() {
  console.log('Arrêt…');
  queue.shutdown();
  for (const d of [config, sitesDoc, sessionsDoc]) d.flush();
  server.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
