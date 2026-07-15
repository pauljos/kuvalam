# apps/worker/Dockerfile
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache dumb-init

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
RUN npm install --production --legacy-peer-deps

FROM base AS runner
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY apps/api/src ./apps/api/src
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/src ./apps/worker/src
COPY apps/worker/package.json ./apps/worker/package.json

# Stay at /app root
WORKDIR /app

ENTRYPOINT ["dumb-init", "--"]
# Run from root with full path
CMD ["node", "apps/worker/src/index.js"]
