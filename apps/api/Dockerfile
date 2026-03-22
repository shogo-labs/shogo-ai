# =============================================================================
# Shogo API Server Dockerfile
# =============================================================================
# Multi-stage build for production-optimized API server
# Runs Hono server on port 8002 (configurable via API_PORT)
# Includes BetterAuth for authentication
# =============================================================================

FROM oven/bun:1.3-alpine AS builder

WORKDIR /app

# Copy workspace root files
COPY package.json bun.lock ./
COPY tsconfig.base.json ./

# Copy package.json files for dependency resolution
# All workspace members must be present for bun install to succeed
COPY packages/project-runtime/package.json ./packages/project-runtime/
COPY packages/agent-runtime/package.json ./packages/agent-runtime/
COPY packages/shared-runtime/package.json ./packages/shared-runtime/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/domain-stores/package.json ./packages/domain-stores/
COPY packages/shared-app/package.json ./packages/shared-app/
COPY packages/shared-ui/package.json ./packages/shared-ui/
COPY packages/ui-kit/package.json ./packages/ui-kit/
COPY apps/api/package.json ./apps/api/
COPY apps/mobile/package.json ./apps/mobile/

# Copy scripts needed for postinstall (patch-claude-sdk runs during bun install)
COPY scripts ./scripts

# Install all dependencies
RUN bun install

# Copy source code
COPY packages/project-runtime ./packages/project-runtime
COPY packages/agent-runtime ./packages/agent-runtime
COPY packages/shared-runtime ./packages/shared-runtime
COPY packages/sdk ./packages/sdk
COPY apps/api ./apps/api
COPY templates/runtime-template ./templates/runtime-template

# Copy prisma schema and config for generation
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts

# Generate Prisma client (must be done before building apps)
# Use local prisma from node_modules to ensure correct version (v6)
# Provide a placeholder DATABASE_URL (not used during generation, but schema validation requires it)
RUN DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder" \
    ./node_modules/.bin/prisma generate

# Build SDK first (dependency of api)
WORKDIR /app/packages/sdk
RUN bun run build

# Clean per-package node_modules (bun symlinks that resolve via .bun/ cache).
# These are rebuilt in the production stage via `bun install --ignore-scripts`.
WORKDIR /app
RUN rm -rf packages/*/node_modules

# =============================================================================
# Production image
# =============================================================================
# Use Node.js 22 Alpine as base (Vite 7 requires Node.js 20.19+ or 22.12+)
FROM node:25-alpine

WORKDIR /app

# Install curl for healthchecks, bash for shell, and Bun
RUN apk add --no-cache curl bash unzip && \
    curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v1.3.9" && \
    rm -rf /root/.bun

# Install Claude Code CLI globally (required for ai-sdk-provider-claude-code)
RUN npm install -g @anthropic-ai/claude-code

# Set SHELL environment variable (required by Claude Code CLI)
ENV SHELL=/bin/bash

# Create non-root user for security (required for Claude Code CLI)
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

# Copy built artifacts with --chown (avoids expensive recursive chown layer duplication)
COPY --chown=appuser:appgroup --from=builder /app/node_modules ./node_modules
COPY --chown=appuser:appgroup --from=builder /app/packages/project-runtime ./packages/project-runtime
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
    ln -sf ../../../packages/project-runtime node_modules/@shogo/project-runtime && \
    ln -sf ../../../packages/agent-runtime node_modules/@shogo/agent-runtime && \
    chown -h appuser:appgroup node_modules/@shogo node_modules/@shogo/*

# Stub package.jsons for workspace members not shipped in the image
# (required by bun install to resolve the workspace graph)
COPY --from=builder /app/packages/domain-stores/package.json ./packages/domain-stores/
COPY --from=builder /app/packages/shared-app/package.json ./packages/shared-app/
COPY --from=builder /app/packages/shared-ui/package.json ./packages/shared-ui/
COPY --from=builder /app/packages/ui-kit/package.json ./packages/ui-kit/
COPY --from=builder /app/apps/mobile/package.json ./apps/mobile/

# Rebuild per-package module resolution links. The builder stage deletes
# packages/*/node_modules to avoid COPY bloat, but that also removes symlinks
# for non-hoisted deps (e.g. @aws-sdk/client-s3 in shared-runtime).
# Re-running install rebuilds them from the .bun/ cache without re-downloading.
RUN bun install --ignore-scripts && \
    chown -R appuser:appgroup node_modules

# Copy prisma schema, config, and migrations for runtime migrations
COPY --chown=appuser:appgroup --from=builder /app/prisma ./prisma
COPY --chown=appuser:appgroup --from=builder /app/prisma.config.ts ./prisma.config.ts

# Copy SDK examples folder for templates API
COPY packages/sdk/examples ./packages/sdk/examples

# Copy runtime template for RuntimeManager project initialization
COPY --chown=appuser:appgroup templates/runtime-template ./templates/runtime-template

# Copy entrypoint script
COPY apps/api/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Create workspaces directory placeholder
RUN mkdir -p /app/workspaces

# Create .claude directory for Claude Code SDK
# Make /app and .claude world-writable so any user (including host UID override) can write
RUN mkdir -p /app/.claude && \
    chmod 777 /app /app/.claude

# Set ownership on specific directories (COPY --chown handled the rest)
RUN chown -R appuser:appgroup /app/workspaces /app/.claude

# Switch to non-root user
# Note: For development with mounted volumes, may need to run as root
# or use matching UID via docker-compose user directive
USER appuser

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

