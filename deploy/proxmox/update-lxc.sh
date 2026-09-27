#!/usr/bin/env bash
# Met à jour SFTPad dans un conteneur existant. Sur l'hôte Proxmox, depuis le dossier de la nouvelle version :
#   CTID=105 bash deploy/proxmox/update-lxc.sh
set -euo pipefail
[ -n "${CTID:-}" ] || { echo "Indiquez CTID=<id du conteneur>"; exit 1; }
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp /tmp/sftpad-XXXX.tgz)"
tar -C "$SRC_DIR" --exclude=node_modules --exclude=config --exclude=data --exclude=.git -czf "$TMP" .
pct push "$CTID" "$TMP" /root/sftpad.tgz
rm -f "$TMP"
pct exec "$CTID" -- bash -c "rm -rf /root/sftpad-src && mkdir -p /root/sftpad-src && tar -xzf /root/sftpad.tgz -C /root/sftpad-src && rm /root/sftpad.tgz && bash /root/sftpad-src/deploy/lxc/install.sh"
