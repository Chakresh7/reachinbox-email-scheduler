#!/bin/sh
set -eu

# Hosted boot: migrate, then API + worker in one container.
# Render/Koyeb free tiers do not include a separate background-worker service.
npx prisma migrate deploy

node dist/worker.js &
exec node dist/server.js
