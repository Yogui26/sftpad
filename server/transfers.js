'use strict';
// File d'attente des transferts, persistée dans /config/queue.json.
// Les transferts tournent côté serveur : ils continuent même si le navigateur est fermé.
const fs = require('fs');
const fsp = fs.promises;
const rpath = require('path').posix;
const localfs = require('./localfs');
const { JsonDoc } = require('./store');
const { id: newId } = require('./crypto');
const { sftpErr, promisify: p } = require('./sftp');
const fastio = require('./fastio');

const KEEP_FINISHED = 500;
const MAX_ATTEMPTS = 3;
const ON_EXISTS = ['resume', 'overwrite', 'skip', 'rename', 'newer'];

function uniqueName(name, exists) {
  const ext = rpath.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; i < 10000; i++) {
    const cand = `${base} (${i})${ext}`;
    if (!exists(cand)) return cand;
  }
  return `${base} (${Date.now()})${ext}`;
}

class Aborted extends Error { constructor() { super('Annulé'); this.aborted = true; } }

class TransferQueue {
  constructor({ sftp, getSite, getSettings }) {
    this.sftp = sftp;
    this.getSite = getSite;
    this.getSettings = getSettings;
    this.doc = new JsonDoc('queue.json', { jobs: [], paused: false });
    this.running = new Map(); // id -> { abort }
    this.listeners = [];
    this.dirty = new Set();
    for (const j of this.doc.data.jobs) {
      if (j.status === 'running') j.status = 'queued';
      j.speed = 0;
    }
    setInterval(() => this.flushUpdates(), 400).unref();
    setInterval(() => this.doc.save(), 5000).unref();
    setImmediate(() => this.pump());
  }

  get jobs() { return this.doc.data.jobs; }
  get paused() { return !!this.doc.data.paused; }

  on(fn) { this.listeners.push(fn); }
  emit(evt, data) { for (const fn of this.listeners) { try { fn(evt, data); } catch { /* */ } } }

  changed(job, immediate) {
    this.dirty.add(job.id);
    if (immediate) { this.flushUpdates(); this.doc.save(); }
  }
  flushUpdates() {
    if (!this.dirty.size) return;
    const list = [];
    for (const id of this.dirty) {
      const j = this.jobs.find((x) => x.id === id);
      list.push(j ? this.publicJob(j) : { id, removed: true });
    }
    this.dirty.clear();
    this.emit('jobs', list);
  }
  publicJob(j) {
    const { ...o } = j;
    return o;
  }

  list() {
    return { paused: this.paused, jobs: this.jobs.map((j) => this.publicJob(j)) };
  }

  // items: [{ src, dst, kind, size }]  dir: 'up' (local → distant) | 'down' (distant → local)
  add(siteId, dir, items, onExists) {
    const site = this.getSite(siteId);
    if (!site) throw new localfs.HttpError(404, 'Site inconnu');
    if (!['up', 'down'].includes(dir)) throw new localfs.HttpError(400, 'Sens de transfert invalide');
    onExists = ON_EXISTS.includes(onExists) ? onExists : (this.getSettings().onExists || 'resume');
    // Ignore les doublons d'un transfert déjà en attente ou en cours (même source, même destination).
    const active = new Set(this.jobs.filter((j) => j.status === 'queued' || j.status === 'running').map((j) => `${j.siteId}|${j.dir}|${j.src}|${j.dst}`));
    const created = items
      .map((it) => this.makeJob(site, dir, it, onExists))
      .filter((j) => !active.has(`${j.siteId}|${j.dir}|${j.src}|${j.dst}`));
    if (!created.length) throw new localfs.HttpError(409, 'Ces éléments sont déjà dans la file de transferts');
    this.jobs.push(...created);
    created.forEach((j) => this.changed(j));
    this.changed(created[0] || { id: '_' }, true);
    this.pump();
    return created.map((j) => j.id);
  }

  makeJob(site, dir, it, onExists, parent) {
    const src = dir === 'up' ? localfs.virt(it.src) : it.src;
    const dst = dir === 'up' ? it.dst : localfs.virt(it.dst);
    return {
      id: newId(), siteId: site.id, siteName: site.name, dir,
      src, dst, name: rpath.basename(src) || src,
      kind: it.kind === 'dir' ? 'dir' : 'file',
      size: Number(it.size) || 0, done: 0, speed: 0,
      status: 'queued', error: null, onExists, attempts: 0,
      parent: parent || null, createdAt: Date.now(), startedAt: null, finishedAt: null,
    };
  }

  setPaused(v) {
    this.doc.data.paused = !!v;
    this.doc.save(true);
    this.emit('paused', this.paused);
    if (!v) this.pump();
  }

  cancel(ids) {
    for (const id of ids) {
      const j = this.jobs.find((x) => x.id === id);
      if (!j) continue;
      if (j.status === 'queued' || j.status === 'running') {
        j.status = 'canceled';
        j.finishedAt = Date.now();
        j.speed = 0;
        const r = this.running.get(id);
        if (r) r.abort();
        // Annuler un dossier annule aussi ses éléments en attente.
        for (const c of this.jobs) if (c.parent === id && c.status === 'queued') this.cancel([c.id]);
        this.changed(j);
      }
    }
    this.flushUpdates();
    this.doc.save();
  }

  retry(ids) {
    for (const id of ids) {
      const j = this.jobs.find((x) => x.id === id);
      if (!j || !['error', 'canceled'].includes(j.status)) continue;
      j.status = 'queued';
      j.error = null;
      j.attempts = 0;
      if (j.onExists !== 'skip') j.onExists = 'resume';
      this.changed(j);
    }
    this.flushUpdates();
    this.doc.save();
    this.pump();
  }

  remove(ids) {
    const set = new Set(ids);
    this.cancel(ids);
    this.doc.data.jobs = this.jobs.filter((j) => !set.has(j.id) || j.status === 'running');
    ids.forEach((id) => this.dirty.add(id));
    this.flushUpdates();
    this.doc.save();
  }

  clear(statuses) {
    const st = new Set(statuses && statuses.length ? statuses : ['done', 'skipped', 'canceled', 'error']);
    const removed = this.jobs.filter((j) => st.has(j.status) && j.status !== 'running' && j.status !== 'queued');
    this.doc.data.jobs = this.jobs.filter((j) => !removed.includes(j));
    removed.forEach((j) => this.dirty.add(j.id));
    this.flushUpdates();
    this.doc.save();
  }

  prune() {
    const finished = this.jobs.filter((j) => ['done', 'skipped'].includes(j.status));
    if (finished.length > KEEP_FINISHED) {
      const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED).map((j) => j.id));
      this.doc.data.jobs = this.jobs.filter((j) => !drop.has(j.id));
      drop.forEach((id) => this.dirty.add(id));
    }
  }

  pump() {
    if (this.paused) return;
    const max = Math.max(1, Math.min(10, Number(this.getSettings().concurrency) || 2));
    for (const j of this.jobs) {
      if (this.running.size >= max) break;
      if (j.status !== 'queued' || this.running.has(j.id)) continue;
      if (j.retryAt && j.retryAt > Date.now()) continue;
      this.start(j);
    }
  }

  start(job) {
    let aborted = false;
    const handles = new Set();
    const ctl = {
      abort: () => { aborted = true; for (const h of handles) { try { h(); } catch { /* */ } } },
      onAbort: (fn) => handles.add(fn),
      check: () => { if (aborted) throw new Aborted(); },
      get aborted() { return aborted; },
    };
    this.running.set(job.id, ctl);
    job.status = 'running';
    job.error = null;
    job.startedAt = Date.now();
    job.attempts = (job.attempts || 0) + 1;
    delete job.retryAt;
    this.changed(job, true);

    const run = job.kind === 'dir' ? this.runDir(job, ctl) : this.runFile(job, ctl);
    run.then((result) => {
      if (ctl.aborted) return;
      job.status = result === 'skipped' ? 'skipped' : 'done';
      if (result === 'skipped') job.error = job.error || 'Déjà présent, ignoré';
      if (job.kind === 'file') job.done = job.size;
      this.emit('dirChanged', job.dir === 'up'
        ? { side: 'remote', siteId: job.siteId, path: rpath.dirname(job.dst) }
        : { side: 'local', path: rpath.dirname(job.dst) });
    }).catch((err) => {
      if (ctl.aborted || (err && err.aborted)) return;
      const e = sftpErr(err);
      const transient = [502, 504].includes(e.status) || /No response|Not connected|closed|ECONNRESET/i.test(e.message);
      if (transient) this.sftp.disconnect(job.siteId);
      if (transient && job.attempts < MAX_ATTEMPTS) {
        job.status = 'queued';
        job.error = `Nouvel essai (${job.attempts}/${MAX_ATTEMPTS - 1}) : ${e.message}`;
        if (job.onExists !== 'skip') job.onExists = 'resume';
        job.retryAt = Date.now() + 3000 * job.attempts;
        setTimeout(() => this.pump(), 3000 * job.attempts + 50);
      } else {
        job.status = 'error';
        job.error = e.message;
      }
    }).finally(() => {
      this.running.delete(job.id);
      job.speed = 0;
      if (job.status !== 'queued') job.finishedAt = Date.now();
      this.prune();
      this.changed(job, true);
      this.pump();
    });
  }

  progress(job) {
    let lastT = Date.now();
    let lastB = job.done;
    return (bytes) => {
      job.done = bytes;
      const now = Date.now();
      if (now - lastT >= 1000) {
        const inst = ((bytes - lastB) * 1000) / (now - lastT);
        job.speed = job.speed ? job.speed * 0.6 + inst * 0.4 : inst;
        lastT = now;
        lastB = bytes;
      }
      this.dirty.add(job.id);
    };
  }

  // Décide quoi faire si la destination existe. Retourne { action: 'write'|'skip', start, dst }.
  decide(job, srcSize, srcMtime, dstStat, existsName) {
    if (!dstStat) return { action: 'write', start: 0 };
    if (dstStat.isDirectory && dstStat.isDirectory()) throw new localfs.HttpError(409, 'Un dossier porte déjà ce nom à la destination');
    const dSize = dstStat.size;
    const dMtime = dstStat.mtimeMs != null ? dstStat.mtimeMs : dstStat.mtime * 1000;
    switch (job.onExists) {
      case 'overwrite': return { action: 'write', start: 0 };
      case 'skip': return { action: 'skip' };
      case 'rename': {
        const name = uniqueName(rpath.basename(job.dst), existsName);
        return { action: 'write', start: 0, dst: rpath.join(rpath.dirname(job.dst), name) };
      }
      case 'newer':
        return srcMtime > dMtime + 1000 ? { action: 'write', start: 0 } : { action: 'skip' };
      case 'resume':
      default:
        if (dSize === srcSize) return { action: 'skip' };
        if (dSize < srcSize) return { action: 'write', start: dSize };
        return { action: 'write', start: 0 };
    }
  }

  async runFile(job, ctl) {
    const conn = this.sftp.get(job.siteId);
    const ch = await conn.channel();
    ctl.onAbort(() => ch.end());
    try {
      ctl.check();
      if (job.dir === 'down') return await this.download(job, ctl, ch);
      return await this.upload(job, ctl, ch);
    } finally {
      ch.end();
    }
  }

  async download(job, ctl, ch) {
    const st = await p((cb) => ch.stat(job.src, cb)).catch((e) => { throw sftpErr(e, job.src); });
    if (st.isDirectory()) { job.kind = 'dir'; return this.runDir(job, ctl); }
    job.size = st.size;
    let real = localfs.real(job.dst);
    const dst = await fsp.stat(real).catch(() => null);
    const dirReal = require('path').dirname(real);
    const d = this.decide(job, st.size, st.mtime * 1000, dst, (n) => fs.existsSync(require('path').join(dirReal, n)));
    if (d.action === 'skip') { job.done = job.size; return 'skipped'; }
    if (d.dst) { job.dst = localfs.virt(d.dst); job.name = rpath.basename(job.dst); real = localfs.real(job.dst); job.onExists = 'resume'; }
    await fsp.mkdir(dirReal, { recursive: true }).catch(localfs.mapErr);
    const onProg = this.progress(job);
    job.done = d.start;
    this.changed(job);

    await fastio.download(ch, job.src, real, { start: d.start, size: st.size, onProgress: onProg })
      .catch((e) => { ctl.check(); throw sftpErr(e, job.src); });
    ctl.check();
    const mt = new Date(st.mtime * 1000);
    await fsp.utimes(real, mt, mt).catch(() => {});
    if (this.getSettings().localFileMode) {
      await fsp.chmod(real, parseInt(this.getSettings().localFileMode, 8)).catch(() => {});
    }
    return 'done';
  }

  async upload(job, ctl, ch) {
    const real = localfs.real(job.src);
    const st = await fsp.stat(real).catch(localfs.mapErr);
    if (st.isDirectory()) { job.kind = 'dir'; return this.runDir(job, ctl); }
    job.size = st.size;
    const dst = await p((cb) => ch.stat(job.dst, cb)).catch(() => null);
    const names = new Set();
    if (dst && job.onExists === 'rename') {
      const items = await p((cb) => ch.readdir(rpath.dirname(job.dst), cb)).catch(() => []);
      items.forEach((i) => names.add(i.filename));
    }
    const d = this.decide(job, st.size, st.mtimeMs, dst, (n) => names.has(n));
    if (d.action === 'skip') { job.done = job.size; return 'skipped'; }
    if (d.dst) { job.dst = d.dst; job.name = rpath.basename(d.dst); job.onExists = 'resume'; }
    // Les écritures distantes sont parallèles : on recule d'une fenêtre pour combler d'éventuels trous.
    if (d.start > 0) d.start = Math.max(0, d.start - fastio.WINDOW);
    const conn = this.sftp.get(job.siteId);
    await conn.mkdirp(rpath.dirname(job.dst), ch);
    const onProg = this.progress(job);
    job.done = d.start;
    this.changed(job);

    await fastio.upload(ch, real, job.dst, { start: d.start, size: st.size, onProgress: onProg })
      .catch((e) => { ctl.check(); throw sftpErr(e, job.dst); });
    ctl.check();
    const t = Math.floor(st.mtimeMs / 1000);
    await p((cb) => ch.utimes(job.dst, t, t, cb)).catch(() => {});
    return 'done';
  }

  // Un dossier : on crée la destination puis on ajoute ses éléments à la file, juste après lui.
  async runDir(job, ctl) {
    const site = this.getSite(job.siteId);
    if (!site) throw new localfs.HttpError(404, 'Site supprimé');
    let children = [];
    if (job.dir === 'down') {
      const conn = this.sftp.get(job.siteId);
      const sftp = await conn.sftp();
      const items = await p((cb) => sftp.readdir(job.src, cb)).catch((e) => { throw sftpErr(e, job.src); });
      ctl.check();
      await fsp.mkdir(localfs.real(job.dst), { recursive: true }).catch(localfs.mapErr);
      for (const it of items) {
        if (it.filename === '.' || it.filename === '..') continue;
        let a = it.attrs;
        const src = rpath.join(job.src, it.filename);
        if (a.isSymbolicLink()) a = await p((cb) => sftp.stat(src, cb)).catch(() => null);
        if (!a || (!a.isDirectory() && !a.isFile())) continue;
        children.push({ src, dst: rpath.join(job.dst, it.filename), kind: a.isDirectory() ? 'dir' : 'file', size: a.isDirectory() ? 0 : a.size });
      }
    } else {
      const real = localfs.real(job.src);
      const names = await fsp.readdir(real).catch(localfs.mapErr);
      ctl.check();
      await this.sftp.get(job.siteId).mkdirp(job.dst);
      for (const name of names) {
        const st = await fsp.stat(require('path').join(real, name)).catch(() => null);
        if (!st || (!st.isDirectory() && !st.isFile())) continue;
        children.push({ src: rpath.join(job.src, name), dst: rpath.join(job.dst, name), kind: st.isDirectory() ? 'dir' : 'file', size: st.isDirectory() ? 0 : st.size });
      }
    }
    ctl.check();
    // Fichiers d'abord, puis sous-dossiers, par ordre alphabétique.
    children.sort((a, b) => (a.kind === b.kind ? a.src.localeCompare(b.src) : a.kind === 'file' ? -1 : 1));
    const jobs = children.map((c) => this.makeJob(site, job.dir, c, job.onExists, job.id));
    const idx = this.jobs.indexOf(job);
    this.jobs.splice(idx + 1, 0, ...jobs);
    jobs.forEach((j) => this.changed(j));
    job.size = children.length;
    job.done = children.length;
    return 'done';
  }

  shutdown() {
    for (const [, ctl] of this.running) ctl.abort();
    for (const j of this.jobs) if (j.status === 'running') j.status = 'queued';
    this.doc.save(true);
  }
}

module.exports = { TransferQueue, ON_EXISTS };
