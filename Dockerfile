# ═══════════════════════════════════════════════════════════
# 123456btc-node Production Dockerfile
# Multi-stage build for minimal attack surface
# ═══════════════════════════════════════════════════════════

# ── Stage 1: Builder ──
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3, etc.)
RUN apk add --no-cache python3 make g++

# Copy dependency manifests first (layer caching)
COPY package.json package-lock.json tsconfig.json ./

# Install all dependencies (including dev for build)
RUN npm ci

# Copy source code
COPY src ./src

# Build TypeScript
RUN npm run build

# Prune dev dependencies after build
RUN npm prune --omit=dev

# ── Stage 2: Production ──
FROM node:20-alpine

# Metadata
LABEL maintainer="123456btc" \
      description="123456btc-node — Decentralized strategy service node" \
      version="0.1.0"

# Security: install only runtime OS deps, no package manager
RUN apk add --no-cache tini curl && \
    rm -rf /var/cache/apk/*

WORKDIR /app

# Security: run as non-root user
RUN addgroup -g 1001 -S bbt && \
    adduser -S bbt -u 1001 -G bbt -h /app

# Copy dependency manifests and install production-only deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built artifacts from builder
COPY --from=builder /app/dist ./dist

# Copy static assets for web dashboard
COPY public ./public

# Create required directories with proper permissions
RUN mkdir -p /app/data /app/logs && \
    chown -R bbt:bbt /app

# Switch to non-root user
USER bbt

# Expose HTTP/WebSocket/P2P port
EXPOSE 1119

# Environment defaults
ENV NODE_ENV=production \
    BBT_LOG_LEVEL=info \
    BBT_NODE_PORT=1119

# Health check — uses the /health endpoint built into the HTTP API
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:1119/health || exit 1

# Use tini as PID 1 for proper signal handling (SIGTERM, SIGINT, zombie reaping)
ENTRYPOINT ["/sbin/tini", "--"]

# Default command: start the node server
CMD ["node", "dist/cli.js", "serve"]
