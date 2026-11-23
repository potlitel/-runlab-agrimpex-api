# =====================================================================
#  RunLab Agrimpex — API (Express + Socket.io)
# =====================================================================
#  Base por defecto: node:22-alpine (YA DESCARGADA en este equipo).
#
#  La imagen mcr.microsoft.com/playwright:v1.62.1-noble NO es obligatoria
#  para levantar el dashboard: solo hace falta si quieres EJECUTAR tests
#  Playwright dentro del contenedor (trae navegadores + libs del sistema).
#  Si la descargas luego, puedes reconstruir con:
#
#    docker compose build runlabqa-api \
#      --build-arg API_BASE_IMAGE=mcr.microsoft.com/playwright:v1.62.1-noble
#
#  O poniendo API_BASE_IMAGE=... en .env (el compose ya lo reenvía).
# =====================================================================

ARG API_BASE_IMAGE=node:22-alpine
FROM ${API_BASE_IMAGE}

# Proxy opcional: se puede inyectar con --build-arg HTTP_PROXY=...
ARG HTTP_PROXY=
ARG HTTPS_PROXY=
ARG NO_PROXY=

ENV HTTP_PROXY=$HTTP_PROXY \
    HTTPS_PROXY=$HTTPS_PROXY \
    NO_PROXY=$NO_PROXY \
    NODE_ENV=production \
    PORT=3001 \
    RUNLABQA_DATA_DIR=/data \
    TZ=America/Argentina/Buenos_Aires

# git lo usan los módulos de automatización/self-update.
# En la imagen Playwright (Ubuntu) ya viene instalado.
RUN if command -v apk >/dev/null 2>&1; then \
      apk add --no-cache git; \
    elif command -v apt-get >/dev/null 2>&1; then \
      apt-get update && apt-get install -y --no-install-recommends git \
      && rm -rf /var/lib/apt/lists/*; \
    fi

WORKDIR /app

# lockfile + .npmrc primero para reutilizar la caché de capas.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --no-audit --no-fund --loglevel=warn

COPY . .

# uid/gid 1000 existe tanto en node:22-alpine (node) como en la imagen
# de Playwright (pwuser), así que funciona con cualquier base.
RUN mkdir -p /data && chown -R 1000:1000 /data /app
USER 1000:1000

EXPOSE 3001

# Barato y sin efectos secundarios (evita /api/system/updates y /profile-admin).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/openapi.json').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
