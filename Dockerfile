# Hosted image: API + Vite dashboard + worker in one process.
# One origin keeps the session cookie same-site; one container fits Render Free.

# ── Dashboard ────────────────────────────────────────────────────────────────
FROM node:24-alpine AS frontend

WORKDIR /web

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund --foreground-scripts

COPY frontend/tsconfig.json frontend/tsconfig.app.json frontend/tsconfig.node.json frontend/vite.config.ts frontend/index.html ./
COPY frontend/src ./src

RUN npm run build

# ── API ──────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS backend

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --no-audit --no-fund --foreground-scripts

COPY backend/prisma ./prisma
COPY backend/prisma7.config.ts backend/tsconfig.json backend/tsconfig.build.json ./
COPY backend/src ./src

RUN npm run build
# prisma CLI is a devDependency locally; migrate deploy at boot needs it.
RUN npm prune --omit=dev && npm install prisma@7.10.0 dotenv@17.2.3 --omit=dev --no-audit --no-fund --foreground-scripts

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV FRONTEND_DIST=/app/public

RUN apk add --no-cache openssl dumb-init

COPY --from=backend /app/node_modules ./node_modules
COPY --from=backend /app/dist ./dist
COPY --from=backend /app/package.json ./package.json
COPY --from=backend /app/prisma ./prisma
COPY --from=backend /app/prisma7.config.ts ./prisma7.config.ts
COPY --from=frontend /web/dist ./public
COPY start-hosted.sh /app/start-hosted.sh
RUN chmod +x /app/start-hosted.sh

USER node

EXPOSE 4000

ENTRYPOINT ["dumb-init", "--"]
CMD ["/app/start-hosted.sh"]
