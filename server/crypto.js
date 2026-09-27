'use strict';
// Chiffrement des secrets (mots de passe SFTP, clés privées) et hachage du mot de passe admin.
const crypto = require('crypto');
const fs = require('fs');
const { file, ensureDir } = require('./store');

let KEY = null;

function key() {
  if (KEY) return KEY;
  ensureDir();
  const p = file('secret.key');
  try {
    KEY = Buffer.from(fs.readFileSync(p, 'utf8').trim(), 'base64');
    if (KEY.length !== 32) throw new Error('clé invalide');
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`secret.key illisible : ${e.message}`);
    KEY = crypto.randomBytes(32);
    fs.writeFileSync(p, KEY.toString('base64'), { mode: 0o600 });
    console.log(`[crypto] nouvelle clé de chiffrement générée : ${p}`);
  }
  return KEY;
}

function encrypt(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function decrypt(blob) {
  if (!blob) return null;
  if (!blob.startsWith('v1:')) throw new Error('format de secret inconnu');
  const buf = Buffer.from(blob.slice(3), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(pw, stored) {
  if (!stored || typeof pw !== 'string') return false;
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, got);
}

const token = (n = 32) => crypto.randomBytes(n).toString('base64url');
const id = () => crypto.randomBytes(9).toString('base64url');

module.exports = { encrypt, decrypt, hashPassword, verifyPassword, token, id, key };
