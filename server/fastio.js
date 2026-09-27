'use strict';
// E/S SFTP en pipeline : plusieurs requêtes en vol pour saturer le lien, avec support de la reprise
// (offset de départ), ce que fastGet/fastPut de ssh2 ne permettent pas.
const { Readable } = require('stream');

const CHUNK = 32768;       // taille sûre pour tous les serveurs SFTP
const CONCURRENCY = 64;    // 64 × 32 Kio = 2 Mio en vol
const WINDOW = CHUNK * CONCURRENCY;

const p = (fn) => new Promise((res, rej) => fn((err, v) => (err ? rej(err) : res(v))));

function remoteReader(ch, handle) {
  return (pos, len) => new Promise((resolve, reject) => {
    ch.read(handle, Buffer.allocUnsafe(len), 0, len, pos, (err, n, buf) => {
      if (err) return err.code === 1 ? resolve(Buffer.alloc(0)) : reject(err); // 1 = EOF
      resolve(buf.subarray(0, n));
    });
  });
}

async function readFull(readAt, pos, len) {
  const parts = [];
  let got = 0;
  while (got < len) {
    const b = await readAt(pos + got, len - got);
    if (!b.length) break;
    parts.push(b);
    got += b.length;
  }
  return parts.length === 1 ? parts[0] : Buffer.concat(parts, got);
}

// Lit [start, end) en parallèle mais restitue les morceaux DANS L'ORDRE.
async function* orderedChunks(readAt, start, end, { chunk = CHUNK, concurrency = CONCURRENCY } = {}) {
  let next = start;
  const q = [];
  const launch = () => {
    while (q.length < concurrency && next < end) {
      const pos = next;
      const len = Math.min(chunk, end - pos);
      next += len;
      const pr = readFull(readAt, pos, len).then((b) => {
        if (b.length < len) throw new Error('Fin de fichier inattendue (fichier modifié pendant le transfert ?)');
        return b;
      });
      pr.catch(() => {}); // évite un rejet non géré si un morceau précédent échoue d'abord
      q.push(pr);
    }
  };
  launch();
  while (q.length) {
    const b = await q.shift();
    launch();
    yield b;
  }
}

// Distant → fichier local (écritures séquentielles : jamais de « trous », la reprise est exacte).
async function download(ch, remotePath, localPath, { start = 0, size, onProgress }) {
  const fsp = require('fs').promises;
  const handle = await p((cb) => ch.open(remotePath, 'r', cb));
  const fd = await fsp.open(localPath, start > 0 ? 'r+' : 'w');
  let pos = start;
  try {
    if (start > 0) await fd.truncate(start);
    // Regroupe les morceaux de 32 Kio en écritures de ~1 Mio (beaucoup moins d'appels système).
    let pending = [];
    let pendingLen = 0;
    let received = start;
    const flush = async () => {
      if (!pendingLen) return;
      const buf = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingLen);
      pending = [];
      pendingLen = 0;
      await fd.write(buf, 0, buf.length, pos);
      pos += buf.length;
    };
    for await (const b of orderedChunks(remoteReader(ch, handle), start, size)) {
      pending.push(b);
      pendingLen += b.length;
      received += b.length;
      if (pendingLen >= 1024 * 1024) await flush();
      onProgress && onProgress(received);
    }
    await flush();
  } finally {
    await fd.close().catch(() => {});
    ch.close(handle, () => {});
  }
}

// Fichier local → distant (écritures distantes parallèles, fenêtre bornée).
// En cas de coupure, seuls les WINDOW derniers octets peuvent être incomplets : la reprise recule d'autant.
async function upload(ch, localPath, remotePath, { start = 0, size, onProgress }) {
  const fsp = require('fs').promises;
  const fd = await fsp.open(localPath, 'r');
  const handle = await p((cb) => ch.open(remotePath, start > 0 ? 'r+' : 'w', cb));
  const inflight = new Set();
  let failed = null;
  let done = start;
  try {
    let pos = start;
    const BLOCK = 1024 * 1024; // lecture locale par blocs de 1 Mio, découpés en requêtes SFTP de 32 Kio
    while (pos < size) {
      if (failed) throw failed;
      const blen = Math.min(BLOCK, size - pos);
      const block = Buffer.allocUnsafe(blen);
      const { bytesRead } = await fd.read(block, 0, blen, pos);
      if (bytesRead < blen) throw new Error('Fin de fichier inattendue (fichier modifié pendant le transfert ?)');
      for (let off = 0; off < blen; off += CHUNK) {
        if (failed) throw failed;
        const len = Math.min(CHUNK, blen - off);
        const at = pos + off;
        const w = p((cb) => ch.write(handle, block, off, len, at, cb)).then(() => {
          done += len;
          onProgress && onProgress(done);
        }, (e) => { failed = failed || e; });
        inflight.add(w);
        w.finally(() => inflight.delete(w));
        if (inflight.size >= CONCURRENCY) await Promise.race(inflight);
      }
      pos += blen;
    }
    await Promise.all(inflight);
    if (failed) throw failed;
    if (start > 0) await p((cb) => ch.fsetstat(handle, { size }, cb)).catch(() => {});
  } finally {
    await fd.close().catch(() => {});
    await new Promise((r) => ch.close(handle, () => r()));
  }
}

// Flux lisible (pour envoyer un fichier distant au navigateur, avec Range).
function readStream(ch, remotePath, start, endIncl) {
  let it = null;
  let handle = null;
  const rs = new Readable({
    highWaterMark: WINDOW,
    async read() {
      try {
        if (!it) {
          handle = await p((cb) => ch.open(remotePath, 'r', cb));
          it = orderedChunks(remoteReader(ch, handle), start, endIncl + 1);
        }
        const { value, done } = await it.next();
        this.push(done ? null : value);
      } catch (e) { this.destroy(e); }
    },
    destroy(err, cb) {
      if (handle) ch.close(handle, () => {});
      cb(err);
    },
  });
  return rs;
}

module.exports = { download, upload, readStream, WINDOW, CHUNK };
