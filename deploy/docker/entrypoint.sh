#!/bin/sh
# Lance SFTPad avec l'utilisateur PUID:PGID (convention Unraid : 99:100 = nobody:users).
set -e
PUID="${PUID:-99}"
PGID="${PGID:-100}"
umask "${UMASK:-002}"
mkdir -p "${CONFIG_DIR:-/config}" "${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  chown -R "$PUID:$PGID" "${CONFIG_DIR:-/config}"
  export HOME="${CONFIG_DIR:-/config}"
  echo "SFTPad : exécution en tant que $PUID:$PGID (umask $(umask))"
  exec su-exec "$PUID:$PGID" "$@"
fi
exec "$@"
