'use strict';
// Traduction des messages renvoyés à l'interface (français / anglais).
// Les clés sont les textes français ; la langue vient de l'en-tête X-SFTPad-Lang de la requête.
// Hors requête (transferts en arrière-plan), on utilise la dernière langue vue.
const { AsyncLocalStorage } = require('async_hooks');

const LANGS = ['fr', 'en'];
const als = new AsyncLocalStorage();
let fallback = 'fr';
let onChange = null;

const EN = {
  // index.js
  "Trop d'essais, réessayez dans {s} s": 'Too many attempts, try again in {s} s',
  'En-tête X-SFTPad manquant': 'Missing X-SFTPad header',
  'Mot de passe déjà défini': 'Password already set',
  'Au moins 8 caractères': 'At least 8 characters',
  'Mot de passe incorrect': 'Incorrect password',
  'Non connecté': 'Not signed in',
  'Mot de passe défini par la variable ADMIN_PASSWORD': 'Password set by the ADMIN_PASSWORD variable',
  'Mot de passe actuel incorrect': 'Current password is incorrect',
  'Mode octal invalide (ex. 664)': 'Invalid octal mode (e.g. 664)',
  'Clé privée invalide : {error}': 'Invalid private key: {error}',
  "L'hôte est obligatoire": 'Host is required',
  "L'identifiant est obligatoire": 'Username is required',
  'Site inconnu': 'Unknown site',
  'Pas de clé pour ce site': 'No key for this site',
  'Empreinte invalide': 'Invalid fingerprint',
  '{path} : refusé': '{path}: refused',
  '{path} : {error}': '{path}: {error}',
  'Mode invalide': 'Invalid mode',
  "Téléchargement de dossier vers l'appareil non pris en charge (transférez-le côté local)": 'Downloading a folder to the device is not supported (transfer it to the local side)',
  "Téléchargement de dossier vers l'appareil non pris en charge": 'Downloading a folder to the device is not supported',
  'Nom de fichier invalide': 'Invalid file name',
  'Envoi interrompu': 'Upload interrupted',
  'Dossier distant manquant': 'Missing remote folder',
  'Aucun élément': 'No items',
  'Élément invalide': 'Invalid item',
  'Route inconnue': 'Unknown route',
  'Erreur': 'Error',
  // sftp.js
  'inconnu': 'unknown',
  '{what}fichier ou dossier introuvable': '{what}no such file or folder',
  '{what}permission refusée': '{what}permission denied',
  '{what}échec côté serveur ({error})': '{what}server-side failure ({error})',
  'Authentification refusée par le serveur': 'Authentication rejected by the server',
  'Délai de connexion dépassé': 'Connection timed out',
  'Connexion refusée': 'Connection refused',
  'Hôte introuvable': 'Host not found',
  'Hôte injoignable': 'Host unreachable',
  'Délai dépassé': 'Timed out',
  'Connexion réinitialisée': 'Connection reset',
  'Impossible de déchiffrer les identifiants : {error}': 'Unable to decrypt the credentials: {error}',
  "La clé d'hôte du serveur a changé !": "The server's host key has changed!",
  "Clé d'hôte inconnue": 'Unknown host key',
  "{path} existe et n'est pas un dossier": '{path} exists and is not a folder',
  'La destination existe déjà': 'The destination already exists',
  // transfers.js
  'Annulé': 'Canceled',
  'Sens de transfert invalide': 'Invalid transfer direction',
  'Ces éléments sont déjà dans la file de transferts': 'These items are already in the transfer queue',
  'Déjà présent, ignoré': 'Already present, skipped',
  'Nouvel essai ({n}/{max}) : {error}': 'Retrying ({n}/{max}): {error}',
  'Un dossier porte déjà ce nom à la destination': 'A folder with this name already exists at the destination',
  'Site supprimé': 'Site deleted',
  // localfs.js
  'Chemin hors du stockage': 'Path is outside the storage',
  'Impossible de supprimer la racine': 'Cannot delete the root',
  'Fichier ou dossier introuvable': 'No such file or folder',
  'Permission refusée': 'Permission denied',
  'Opération non permise': 'Operation not permitted',
  'Existe déjà': 'Already exists',
  'Dossier non vide': 'Folder not empty',
  "N'est pas un dossier": 'Not a folder',
  'Est un dossier': 'Is a folder',
  'Plus de place sur le disque': 'No space left on the disk',
  'Déplacement entre deux volumes impossible, utilisez copier': 'Cannot move between two volumes, use copy instead',
  "Écriture refusée dans « {dir} » du stockage local : SFTPad tourne en tant que {user} et n'a pas le droit d'y écrire. Choisissez un dossier accessible (sur Unraid : un partage, pas la racine de /mnt/user) ou corrigez les droits / PUID-PGID.":
    'Write denied in "{dir}" on local storage: SFTPad runs as {user} and is not allowed to write there. Pick a writable folder (on Unraid: a share, not the root of /mnt/user) or fix the permissions / PUID-PGID.',
  'Plus de place sur le disque ({dir})': 'No space left on the disk ({dir})',
  '« {dir} » est en lecture seule': '"{dir}" is read-only',
  // fastio.js
  'Fin de fichier inattendue (fichier modifié pendant le transfert ?)': 'Unexpected end of file (file modified during the transfer?)',
};

function pick(v) {
  const l = String(v || '').trim().toLowerCase().slice(0, 2);
  return LANGS.includes(l) ? l : null;
}

function current() { return als.getStore() || fallback; }

function tr(key, vars) {
  let s = current() === 'en' ? (EN[key] ?? key) : key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

// Middleware Express : fixe la langue pour toute la durée de la requête.
function middleware(req, res, next) {
  const lang = pick(req.get('x-sftpad-lang'));
  if (lang && lang !== fallback) { fallback = lang; if (onChange) onChange(lang); }
  als.run(lang || fallback, next);
}

function setFallback(lang, cb) {
  fallback = pick(lang) || fallback;
  if (cb) onChange = cb;
}

module.exports = { tr, middleware, setFallback, current, EN, LANGS };
