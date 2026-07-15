# apps/api/Dockerfile
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache dumb-init

# ── Install dependencies ───────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
# Install ALL dependencies at root level (ignore workspaces)
RUN npm install --production --legacy-peer-deps

# ── Production image ───────────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production

# Copy ALL node_modules
COPY --from=deps /app/node_modules ./node_modules

# Copy source
COPY apps/api/src ./apps/api/src
COPY apps/api/package.json ./apps/api/package.json
COPY infra/migrations ./infra/migrations

WORKDIR /app/apps/api

EXPOSE 3001

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
