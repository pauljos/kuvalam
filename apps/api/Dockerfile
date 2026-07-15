# apps/api/Dockerfile
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache dumb-init

# ── Install dependencies ───────────────────────────────────────────────────
FROM base AS deps
# Copy package files
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
# Force clean install without cache
RUN npm ci --omit=dev --no-optional 2>&1 || npm install --production --legacy-peer-deps

# ── Production image ───────────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production

# Copy root package.json so Node knows about workspace structure
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY apps/api/src ./apps/api/src
COPY apps/api/package.json ./apps/api/package.json
COPY infra/migrations ./infra/migrations

WORKDIR /app

EXPOSE 3001

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/src/index.js"]
