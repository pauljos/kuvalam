# apps/browser-agent/Dockerfile
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache dumb-init

# ── Playwright deps (Chromium system libs) ─────────────────────────────────
# Alpine needs extra packages for Chromium
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

# Tell Playwright to use system Chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

# ── Dependencies ───────────────────────────────────────────────────────────
COPY apps/browser-agent/package.json apps/browser-agent/package-lock.json* ./
RUN npm install --production

# ── Runtime ────────────────────────────────────────────────────────────────
COPY apps/browser-agent/server.js ./

EXPOSE 9223

ENV NODE_ENV=production

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
