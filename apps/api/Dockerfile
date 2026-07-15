# apps/api/Dockerfile
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache dumb-init

# ── Install dependencies ───────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
RUN npm install --production --legacy-peer-deps

# ── Production image ───────────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY apps/api/src ./apps/api/src
COPY apps/api/package.json ./apps/api/package.json
COPY infra/migrations ./infra/migrations

# Stay at /app root, don't change to subdirectory
WORKDIR /app

EXPOSE 3001

ENTRYPOINT ["dumb-init", "--"]
# Run from root with full path
CMD ["node", "apps/api/src/index.js"]
