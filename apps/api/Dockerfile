# =============================================================================
# Shogo API Server Dockerfile
# =============================================================================
# Multi-stage build for production-optimized API server
# Runs Hono server on port 8002 (configurable via API_PORT)
# Includes BetterAuth for authentication
# =============================================================================

FROM oven/bun:1.3-alpine AS builder

WORKDIR /app

# Native-module build toolchain (better-sqlite3 → node-gyp → python3).
# Required under QEMU where no prebuilt binary matches the emulated arch
# and better-sqlite3 has to compile from source. The Bun image ships
# neither Node.js nor node-gyp, so we install both explicitly.
RUN apk add --no-cache python3 make g++ nodejs npm && \
    npm install -g node-gyp

# Copy workspace root files
COPY package.json bun.lock ./
COPY tsconfig.base.json ./

# Copy package.json files for dependency resolution
# All workspace members must be present for bun install to succeed
COPY packages/agent-runtime/package.json ./packages/agent-runtime/
COPY packages/shared-runtime/package.json ./packages/shared-runtime/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/domain-stores/package.json ./packages/domain-stores/
COPY packages/shared-app/package.json ./packages/shared-app/
COPY packages/shared-ui/package.json ./packages/shared-ui/
COPY packages/ui-kit/package.json ./packages/ui-kit/
COPY packages/canvas-runtime/package.json ./packages/canvas-runtime/
COPY packages/model-catalog/package.json ./packages/model-catalog/
COPY apps/api/package.json ./apps/api/
COPY apps/mobile/package.json ./apps/mobile/

# Copy scripts needed for postinstall
COPY scripts ./scripts

# Copy patches required by `patchedDependencies` in package.json — bun install
# fails fast if a referenced .patch file isn't present in the build context.
COPY patches ./patches

# Copy prisma schema and config before install (postinstall runs db:generate:all)
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
COPY prisma.config.local.ts ./prisma.config.local.ts

# Install all dependencies (postinstall generates Prisma client)
RUN bun install

# Copy source code
COPY packages/agent-runtime ./packages/agent-runtime
COPY packages/shared-runtime ./packages/shared-runtime
COPY packages/sdk ./packages/sdk
COPY packages/model-catalog ./packages/model-catalog
COPY apps/api ./apps/api
COPY templates/runtime-template ./templates/runtime-template

# Build SDK first (dependency of api)
WORKDIR /app/packages/sdk
RUN bun run build

# Clean per-package node_modules (bun symlinks that resolve via .bun/ cache).
# These are rebuilt in the production stage via `bun install --ignore-scripts`.
WORKDIR /app
RUN rm -rf packages/*/node_modules

# =============================================================================
# Parallel deps stage — node_modules pre-owned by uid 1001
# =============================================================================
# Runs IN PARALLEL with builder (BuildKit). Installs as appuser so all files
# in node_modules are created with uid 1001 ownership. COPY --from=deps
# preserves this ownership natively — no --chown flag or chown -R needed.
# =============================================================================
FROM oven/bun:1.3-alpine AS deps

WORKDIR /app

# Native-module build toolchain (better-sqlite3 → node-gyp → python3).
# Required under QEMU where no prebuilt binary matches the emulated arch
# and better-sqlite3 has to compile from source. The Bun image ships
# neither Node.js nor node-gyp, so we install both explicitly.
RUN apk add --no-cache python3 make g++ nodejs npm && \
    npm install -g node-gyp

RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup

COPY package.json bun.lock ./
COPY tsconfig.base.json ./

COPY packages/agent-runtime/package.json ./packages/agent-runtime/
COPY packages/shared-runtime/package.json ./packages/shared-runtime/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/domain-stores/package.json ./packages/domain-stores/
COPY packages/shared-app/package.json ./packages/shared-app/
COPY packages/shared-ui/package.json ./packages/shared-ui/
COPY packages/ui-kit/package.json ./packages/ui-kit/
COPY packages/canvas-runtime/package.json ./packages/canvas-runtime/
COPY packages/model-catalog/package.json ./packages/model-catalog/
COPY apps/api/package.json ./apps/api/
COPY apps/mobile/package.json ./apps/mobile/

COPY scripts ./scripts

# Same patches directory as the builder stage — bun install fails without it.
COPY patches ./patches

COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
COPY prisma.config.local.ts ./prisma.config.local.ts

RUN chown -R appuser:appgroup /app
USER appuser
RUN bun install

# =============================================================================
# Production image
# =============================================================================
FROM node:25-alpine

WORKDIR /app

# Install curl for healthchecks, bash for shell, and Bun
RUN apk add --no-cache curl bash unzip && \
    curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v1.3.9" && \
    rm -rf /root/.bun

# Create non-root user for security
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

# Copy node_modules from deps stage. Files are already owned by uid 1001
# (installed as appuser in deps), so COPY preserves ownership natively —
# no --chown flag needed, eliminating the ~480s ownership traversal.
COPY --from=deps /app/node_modules ./node_modules

# Copy built source from builder (small files, --chown is fast here)
COPY --chown=appuser:appgroup --from=builder /app/packages/agent-runtime ./packages/agent-runtime
COPY --chown=appuser:appgroup --from=builder /app/packages/shared-runtime ./packages/shared-runtime
COPY --chown=appuser:appgroup --from=builder /app/packages/sdk ./packages/sdk
COPY --chown=appuser:appgroup --from=builder /app/apps/api ./apps/api
COPY --chown=appuser:appgroup --from=builder /app/package.json ./
COPY --chown=appuser:appgroup --from=builder /app/bun.lock ./
COPY --chown=appuser:appgroup --from=builder /app/tsconfig.base.json ./

# Re-create workspace symlinks (Docker COPY doesn't preserve cross-tree symlinks)
RUN mkdir -p node_modules/@shogo && \
    ln -sf ../../../packages/shared-runtime node_modules/@shogo/shared-runtime && \
    ln -sf ../../../packages/sdk node_modules/@shogo/sdk && \
    ln -sf ../../../packages/agent-runtime node_modules/@shogo/agent-runtime && \
    ln -sf ../../../packages/model-catalog node_modules/@shogo/model-catalog && \
    chown -h appuser:appgroup node_modules/@shogo node_modules/@shogo/*

# Stub package.jsons for workspace members not shipped in the image
COPY --chown=appuser:appgroup --from=builder /app/packages/domain-stores/package.json ./packages/domain-stores/
COPY --chown=appuser:appgroup --from=builder /app/packages/shared-app/package.json ./packages/shared-app/
COPY --chown=appuser:appgroup --from=builder /app/packages/shared-ui/package.json ./packages/shared-ui/
COPY --chown=appuser:appgroup --from=builder /app/packages/ui-kit/package.json ./packages/ui-kit/
COPY --chown=appuser:appgroup --from=builder /app/packages/canvas-runtime/package.json ./packages/canvas-runtime/
COPY --chown=appuser:appgroup --from=builder /app/packages/model-catalog ./packages/model-catalog/
COPY --chown=appuser:appgroup --from=builder /app/apps/mobile/package.json ./apps/mobile/

# Same patches as builder/deps stages — bun install --ignore-scripts at line ~189
# also resolves `patchedDependencies` and fails without these files.
COPY --chown=appuser:appgroup --from=builder /app/patches ./patches

# Copy prisma schema, config, and migrations for runtime migrations
COPY --chown=appuser:appgroup --from=builder /app/prisma ./prisma
COPY --chown=appuser:appgroup --from=builder /app/prisma.config.ts ./prisma.config.ts

# Copy SDK examples folder for templates API
COPY --chown=appuser:appgroup packages/sdk/examples ./packages/sdk/examples

# Copy runtime template for RuntimeManager project initialization
COPY --chown=appuser:appgroup templates/runtime-template ./templates/runtime-template

# Copy entrypoint script
COPY --chown=appuser:appgroup apps/api/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Create directories and set permissions (must be done as root)
RUN mkdir -p /app/workspaces /app/.claude && \
    chmod 777 /app /app/.claude && \
    chown appuser:appgroup /app/workspaces /app/.claude

# Switch to non-root user before rebuilding workspace links
USER appuser

# Rebuild per-package module resolution links from .bun/ cache (no downloads).
# Running as appuser so output is correctly owned — no chown -R needed.
RUN bun install --ignore-scripts

# Build hash for version detection (set at build time by CI)
ARG BUILD_HASH=dev
ENV BUILD_HASH=$BUILD_HASH

# Environment defaults
ENV NODE_ENV=production
ENV API_PORT=8002

# Expose API port and Vite runtime ports
EXPOSE 8002
EXPOSE 5200-5209

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -sf http://localhost:${API_PORT}/api/health || exit 1

# Run API server
WORKDIR /app/apps/api
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["bun", "run", "src/entry.ts"]

