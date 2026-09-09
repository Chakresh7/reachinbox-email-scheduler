# Multi-stage: the runtime image carries no TypeScript toolchain and no dev
# dependencies. The same image runs both the API and the worker, differing only
# in the command, so there is one build to keep consistent.

# ── Build ────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS build

WORKDIR /app

# Dependency layer first, so a source change does not re-install everything.
COPY package.json package-lock.json ./
# npm 11+ blocks dependency install scripts by default; Prisma's engine download
# and esbuild's binary install genuinely need to run.
RUN npm ci --no-audit --no-fund --foreground-scripts

# `prisma generate` needs the schema and config. It reads no database.
COPY prisma ./prisma
COPY prisma7.config.ts tsconfig.json tsconfig.build.json ./
COPY src ./src

# `npm run build` also copies the Lua rate-limit scripts tsc does not emit.
RUN npm run build

# Drop dev dependencies, then put the Prisma CLI back — `migrate deploy` at
# container start is a production boot step, not a local-dev convenience.
RUN npm prune --omit=dev && npm install prisma@7.10.0 --omit=dev --no-audit --no-fund --foreground-scripts

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Prisma's schema engine needs OpenSSL for migrate deploy on Alpine.
RUN apk add --no-cache openssl dumb-init

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# migrate deploy at container start needs the migrations and the CLI config.
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma7.config.ts ./prisma7.config.ts

# Never run as root.
USER node

EXPOSE 4000

# dumb-init as PID 1 so SIGTERM reaches Node, which is what triggers the
# graceful drain. Without it, `docker stop` kills in-flight sends.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
