# apps/api/Dockerfile
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache dumb-init

# ── Install dependencies ───────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
# Install all dependencies including workspace root
RUN npm ci --omit=dev

# ── Production image ───────────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production

# Copy installed node_modules to both root and api directory
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/node_modules ./apps/api/node_modules

# Copy source
COPY apps/api/src ./apps/api/src
COPY apps/api/package.json ./apps/api/package.json
# Migrations are read at runtime by src/db/migrate.js (used by preDeployCommand on Render
# and install.sh on-prem). Must be present inside the image.
COPY infra/migrations ./infra/migrations

WORKDIR /app/apps/api

EXPOSE 3001

# dumb-init handles PID 1 signal forwarding (graceful shutdown)
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
