# SFTPad — image Docker (Unraid, Proxmox, tout hôte Docker)
FROM node:26-alpine

# apk upgrade : applique les correctifs de sécurité Alpine disponibles au moment du build
RUN apk upgrade --no-cache && apk add --no-cache tini su-exec

WORKDIR /app
COPY package.json package-lock.json ./
# --omit=optional : saute l'accélérateur natif optionnel de ssh2 (pas de compilation nécessaire)
RUN npm ci --omit=dev --omit=optional && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn* /usr/local/bin/yarn*

COPY server ./server
COPY public ./public
COPY deploy/docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production \
    PORT=8080 \
    CONFIG_DIR=/config \
    DATA_DIR=/data \
    PUID=99 \
    PGID=100 \
    UMASK=002

VOLUME ["/config"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/auth/state" >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
CMD ["node", "server/index.js"]
