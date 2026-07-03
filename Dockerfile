# Feishu Claude Pal — daemon image
#
# Build:    docker build -t feishu-claude-pal .
# Run:      docker compose up -d
# Logs:     docker compose logs -f
# Health:   curl http://localhost:18888/health

FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies (cached layer)
COPY package.json package-lock.json ./
RUN npm ci

# Build bundle
COPY tsconfig.json scripts ./scripts
COPY src ./src
RUN npm run build


FROM node:22-alpine AS runtime

WORKDIR /app

# Production deps only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Built bundle
COPY --from=builder /app/dist ./dist

# Health check (calls /health, expects 200)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:18888/health', r => process.exit(r.statusCode === 200 || r.statusCode === 503 ? 0 : 1)).on('error', () => process.exit(1))"

# Default: disable health server (set to "false" to keep on)
ENV CTI_HEALTH_DISABLED=false
ENV CTI_HEALTH_PORT=18888

EXPOSE 18888

# Run as non-root
USER node

CMD ["node", "dist/daemon.mjs"]
