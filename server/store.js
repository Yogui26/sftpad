'use strict';
// Persistance JSON simple et atomique dans CONFIG_DIR (/config).
const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.resolve(process.env.CONFIG_DIR || '/config');

function ensureDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function file(name) {
  return path.join(CONFIG_DIR, name);
}

function readJSON(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[store] lecture ${name} impossible:`, e.message);
    return fallback;
  }
}

function writeJSON(name, data) {
  ensureDir();
  const target = file(name);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

// Collection persistée avec écriture différée (évite d'écrire à chaque octet transféré).
class JsonDoc {
  constructor(name, fallback) {
    this.name = name;
    this.data = readJSON(name, fallback);
    this._timer = null;
  }
  save(immediate = false) {
    if (immediate) {
      clearTimeout(this._timer);
      this._timer = null;
      writeJSON(this.name, this.data);
      return;
    }
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      try { writeJSON(this.name, this.data); } catch (e) { console.error('[store]', e.message); }
    }, 1000);
  }
  flush() {
    if (this._timer) this.save(true);
  }
}

module.exports = { CONFIG_DIR, ensureDir, readJSON, writeJSON, JsonDoc, file };
