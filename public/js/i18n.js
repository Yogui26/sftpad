// Traduction de l'interface (français / anglais).
// Les clés sont les textes français : t('Annuler') renvoie « Cancel » en anglais, la clé telle quelle en français.
// Préférence : « auto » (langue du navigateur), « fr » ou « en », enregistrée sur l'appareil.
const LANGS = ['fr', 'en'];
const KEY = 'sftpad.lang';

export function getLangPref() {
  try { const v = JSON.parse(localStorage.getItem(KEY)); return LANGS.includes(v) ? v : 'auto'; } catch { return 'auto'; }
}

function resolve(pref) {
  if (LANGS.includes(pref)) return pref;
  // Auto : première langue du navigateur qui soit le français ou l'anglais, sinon l'anglais.
  for (const l of navigator.languages || [navigator.language || '']) {
    const short = String(l).slice(0, 2).toLowerCase();
    if (LANGS.includes(short)) return short;
  }
  return 'en';
}

export const lang = resolve(getLangPref());

// Enregistre la préférence ; renvoie true si la langue effective change (il faut alors recharger la page).
export function setLangPref(pref) {
  try { localStorage.setItem(KEY, JSON.stringify(pref)); } catch { /* stockage indisponible */ }
  return resolve(pref) !== lang;
}

// Locale des nombres et des dates : celle du navigateur si elle correspond à la langue choisie.
export const LOCALE = (navigator.languages || []).find((l) => String(l).toLowerCase().startsWith(lang))
  || (lang === 'fr' ? 'fr-FR' : 'en-GB');

const EN = {
  // ----- Écran de connexion, barre du haut -----
  'Connexion': 'Sign in',
  'Première utilisation : choisissez un mot de passe administrateur.': 'First use: choose an administrator password.',
  'Mot de passe': 'Password',
  'Confirmer': 'Confirm',
  'Se connecter': 'Connect',
  'auth|Se connecter': 'Sign in',
  'Créer et continuer': 'Create and continue',
  'Les mots de passe ne correspondent pas': 'Passwords do not match',
  'Réessayer': 'Retry',
  'Connexion au serveur SFTPad perdue — reconnexion…': 'Connection to the SFTPad server lost — reconnecting…',
  'Aucun site': 'No site',
  'Toucher pour choisir': 'Tap to choose',
  'Toucher pour choisir un serveur': 'Tap to choose a server',
  'Connexion…': 'Connecting…',
  ' · en veille': ' · idle',
  'Déconnecté': 'Disconnected',
  'Local': 'Local',
  'Distant': 'Remote',
  'Sites': 'Sites',
  'Transferts': 'Transfers',
  'File de transferts': 'Transfer queue',
  'Réglages': 'Settings',
  'Annuler la sélection': 'Clear selection',
  'Plus': 'More',
  "Plus d'actions": 'More actions',

  // ----- Clé d'hôte, erreurs de connexion -----
  'Nouveau serveur': 'New server',
  "Première connexion à {host}:{port}. Vérifiez que l'empreinte de la clé d'hôte correspond bien à celle de votre serveur :":
    "First connection to {host}:{port}. Check that the host key fingerprint matches your server's:",
  'Sur le serveur : {cmd}': 'On the server: {cmd}',
  'Faire confiance': 'Trust',
  "⚠ Clé d'hôte modifiée": '⚠ Host key changed',
  "La clé d'hôte de ce serveur a changé.": "This server's host key has changed.",
  "Cela arrive après une réinstallation du serveur… ou lors d'une attaque de l'homme du milieu. Ne continuez que si vous savez pourquoi.":
    'This happens after the server is reinstalled… or during a man-in-the-middle attack. Only continue if you know why.',
  'Connue': 'Known',
  'Reçue': 'Received',
  'Remplacer la clé': 'Replace the key',
  "{name} : {error}. Vérifiez l'identifiant et le mot de passe ou la clé.": '{name}: {error}. Check the username and the password or key.',

  // ----- Sélection, menus, transferts -----
  'Envoyer': 'Upload',
  'Télécharger': 'Download',
  'Transférer': 'Transfer',
  'Vers {path}': 'To {path}',
  'Connectez-vous à un serveur': 'Connect to a server',
  "Connectez-vous d'abord à un serveur": 'Connect to a server first',
  'Panneau local indisponible': 'Local pane unavailable',
  'Envoyer sur le serveur': 'Upload to server',
  'Télécharger en local': 'Download to local',
  'Transférer avec options…': 'Transfer with options…',
  "Enregistrer sur l'appareil": 'Save to device',
  'Renommer': 'Rename',
  'Déplacer…': 'Move…',
  'Déplacer': 'Move',
  'Permissions': 'Permissions',
  'Inverser la sélection': 'Invert selection',
  'Supprimer ({n})': 'Delete ({n})',
  'Supprimer': 'Delete',
  '« {name} » existe déjà dans {dir}. Pour les fichiers déjà présents :': '"{name}" already exists in {dir}. For files that are already there:',
  '{n} éléments existent déjà dans {dir}. Pour les fichiers déjà présents :': '{n} items already exist in {dir}. For files that are already there:',
  'Destination : {dir}. Si un fichier existe déjà :': 'Destination: {dir}. If a file already exists:',
  'Fichiers existants': 'Existing files',
  '{what} {to} : {dir}': '{what} {to}: {dir}',
  '{n} éléments': '{n} items',
  '« {name} »': '"{name}"',
  '→ serveur': '→ server',
  '→ local': '→ local',
  '{n} fichiers': '{n} files',
  'Envoi de {name} ({size}) vers {dir}': 'Uploading {name} ({size}) to {dir}',
  '{name} envoyé': '{name} uploaded',
  '{name} envoyés': '{name} uploaded',
  'Échec du transfert « {name} » : {error}': 'Transfer of "{name}" failed: {error}',

  // ----- Si le fichier existe -----
  'Reprendre ou ignorer si identique': 'Resume or skip if identical',
  'Complète les fichiers partiels, ignore ceux de même taille (recommandé)': 'Completes partial files, skips those of the same size (recommended)',
  'Écraser': 'Overwrite',
  'Remplace systématiquement les fichiers existants': 'Always replaces existing files',
  'Écraser si plus récent': 'Overwrite if newer',
  'Remplace seulement si la source est plus récente': 'Replaces only if the source is newer',
  'Ignorer': 'Skip',
  'Ne transfère pas les fichiers déjà présents': 'Does not transfer files that are already there',
  'Garde les deux : « fichier (1).ext »': 'Keeps both: "file (1).ext"',

  // ----- Réglages -----
  'par défaut (umask)': 'default (umask)',
  'Auto': 'Auto',
  'Clair': 'Light',
  'Sombre': 'Dark',
  'Réglages enregistrés': 'Settings saved',
  'Transferts simultanés': 'Concurrent transfers',
  'Si le fichier existe déjà': 'If the file already exists',
  'Permissions des fichiers créés en local': 'Permissions of files created locally',
  'Octal, ex. 664. Laisser vide pour le comportement par défaut.': 'Octal, e.g. 664. Leave empty for the default behavior.',
  'Affichage': 'Display',
  'Langue': 'Language',
  "Installer l'application": 'Install the app',
  'Sécurité': 'Security',
  "Authentification intégrée désactivée (AUTH=none) : l'accès doit être protégé par votre reverse proxy.":
    'Built-in authentication disabled (AUTH=none): access must be protected by your reverse proxy.',
  'Mot de passe défini par la variable ADMIN_PASSWORD.': 'Password set by the ADMIN_PASSWORD variable.',
  'Changer le mot de passe': 'Change password',
  'Se déconnecter de SFTPad': 'Sign out of SFTPad',
  'À propos': 'About',
  'Version': 'Version',
  'Stockage local': 'Local storage',
  'Utilisateur': 'User',
  'Espace libre': 'Free space',
  '{free} sur {total}': '{free} of {total}',
  'Mot de passe actuel': 'Current password',
  'Nouveau mot de passe (8 caractères min.)': 'New password (8 characters min.)',
  'Annuler': 'Cancel',
  'Changer': 'Change',
  'Mot de passe modifié. Les autres appareils sont déconnectés.': 'Password changed. Other devices have been signed out.',

  // ----- API -----
  'Erreur {status}': 'Error {status}',
  'Serveur injoignable': 'Server unreachable',
  'Envoi interrompu': 'Upload interrupted',
  'Envoi annulé': 'Upload canceled',

  // ----- Panneaux -----
  'Filtrer': 'Filter',
  'Nouveau dossier': 'New folder',
  "Envoyer depuis l'appareil": 'Upload from device',
  'Actualiser': 'Refresh',
  'Options': 'Options',
  'Filtrer les noms…': 'Filter names…',
  'Fermer le filtre': 'Close filter',
  'Nom': 'Name',
  'Taille': 'Size',
  'Modifié': 'Modified',
  'Droits': 'Perms',
  'Aucun serveur': 'No server',
  'Choisissez ou créez un site SFTP pour commencer.': 'Choose or create an SFTP site to get started.',
  'Gestionnaire de sites': 'Site manager',
  "Impossible d'afficher ce dossier": 'Unable to display this folder',
  'Dossier parent': 'Parent folder',
  'Aucun résultat': 'No results',
  'Dossier vide': 'Empty folder',
  '{size} libres': '{size} free',
  'Actions': 'Actions',
  'Nom du dossier': 'Folder name',
  'Créer': 'Create',
  'Nouveau nom': 'New name',
  'Déplacer {n} éléments': 'Move {n} items',
  'Déplacer « {name} »': 'Move "{name}"',
  'Dossier de destination (sur ce même côté)': 'Destination folder (on this same side)',
  'Chemin absolu requis (commence par /)': 'Absolute path required (starts with /)',
  '{name} : impossible de déplacer un dossier dans lui-même': '{name}: cannot move a folder into itself',
  '{name} : {error}': '{name}: {error}',
  'Supprimer définitivement « {name} » et tout son contenu ?': 'Permanently delete "{name}" and everything in it?',
  'Supprimer définitivement « {name} » ?': 'Permanently delete "{name}"?',
  'Supprimer définitivement {n} éléments ?': 'Permanently delete {n} items?',
  'Supprimer définitivement {count} éléments (dont {n} dossier et leur contenu) ?': 'Permanently delete {count} items (including {n} folder and its contents)?',
  'Supprimer définitivement {count} éléments (dont {n} dossiers et leur contenu) ?': 'Permanently delete {count} items (including {n} folders and their contents)?',
  'Supprimer (local)': 'Delete (local)',
  'Supprimer (serveur)': 'Delete (server)',
  'Lecture': 'Read',
  'Écriture': 'Write',
  'Exécution': 'Execute',
  'Propriétaire': 'Owner',
  'Groupe': 'Group',
  'Autres': 'Others',
  'Permissions ({n} éléments)': 'Permissions ({n} items)',
  'Valeur octale': 'Octal value',
  'Appliqué aux éléments sélectionnés uniquement (non récursif).': 'Applied to the selected items only (not recursive).',
  'Permissions modifiées': 'Permissions changed',
  'Appliquer': 'Apply',
  "Seuls les fichiers peuvent être téléchargés sur l'appareil. Pour un dossier, transférez-le.": 'Only files can be downloaded to the device. To get a folder, transfer it.',
  'Les dossiers ont été ignorés': 'Folders were skipped',
  'Chemin copié': 'Path copied',
  'Ouvrir': 'Open',
  'Aperçu': 'Preview',
  'Copier le chemin': 'Copy path',
  'Sélectionner': 'Select',
  "Envoyer des fichiers depuis l'appareil": 'Upload files from device',
  "Envoyer un dossier depuis l'appareil": 'Upload a folder from device',
  'Aller à…': 'Go to…',
  'Aller à': 'Go to',
  'Dossier local du site': "Site's local folder",
  'Dossier personnel': 'Home folder',
  'Tout sélectionner': 'Select all',
  'Trier par nom': 'Sort by name',
  'Trier par taille': 'Sort by size',
  'Trier par date': 'Sort by date',
  'Ordre décroissant': 'Descending order',
  'Ordre croissant': 'Ascending order',
  'Masquer les fichiers cachés': 'Hide hidden files',
  'Afficher les fichiers cachés': 'Show hidden files',
  'Se déconnecter': 'Disconnect',
  'Chemin': 'Path',
  'Chemin absolu requis': 'Absolute path required',
  'Nom requis': 'Name required',
  'Le nom ne peut pas contenir « / »': 'The name cannot contain "/"',
  'Nom invalide': 'Invalid name',
  '{n} dossier': '{n} folder',
  '{n} dossiers': '{n} folders',
  '{n} fichier': '{n} file',
  '{n} sélectionné': '{n} selected',
  '{n} sélectionnés': '{n} selected',
  '{n} élément déplacé': '{n} item moved',
  '{n} éléments déplacés': '{n} items moved',
  '{n} élément supprimé': '{n} item deleted',
  '{n} éléments supprimés': '{n} items deleted',
  "Aujourd'hui {time}": 'Today {time}',

  // ----- File de transferts -----
  'En cours': 'Active',
  'Échecs': 'Failed',
  'Terminés': 'Completed',
  'En pause · {n} en attente': 'Paused · {n} pending',
  'Reprendre': 'Resume',
  'Pause': 'Pause',
  'Tout annuler': 'Cancel all',
  'Annuler tous les transferts en cours et en attente ?': 'Cancel all active and pending transfers?',
  'Tout réessayer': 'Retry all',
  'Vider': 'Clear',
  'Vider la liste': 'Clear list',
  '… et {n} autres': '… and {n} more',
  'Aucun transfert en cours': 'No active transfers',
  'Aucun échec': 'No failures',
  'Rien pour le moment': 'Nothing yet',
  "Depuis l'appareil": 'From device',
  'Analyse du dossier…': 'Scanning folder…',
  'En attente · {what}': 'Pending · {what}',
  'dossier': 'folder',
  'Terminé · {size}': 'Done · {size}',
  'Ignoré': 'Skipped',
  'Annulé': 'Canceled',
  'Erreur': 'Error',
  'Retirer': 'Remove',
  'Retirer de la liste': 'Remove from list',
  '{n} transfert': '{n} transfer',
  '{n} transferts': '{n} transfers',
  'Dossier : {n} élément ajouté': 'Folder: {n} item added',
  'Dossier : {n} éléments ajoutés': 'Folder: {n} items added',

  // ----- Gestionnaire de sites -----
  'Ajoutez votre premier serveur SFTP.': 'Add your first SFTP server.',
  'connecté': 'connected',
  'Déconnecter': 'Disconnect',
  'Modifier': 'Edit',
  'Nouveau site': 'New site',
  '•••••••• (enregistré, laisser vide pour garder)': '•••••••• (saved, leave empty to keep)',
  'Clé enregistrée — collez-en une autre pour la remplacer': 'Key saved — paste another one to replace it',
  'Clé privée': 'Private key',
  'Importer un fichier': 'Import a file',
  'Générer une clé ed25519': 'Generate an ed25519 key',
  'Voir la clé publique': 'Show public key',
  'Phrase secrète (si la clé est protégée)': 'Passphrase (if the key is protected)',
  '•••••••• (enregistrée)': '•••••••• (saved)',
  'Aucune': 'None',
  'Clé SSH': 'SSH key',
  'Nouvelle clé générée. ': 'New key generated. ',
  'Clé publique : ': 'Public key: ',
  'Ajoutez cette ligne dans ~/.ssh/authorized_keys sur le serveur, puis enregistrez le site.': 'Add this line to ~/.ssh/authorized_keys on the server, then save the site.',
  'Clé publique copiée': 'Public key copied',
  'Copier': 'Copy',
  "Clé d'hôte approuvée": 'Trusted host key',
  'Oublier cette clé': 'Forget this key',
  "Clé d'hôte oubliée : elle vous sera présentée à la prochaine connexion": 'Host key forgotten: you will be asked to approve it on the next connection',
  'Mon serveur': 'My server',
  'Hôte': 'Host',
  'sftp.exemple.fr ou 192.168.1.10': 'sftp.example.com or 192.168.1.10',
  'Identifiant': 'Username',
  'utilisateur': 'user',
  'Authentification': 'Authentication',
  'Dossiers par défaut': 'Default folders',
  'Dossier distant': 'Remote folder',
  'Dossier local (dans le stockage monté)': 'Local folder (in the mounted storage)',
  'Couleur': 'Color',
  'Une clé privée est requise': 'A private key is required',
  'Site ajouté': 'Site added',
  'Site enregistré': 'Site saved',
  'Supprimer le site': 'Delete site',
  'Supprimer « {name} » et ses identifiants enregistrés ?': 'Delete "{name}" and its saved credentials?',
  'Modifier « {name} »': 'Edit "{name}"',
  'Ajouter': 'Add',
  'Enregistrer': 'Save',

  // ----- Composants -----
  'Fermer': 'Close',
  'Valeur requise': 'Value required',
  'Continuer': 'Continue',
  'Chargement…': 'Loading…',
};

export function t(key, vars) {
  let s = lang === 'en' ? (EN[key] ?? key) : key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

// Variante selon le contexte : tc('auth', 'Se connecter') cherche d'abord la clé « auth|Se connecter ».
export function tc(ctx, key, vars) {
  return lang === 'en' && EN[`${ctx}|${key}`] != null ? t(`${ctx}|${key}`, vars) : t(key, vars);
}

// Pluriel : en français 0 et 1 sont au singulier, en anglais seul 1 l'est. {n} vaut le nombre.
export function tn(n, one, many, vars) {
  const plural = lang === 'en' ? n !== 1 : n > 1;
  return t(plural ? many : one, { n, ...vars });
}

// Traduit le HTML statique : textes marqués data-i18n, et attributs title / aria-label / placeholder.
export function applyDom(root = document) {
  document.documentElement.lang = lang;
  if (lang === 'fr') return;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.textContent.trim());
  for (const attr of ['title', 'aria-label', 'placeholder']) {
    for (const el of root.querySelectorAll(`[${attr}]`)) el.setAttribute(attr, t(el.getAttribute(attr)));
  }
}

export { EN };
