#!/usr/bin/env bash
# Installe (ou met à jour) SFTPad en service systemd, sans Docker.
# À lancer en root dans un conteneur LXC Debian/Ubuntu (ou une VM), depuis le dossier du projet :
#   bash deploy/lxc/install.sh
# Variables facultatives : SFTPAD_PORT (8080), SFTPAD_DATA (/data), SFTPAD_UID / SFTPAD_GID (auto)
set -euo pipefail

APP_DIR=/opt/sftpad
CONF_DIR=/var/lib/sftpad
ENV_FILE=/etc/sftpad.env
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${SFTPAD_PORT:-8080}"
DATA="${SFTPAD_DATA:-/data}"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mErreur :\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "lancez ce script en root"
[ -f "$SRC_DIR/server/index.js" ] || die "sources introuvables dans $SRC_DIR"
command -v apt-get >/dev/null || die "ce script vise Debian/Ubuntu (apt)"

node_ok() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }

say "Paquets de base"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg >/dev/null

if ! node_ok; then
  say "Installation de Node.js 22 (NodeSource)"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
fi
node_ok || die "Node.js >= 20 requis (trouvé : $(node -v 2>/dev/null || echo aucun))"
say "Node.js $(node -v)"

say "Utilisateur système sftpad"
if ! id sftpad >/dev/null 2>&1; then
  args=(--system --home-dir "$CONF_DIR" --no-create-home --shell /usr/sbin/nologin)
  if [ -n "${SFTPAD_GID:-}" ]; then
    getent group "$SFTPAD_GID" >/dev/null || groupadd -g "$SFTPAD_GID" sftpad
    args+=(--gid "$SFTPAD_GID")
  else
    args+=(--user-group)
  fi
  if [ -n "${SFTPAD_UID:-}" ]; then args+=(--uid "$SFTPAD_UID"); fi
  useradd "${args[@]}" sftpad
fi

say "Copie de l'application dans $APP_DIR"
install -d -m 0755 "$APP_DIR"
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  rm -rf "$APP_DIR/server" "$APP_DIR/public"
  cp -r "$SRC_DIR/server" "$SRC_DIR/public" "$SRC_DIR/package.json" "$SRC_DIR/package-lock.json" "$APP_DIR/"
  install -d "$APP_DIR/deploy" && cp -r "$SRC_DIR/deploy/lxc" "$APP_DIR/deploy/"
fi
cd "$APP_DIR"
npm ci --omit=dev --omit=optional --no-audit --no-fund --loglevel=error

install -d -m 0750 -o sftpad -g "$(id -gn sftpad)" "$CONF_DIR"
install -d -m 0775 "$DATA"
if [ -z "$(ls -A "$DATA" 2>/dev/null)" ]; then chown sftpad:"$(id -gn sftpad)" "$DATA"; fi

if [ ! -f "$ENV_FILE" ]; then
  say "Configuration : $ENV_FILE"
  cat > "$ENV_FILE" <<EOF
# Configuration SFTPad (redémarrer après modification : systemctl restart sftpad)
PORT=$PORT
CONFIG_DIR=$CONF_DIR
DATA_DIR=$DATA
NODE_ENV=production
# ADMIN_PASSWORD=changez-moi
# AUTH=none            # uniquement derrière un reverse proxy qui authentifie
# TRUST_PROXY=1        # si SFTPad est derrière un reverse proxy
EOF
  chmod 0640 "$ENV_FILE"
  chgrp "$(id -gn sftpad)" "$ENV_FILE"
fi

if command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then
  say "Service systemd"
  cat > /etc/systemd/system/sftpad.service <<EOF
[Unit]
Description=SFTPad — client SFTP web
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=sftpad
Group=$(id -gn sftpad)
EnvironmentFile=$ENV_FILE
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) $APP_DIR/server/index.js
Restart=on-failure
RestartSec=3
UMask=0002
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now sftpad >/dev/null 2>&1
  systemctl restart sftpad
  sleep 1
  systemctl --no-pager --lines=0 status sftpad | head -3 || true
else
  say "systemd absent : lancement manuel possible avec"
  echo "  sudo -u sftpad env \$(grep -v '^#' $ENV_FILE | xargs) node $APP_DIR/server/index.js"
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
say "SFTPad est prêt : http://${IP:-<ip>}:$PORT"
echo "    Stockage « local » : $DATA   (montez-y votre NAS ou disque)"
echo "    Configuration      : $CONF_DIR"
echo "    Mise à jour        : relancer ce script depuis la nouvelle version des sources"
