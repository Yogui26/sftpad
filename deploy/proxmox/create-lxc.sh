#!/usr/bin/env bash
# Crée un conteneur LXC Debian 12 non privilégié sur Proxmox VE et y installe SFTPad.
# À lancer en root sur l'hôte Proxmox, depuis le dossier du projet :
#   DATA_HOST_PATH=/tank/partage bash deploy/proxmox/create-lxc.sh
#
# Variables (toutes facultatives) :
#   CTID             identifiant du conteneur          (prochain libre)
#   CT_HOSTNAME      nom d'hôte                         (sftpad)
#   STORAGE          stockage du disque racine          (local-lvm)
#   TEMPLATE_STORAGE stockage des modèles               (local)
#   BRIDGE           pont réseau                        (vmbr0)
#   IP               dhcp ou 192.168.1.50/24,gw=192.168.1.1   (dhcp)
#   DISK MEM CORES   taille disque (Go), RAM (Mo), cœurs (4 / 512 / 1)
#   DATA_HOST_PATH   dossier de l'hôte monté sur /data dans le conteneur (le côté « local »)
#   SFTPAD_UID/GID   uid/gid du service dans le conteneur (1000/1000)
set -euo pipefail

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mErreur :\033[0m %s\n' "$*" >&2; exit 1; }

command -v pct >/dev/null || die "à lancer sur un hôte Proxmox VE"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ -f "$SRC_DIR/server/index.js" ] || die "sources introuvables"

CTID="${CTID:-$(pvesh get /cluster/nextid)}"
CT_HOSTNAME="${CT_HOSTNAME:-sftpad}"
STORAGE="${STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
BRIDGE="${BRIDGE:-vmbr0}"
IP="${IP:-dhcp}"
DISK="${DISK:-4}"; MEM="${MEM:-512}"; CORES="${CORES:-1}"
SFTPAD_UID="${SFTPAD_UID:-1000}"; SFTPAD_GID="${SFTPAD_GID:-1000}"

say "Modèle Debian 12"
pveam update >/dev/null
TEMPLATE="$(pveam available --section system | awk '/debian-12-standard/ {print $2}' | sort -V | tail -1)"
[ -n "$TEMPLATE" ] || die "modèle debian-12-standard introuvable"
if ! pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE"; then
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
fi

say "Création du conteneur $CTID ($CT_HOSTNAME)"
pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE" \
  --hostname "$CT_HOSTNAME" --ostype debian --unprivileged 1 --features nesting=1 \
  --cores "$CORES" --memory "$MEM" --swap 256 \
  --rootfs "$STORAGE:$DISK" \
  --net0 "name=eth0,bridge=$BRIDGE,ip=$IP" \
  --onboot 1 --description "SFTPad — client SFTP web tactile"

if [ -n "${DATA_HOST_PATH:-}" ]; then
  [ -d "$DATA_HOST_PATH" ] || die "$DATA_HOST_PATH n'existe pas sur l'hôte"
  say "Montage de $DATA_HOST_PATH sur /data"
  pct set "$CTID" -mp0 "$DATA_HOST_PATH,mp=/data"
  HOST_UID=$((100000 + SFTPAD_UID)); HOST_GID=$((100000 + SFTPAD_GID))
  echo "    Conteneur non privilégié : l'utilisateur sftpad ($SFTPAD_UID) apparaît comme $HOST_UID:$HOST_GID sur l'hôte."
  echo "    Pour qu'il puisse écrire :  chown -R $HOST_UID:$HOST_GID '$DATA_HOST_PATH'   (ou une ACL : setfacl -R -m u:$HOST_UID:rwX,d:u:$HOST_UID:rwX '$DATA_HOST_PATH')"
fi

say "Démarrage"
pct start "$CTID"
for _ in $(seq 1 30); do
  pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 && break
  sleep 2
done

say "Envoi des sources"
TMP="$(mktemp /tmp/sftpad-XXXX.tgz)"
tar -C "$SRC_DIR" --exclude=node_modules --exclude=config --exclude=data --exclude=.git -czf "$TMP" .
pct push "$CTID" "$TMP" /root/sftpad.tgz
rm -f "$TMP"
pct exec "$CTID" -- bash -c "rm -rf /root/sftpad-src && mkdir -p /root/sftpad-src && tar -xzf /root/sftpad.tgz -C /root/sftpad-src && rm /root/sftpad.tgz"

say "Installation dans le conteneur"
pct exec "$CTID" -- env SFTPAD_UID="$SFTPAD_UID" SFTPAD_GID="$SFTPAD_GID" bash /root/sftpad-src/deploy/lxc/install.sh

IP_CT="$(pct exec "$CTID" -- hostname -I | awk '{print $1}')"
echo
say "Terminé : http://${IP_CT}:8080  (conteneur $CTID)"
echo "    Mise à jour : copiez la nouvelle version sur l'hôte puis"
echo "      pct push $CTID sftpad.tgz /root/sftpad.tgz  et relancez deploy/lxc/install.sh dans le conteneur,"
echo "      ou plus simplement : CTID=$CTID bash deploy/proxmox/update-lxc.sh"
