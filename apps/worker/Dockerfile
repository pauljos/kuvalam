# apps/worker/Dockerfile
# Shares API source — worker imports services directly from apps/api/src
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache dumb-init

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
# Install dependencies for worker workspace
RUN npm ci --workspace=apps/worker --workspace=apps/api --omit=dev

FROM base AS runner
ENV NODE_ENV=production
# Copy node_modules from root (workspace hoisting)
COPY --from=deps /app/node_modules ./node_modules
# Also copy workspace-specific node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules

COPY apps/api/src ./apps/api/src
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/src ./apps/worker/src
COPY apps/worker/package.json ./apps/worker/package.json

WORKDIR /app/apps/worker
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
