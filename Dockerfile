# External Integration Creator — small image: node:22-alpine, non-root user, one
# runtime dependency (libsodium-wrappers, added with the GitHub launch steps).
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

WORKDIR /app

COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; fi \
    && npm cache clean --force

COPY src ./src
COPY public ./public
COPY config ./config

RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node

EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1

# Small heap: the app keeps little in memory (target: < 64 MB RSS at rest).
CMD ["node", "--max-old-space-size=48", "--max-semi-space-size=1", "--optimize-for-size", "src/index.js"]
