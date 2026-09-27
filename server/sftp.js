'use strict';
// Gestion des connexions SFTP : une connexion SSH par site, réutilisée pour la navigation,
// avec un canal SFTP dédié par transfert. Vérification de la clé d'hôte façon FileZilla (TOFU).
const crypto = require('crypto');
const path = require('path').posix;
const { Client } = require('ssh2');
const { HttpError } = require('./localfs');
const { decrypt } = require('./crypto');

const IDLE_MS = 10 * 60 * 1000;

function fingerprint(keyBuf) {
  return 'SHA256:' + crypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '');
}

function keyType(keyBuf) {
  try {
    const len = keyBuf.readUInt32BE(0);
    return keyBuf.subarray(4, 4 + len).toString('ascii');
  } catch { return 'inconnu'; }
}

function sftpErr(e, what) {
  if (e instanceof HttpError) return e;
  const code = e && e.code;
  if (code === 2) return new HttpError(404, `${what ? what + ' : ' : ''}fichier ou dossier introuvable`, 'ENOENT');
  if (code === 3) return new HttpError(403, `${what ? what + ' : ' : ''}permission refusée`, 'EACCES');
  if (code === 4) return new HttpError(500, `${what ? what + ' : ' : ''}échec côté serveur (${e.message})`, 'FAILURE');
  if (e && e.level === 'client-authentication') return new HttpError(401, 'Authentification refusée par le serveur', 'AUTH');
  if (e && e.level === 'client-timeout') return new HttpError(504, 'Délai de connexion dépassé', 'TIMEOUT');
  const net = { ECONNREFUSED: 'Connexion refusée', ENOTFOUND: 'Hôte introuvable', EHOSTUNREACH: 'Hôte injoignable', ETIMEDOUT: 'Délai dépassé', ECONNRESET: 'Connexion réinitialisée' };
  if (net[code]) return new HttpError(502, net[code], code);
  return new HttpError(500, (e && e.message) || String(e), code);
}

const p = (fn) => new Promise((res, rej) => fn((err, v) => (err ? rej(err) : res(v))));

class SiteConn {
  constructor(manager, siteId) {
    this.manager = manager;
    this.siteId = siteId;
    this.client = null;
    this.browse = null;
    this.connecting = null;
    this.refs = 0;
    this.lastUse = Date.now();
    this.home = '/';
  }

  touch() { this.lastUse = Date.now(); }

  async connect() {
    if (this.client && this.browse) return this;
    if (this.connecting) return this.connecting;
    this.connecting = this._connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  _connect() {
    const site = this.manager.getSite(this.siteId);
    if (!site) throw new HttpError(404, 'Site inconnu');
    return new Promise((resolve, reject) => {
      const c = new Client();
      let seen = null;
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        c.end();
        reject(err);
      };
      const cfg = {
        host: site.host,
        port: Number(site.port) || 22,
        username: site.username,
        readyTimeout: 20000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 4,
        hostVerifier: (key) => {
          seen = { fingerprint: fingerprint(key), type: keyType(key) };
          // Clé inconnue ou différente : on refuse, l'utilisateur doit valider l'empreinte.
          return site.hostKey === seen.fingerprint;
        },
      };
      try {
        if (site.authType === 'key') {
          cfg.privateKey = decrypt(site.privateKey);
          const pass = decrypt(site.passphrase);
          if (pass) cfg.passphrase = pass;
        } else {
          const pw = decrypt(site.password);
          cfg.password = pw || '';
          cfg.tryKeyboard = true;
        }
      } catch (e) {
        return reject(new HttpError(500, `Impossible de déchiffrer les identifiants : ${e.message}`));
      }
      c.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => {
        finish(prompts.map(() => cfg.password || ''));
      });
      c.on('ready', () => {
        c.sftp(async (err, sftp) => {
          if (err) return fail(sftpErr(err));
          try {
            this.home = await p((cb) => sftp.realpath('.', cb)).catch(() => '/');
          } catch { this.home = '/'; }
          settled = true;
          this.client = c;
          this.browse = sftp;
          sftp.on('close', () => { if (this.browse === sftp) this.browse = null; });
          this.touch();
          this.manager.emit('status', this.siteId, 'connected');
          resolve(this);
        });
      });
      c.on('error', (err) => {
        if (!settled) {
          if (seen && site.hostKey && site.hostKey !== seen.fingerprint) {
            const e = new HttpError(409, "La clé d'hôte du serveur a changé !", 'HOSTKEY_MISMATCH');
            e.data = { ...seen, known: site.hostKey };
            return fail(e);
          }
          if (seen && !site.hostKey) {
            const e = new HttpError(409, "Clé d'hôte inconnue", 'HOSTKEY_UNKNOWN');
            e.data = seen;
            return fail(e);
          }
          return fail(sftpErr(err));
        }
        console.error(`[sftp ${site.name}]`, err.message);
      });
      c.on('close', () => {
        if (this.client === c) {
          this.client = null;
          this.browse = null;
          this.manager.emit('status', this.siteId, 'disconnected');
        }
      });
      try { c.connect(cfg); } catch (e) { fail(sftpErr(e)); }
    });
  }

  async sftp() {
    this.touch();
    await this.connect();
    if (!this.browse) {
      this.browse = await p((cb) => this.client.sftp(cb)).catch((e) => { throw sftpErr(e); });
    }
    return this.browse;
  }

  // Canal SFTP dédié à un transfert (fermer le canal = annuler le transfert).
  async channel() {
    await this.connect();
    this.refs++;
    this.touch();
    try {
      const ch = await p((cb) => this.client.sftp(cb));
      ch.once('close', () => { this.refs = Math.max(0, this.refs - 1); this.touch(); });
      return ch;
    } catch (e) {
      this.refs = Math.max(0, this.refs - 1);
      throw sftpErr(e);
    }
  }

  close() {
    if (this.client) this.client.end();
    this.client = null;
    this.browse = null;
  }

  // ---- Opérations de navigation ----
  async list(dir) {
    const sftp = await this.sftp();
    dir = dir || this.home;
    const items = await p((cb) => sftp.readdir(dir, cb)).catch((e) => { throw sftpErr(e, dir); });
    const entries = await Promise.all(items.map(async (it) => {
      const a = it.attrs;
      let isLink = a.isSymbolicLink();
      let st = a;
      if (isLink) st = await p((cb) => sftp.stat(path.join(dir, it.filename), cb)).catch(() => a);
      return {
        name: it.filename,
        type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : isLink ? 'link' : 'other',
        size: st.isDirectory() ? 0 : st.size,
        mtime: st.mtime * 1000,
        mode: st.mode & 0o7777,
        link: isLink,
        owner: it.longname ? (it.longname.split(/\s+/)[2] || '') : '',
      };
    }));
    return { path: dir, entries: entries.filter((e) => e.name !== '.' && e.name !== '..') };
  }

  async stat(p2) {
    const sftp = await this.sftp();
    return p((cb) => sftp.stat(p2, cb)).catch((e) => { throw sftpErr(e, p2); });
  }

  async exists(p2) {
    try { return await this.stat(p2); } catch (e) { if (e.status === 404) return null; throw e; }
  }

  async mkdirp(dir, sftp) {
    sftp = sftp || await this.sftp();
    const parts = dir.split('/').filter(Boolean);
    let cur = dir.startsWith('/') ? '' : '.';
    for (const part of parts) {
      cur = cur === '' ? '/' + part : cur + '/' + part;
      const st = await p((cb) => sftp.stat(cur, cb)).catch(() => null);
      if (st && st.isDirectory()) continue;
      if (st) throw new HttpError(409, `${cur} existe et n'est pas un dossier`);
      await p((cb) => sftp.mkdir(cur, cb)).catch((e) => { throw sftpErr(e, cur); });
    }
  }

  async rename(from, to) {
    const sftp = await this.sftp();
    if (await this.exists(to)) throw new HttpError(409, 'La destination existe déjà');
    await p((cb) => sftp.rename(from, to, cb)).catch((e) => { throw sftpErr(e, from); });
  }

  async remove(target) {
    const sftp = await this.sftp();
    const st = await p((cb) => sftp.lstat(target, cb)).catch((e) => { throw sftpErr(e, target); });
    if (st.isDirectory()) {
      const items = await p((cb) => sftp.readdir(target, cb)).catch((e) => { throw sftpErr(e, target); });
      for (const it of items) {
        if (it.filename === '.' || it.filename === '..') continue;
        await this.remove(path.join(target, it.filename));
      }
      await p((cb) => sftp.rmdir(target, cb)).catch((e) => { throw sftpErr(e, target); });
    } else {
      await p((cb) => sftp.unlink(target, cb)).catch((e) => { throw sftpErr(e, target); });
    }
  }

  async chmod(target, mode) {
    const sftp = await this.sftp();
    await p((cb) => sftp.chmod(target, mode, cb)).catch((e) => { throw sftpErr(e, target); });
  }
}

class SftpManager {
  constructor(getSite) {
    this.getSite = getSite;
    this.conns = new Map();
    this.listeners = [];
    setInterval(() => this.reap(), 60 * 1000).unref();
  }
  on(fn) { this.listeners.push(fn); }
  emit(...args) { for (const fn of this.listeners) { try { fn(...args); } catch { /* */ } } }

  get(siteId) {
    let c = this.conns.get(siteId);
    if (!c) { c = new SiteConn(this, siteId); this.conns.set(siteId, c); }
    return c;
  }
  status(siteId) {
    const c = this.conns.get(siteId);
    return c && c.client ? 'connected' : 'disconnected';
  }
  disconnect(siteId) {
    const c = this.conns.get(siteId);
    if (c) { c.close(); this.conns.delete(siteId); }
  }
  reap() {
    const now = Date.now();
    for (const [id, c] of this.conns) {
      if (c.client && c.refs === 0 && now - c.lastUse > IDLE_MS) {
        console.log(`[sftp] fermeture de la connexion inactive ${id}`);
        this.disconnect(id);
      }
    }
  }
}

module.exports = { SftpManager, sftpErr, fingerprint, promisify: p };
