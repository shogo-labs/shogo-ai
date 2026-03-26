# syntax=docker/dockerfile:1.4
# =============================================================================
# Project Runtime Dockerfile (Optimized for Fast Cold Start + Fast Builds)
# =============================================================================
# Runs Claude Code agent + MCP + Vite in an isolated per-project pod.
#
# Build Optimizations (uses BuildKit):
# - 4 parallel stages: builder, deps, template-deps run concurrently
# - Per-package node_modules cleaned to avoid bun symlink resolution bloat
# - COPY --chown eliminates expensive 90s recursive chown on GBs of data
# - pigz for parallel gzip compression of template archives
# - tsc skipped in Docker (not needed at runtime, bun handles TS natively)
#
# Runtime Optimizations:
# - Pre-installed template dependencies (no bun install on cold start)
# - Pre-built templates (no vite build on cold start)
# - S3 archive sync (single tar.gz instead of thousands of files)
# - Deferred initialization (server starts before build completes)
#
# Build: DOCKER_BUILDKIT=1 docker build -t project-runtime -f packages/project-runtime/Dockerfile .
# Run:   docker run -e PROJECT_ID=test -e ANTHROPIC_API_KEY=sk-... project-runtime
# =============================================================================

# =============================================================================
# Stage 1: builder — install all deps, build packages
# =============================================================================
FROM oven/bun:1.3-alpine AS builder

WORKDIR /app

# Copy workspace root files
COPY package.json bun.lock ./
COPY tsconfig.base.json ./

# Copy package.json files for dependency resolution (cached layer)
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

# Copy prisma schema and config before install (postinstall runs db:generate:all)
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
COPY prisma.config.local.ts ./prisma.config.local.ts

# Install all dependencies (with BuildKit cache mount for faster rebuilds)
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install

# Copy source code (this layer invalidates when source changes)
COPY packages/shared-runtime ./packages/shared-runtime
COPY packages/project-runtime ./packages/project-runtime
COPY templates/runtime-template ./templates/runtime-template

# ---------------------------------------------------------------------------
# Clean per-package node_modules BEFORE the production stage copies.
# Bun workspaces create symlinked node_modules in each package that resolve
# back to the workspace root. Docker COPY follows symlinks, so copying
# packages would pull in duplicated deps. The workspace root
# node_modules (copied separately) has everything bun needs at runtime.
# ---------------------------------------------------------------------------
WORKDIR /app
RUN rm -rf packages/*/node_modules apps/*/node_modules

# =============================================================================
# Stage 2: deps — full node_modules with all workspace member dependencies
# =============================================================================
# Runs IN PARALLEL with builder (BuildKit). Full install (not --production)
# is required because bun install --production doesn't reliably install
# workspace member dependencies (e.g. hono, ai, zod from project-runtime).
# =============================================================================
FROM oven/bun:1.3-alpine AS deps

WORKDIR /app

COPY package.json bun.lock ./
COPY tsconfig.base.json ./

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

COPY scripts ./scripts

# Copy prisma schema and config before install (postinstall runs db:generate:all)
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
COPY prisma.config.local.ts ./prisma.config.local.ts

RUN bun install && \
    echo "Installed $(ls node_modules/ | wc -l) packages (full install, not --production)"

# =============================================================================
# Stage 3: template-deps — pre-install and pre-build all templates
# =============================================================================
# Runs IN PARALLEL with builder and production-deps (BuildKit).
# =============================================================================
FROM oven/bun:1.3-alpine AS template-deps

# pigz = parallel gzip — uses all CPU cores for compression
RUN apk add --no-cache pigz

WORKDIR /templates

# Copy package.json + bun.lock files (dependency caching layer).
# Including the lockfile lets us use --frozen-lockfile which skips resolution
# entirely and just links from cache — cuts install from ~12s to ~2s per template.
COPY packages/sdk/examples/todo-app/package.json packages/sdk/examples/todo-app/bun.lock ./examples/todo-app/
COPY packages/sdk/examples/expense-tracker/package.json packages/sdk/examples/expense-tracker/bun.lock ./examples/expense-tracker/
COPY packages/sdk/examples/crm/package.json packages/sdk/examples/crm/bun.lock ./examples/crm/
COPY packages/sdk/examples/inventory/package.json packages/sdk/examples/inventory/bun.lock ./examples/inventory/
COPY packages/sdk/examples/kanban/package.json packages/sdk/examples/kanban/bun.lock ./examples/kanban/
COPY packages/sdk/examples/ai-chat/package.json packages/sdk/examples/ai-chat/bun.lock ./examples/ai-chat/
COPY packages/sdk/examples/form-builder/package.json packages/sdk/examples/form-builder/bun.lock ./examples/form-builder/
COPY packages/sdk/examples/feedback-form/package.json packages/sdk/examples/feedback-form/bun.lock ./examples/feedback-form/
COPY packages/sdk/examples/booking-app/package.json packages/sdk/examples/booking-app/bun.lock ./examples/booking-app/

# Install dependencies with --frozen-lockfile (skips resolution, just links from cache)
RUN --mount=type=cache,target=/root/.bun/install/cache \
    for template in todo-app expense-tracker crm inventory kanban ai-chat form-builder feedback-form booking-app; do \
      echo "=== Installing deps: $template ===" && \
      cd /templates/examples/$template && \
      bun install --frozen-lockfile && \
      cd /templates; \
    done

# Copy source files
COPY packages/sdk/examples ./examples

# Build templates (prisma generate + vite build)
RUN for template in todo-app expense-tracker crm inventory kanban ai-chat form-builder feedback-form booking-app; do \
      echo "=== Building: $template ===" && \
      cd /templates/examples/$template && \
      if [ -f "prisma/schema.prisma" ]; then \
        bunx --bun prisma generate 2>&1 || true; \
      fi && \
      if grep -q '"build"' package.json 2>/dev/null; then \
        bun run build 2>&1 || echo "Build skipped for $template"; \
      fi && \
      echo "=== $template complete ===" && \
      cd /templates; \
    done

# Create tar.gz archives in PARALLEL using pigz (parallel gzip).
# Sequential tar -czf takes ~300s; parallel pigz cuts to ~60-90s.
RUN mkdir -p /templates/archives && \
    cd /templates/examples && \
    for template in todo-app expense-tracker crm inventory kanban ai-chat form-builder feedback-form booking-app; do \
      ( \
        tar cf - $template | pigz > /templates/archives/${template}.tar.gz && \
        rm -rf /templates/examples/$template && \
        echo "=== $template archived ($(du -h /templates/archives/${template}.tar.gz | cut -f1)) ===" \
      ) & \
    done && \
    wait && \
    rm -rf /templates/examples

# =============================================================================
# Stage 4: production image
# =============================================================================
FROM oven/bun:1.3-alpine

WORKDIR /app

# Install required system packages
RUN echo "https://dl-cdn.alpinelinux.org/alpine/v3.21/main" >> /etc/apk/repositories && \
    apk add --no-cache \
    curl bash git tar gzip \
    'nodejs>22' npm \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

ENV SHELL=/bin/bash

# Create non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

# ---------------------------------------------------------------------------
# Copy node_modules from the parallel deps stage. Per-package node_modules
# were cleaned in the builder so package COPYs only transfer source + dist.
# All COPYs use --chown to set ownership at copy time, avoiding the ~90s
# recursive chown that was duplicating GBs of layer data.
# ---------------------------------------------------------------------------
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=appuser:appgroup --from=builder /app/packages/shared-runtime ./packages/shared-runtime
COPY --chown=appuser:appgroup --from=builder /app/packages/project-runtime ./packages/project-runtime
COPY --chown=appuser:appgroup --from=builder /app/templates/runtime-template ./templates/runtime-template
COPY --chown=appuser:appgroup --from=builder /app/package.json ./
COPY --chown=appuser:appgroup --from=builder /app/bun.lock ./
COPY --chown=appuser:appgroup --from=builder /app/tsconfig.base.json ./

# Workspace member package.jsons needed by bun install for resolution
COPY --from=builder /app/packages/sdk/package.json ./packages/sdk/
COPY --from=builder /app/packages/agent-runtime/package.json ./packages/agent-runtime/
COPY --from=builder /app/packages/domain-stores/package.json ./packages/domain-stores/
COPY --from=builder /app/packages/shared-app/package.json ./packages/shared-app/
COPY --from=builder /app/packages/shared-ui/package.json ./packages/shared-ui/
COPY --from=builder /app/packages/ui-kit/package.json ./packages/ui-kit/
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/apps/mobile/package.json ./apps/mobile/

# Rebuild bun's module resolution links. Docker COPY from the deps stage
# preserves the .bun/ cache (all packages) but destroys the internal symlinks
# bun uses to resolve package names. Re-running install with existing cache
# rebuilds those links instantly without re-downloading.
RUN bun install --ignore-scripts && \
    chown -R appuser:appgroup node_modules

# Copy template archives
COPY --chown=appuser:appgroup --from=template-deps /templates/archives ./packages/sdk/templates

# Create directories for project files and schemas
RUN mkdir -p /app/project /app/.schemas /app/.claude && \
    chown appuser:appgroup /app/project /app/.schemas /app/.claude

COPY --chown=appuser:appgroup packages/project-runtime/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Environment defaults
ENV NODE_ENV=production
ENV PORT=8080
ENV PROJECT_DIR=/app/project
ENV SCHEMAS_PATH=/app/.schemas
ENV MCP_SERVER_PATH=/app/packages/project-runtime/src/mcp-templates.ts
ENV HOME=/app
ENV FAST_START_MODE=true
ENV BUILD_STATUS_FILE=/tmp/build-status
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app/project

EXPOSE 8080 5173

HEALTHCHECK --interval=3s --timeout=2s --start-period=5s --retries=10 \
  CMD curl -sf http://localhost:8080/health || exit 1

USER appuser

ENTRYPOINT ["/entrypoint.sh"]
