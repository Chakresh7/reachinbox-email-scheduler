# Static SPA build served by nginx, which also proxies /api to the API
# container so the session cookie stays same-origin in production exactly as it
# does behind the Vite dev proxy.

# ── Build ────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --foreground-scripts

COPY tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts index.html ./
COPY src ./src

RUN npm run build

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/templates/default.conf.template

# Official nginx image runs envsubst on templates/*.template at start.
# Compose uses the Docker DNS name `api`; Render sets this to the API service.
ENV API_UPSTREAM=http://api:4000

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://localhost/ >/dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]
