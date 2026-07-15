# apps/api/Dockerfile
FROM node:22-alpine AS base
WORKDIR /app/apps/api
RUN apk add --no-cache dumb-init

# ── Install dependencies ───────────────────────────────────────────────────
FROM base AS deps
# Copy ONLY the API package.json and install as standalone (ignore monorepo)
COPY apps/api/package.json apps/api/package-lock.json* ./
RUN npm install --production --no-package-lock

# ── Production image ───────────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production

COPY --from=deps /app/apps/api/node_modules ./node_modules
COPY apps/api/src ./src
COPY apps/api/package.json ./package.json
COPY infra/migrations /app/infra/migrations

WORKDIR /app/apps/api

EXPOSE 3001

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
