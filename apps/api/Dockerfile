# apps/api/Dockerfile
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache dumb-init

# ── Install dependencies ───────────────────────────────────────────────────
FROM base AS deps
# Copy ALL workspace package.json files for npm to understand workspace structure
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
# Now npm ci will work properly with complete workspace info
RUN npm ci --omit=dev

# ── Production image ───────────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY apps/api/src ./apps/api/src
COPY apps/api/package.json ./apps/api/package.json
COPY infra/migrations ./infra/migrations

WORKDIR /app

EXPOSE 3001

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/src/index.js"]
