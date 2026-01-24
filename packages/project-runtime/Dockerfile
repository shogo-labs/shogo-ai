# syntax=docker/dockerfile:1.4
# =============================================================================
# Project Runtime Dockerfile (Optimized for Fast Cold Start + Fast Builds)
# =============================================================================
# Runs Claude Code agent + MCP + Vite in an isolated per-project pod.
#
# Build Optimizations (uses BuildKit):
# - Layer caching: package.json changes → rebuild deps, source changes → deps cached
# - BuildKit cache mounts: bun install cache persisted across builds
# - Parallel builds: template-deps and builder stages can run in parallel
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

FROM oven/bun:1.2-alpine AS builder

WORKDIR /app

# Copy workspace root files
COPY package.json bun.lock ./
COPY tsconfig.base.json ./

# Copy package.json files for dependency resolution (cached layer)
COPY packages/state-api/package.json ./packages/state-api/
COPY packages/mcp/package.json ./packages/mcp/
COPY packages/project-runtime/package.json ./packages/project-runtime/

# Install all dependencies (with BuildKit cache mount for faster rebuilds)
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install

# Copy source code (this layer invalidates when source changes)
COPY packages/state-api ./packages/state-api
COPY packages/mcp ./packages/mcp
COPY packages/project-runtime ./packages/project-runtime

# Build packages
WORKDIR /app/packages/state-api
RUN bun run build

WORKDIR /app/packages/mcp
RUN bun run build

# =============================================================================
# Pre-install ALL template dependencies (dramatically speeds up template.copy)
# =============================================================================
# CACHING STRATEGY:
# 1. Copy only package.json files first (dependency layer - cached if deps don't change)
# 2. Install dependencies with BuildKit cache mount (reuses bun cache across builds)
# 3. Copy source files (source layer - invalidated when code changes)
# 4. Build templates
#
# This means: if only source code changes, dependency install is skipped entirely.
# =============================================================================
FROM oven/bun:1.2-alpine AS template-deps

WORKDIR /templates

# ---- LAYER 1: Copy package.json files only (for dependency caching) ----
# This layer is cached as long as package.json files don't change
COPY packages/sdk/examples/todo-app/package.json ./examples/todo-app/
COPY packages/sdk/examples/expense-tracker/package.json ./examples/expense-tracker/
COPY packages/sdk/examples/crm/package.json ./examples/crm/
COPY packages/sdk/examples/inventory/package.json ./examples/inventory/
COPY packages/sdk/examples/kanban/package.json ./examples/kanban/
COPY packages/sdk/examples/ai-chat/package.json ./examples/ai-chat/
COPY packages/sdk/examples/form-builder/package.json ./examples/form-builder/
COPY packages/sdk/examples/feedback-form/package.json ./examples/feedback-form/
COPY packages/sdk/examples/booking-app/package.json ./examples/booking-app/

# ---- LAYER 2: Install dependencies (cached if package.json unchanged) ----
# Using BuildKit cache mount for bun's global cache (speeds up repeated builds)
RUN --mount=type=cache,target=/root/.bun/install/cache \
    for template in todo-app expense-tracker crm inventory kanban ai-chat form-builder feedback-form booking-app; do \
      echo "=== Installing deps: $template ===" && \
      cd /templates/examples/$template && \
      bun install && \
      cd /templates; \
    done

# ---- LAYER 3: Copy source files ----
# This layer invalidates when source code changes, but deps layer stays cached
COPY packages/sdk/examples ./examples

# ---- LAYER 4: Build templates (prisma generate + vite build) ----
# Only runs when source changes, deps are already installed
RUN for template in todo-app expense-tracker crm inventory kanban ai-chat form-builder feedback-form booking-app; do \
      echo "=== Building: $template ===" && \
      cd /templates/examples/$template && \
      if [ -f "prisma/schema.prisma" ]; then \
        bunx prisma generate 2>&1 || true; \
      fi && \
      if grep -q '"build"' package.json 2>/dev/null; then \
        bun run build 2>&1 || echo "Build skipped for $template"; \
      fi && \
      echo "=== $template complete ===" && \
      cd /templates; \
    done

# ---- LAYER 5: Create tar.gz archives and delete uncompressed templates ----
# This dramatically reduces image size (compressed vs uncompressed node_modules)
# template.copy extracts from these archives for fast cold starts
RUN mkdir -p /templates/archives && \
    for template in todo-app expense-tracker crm inventory kanban ai-chat form-builder feedback-form booking-app; do \
      echo "=== Archiving: $template ===" && \
      cd /templates/examples && \
      tar -czf /templates/archives/${template}.tar.gz $template && \
      rm -rf /templates/examples/$template && \
      echo "=== $template archived ($(du -h /templates/archives/${template}.tar.gz | cut -f1)) ===" ; \
    done && \
    rmdir /templates/examples

# =============================================================================
# Production image
# =============================================================================
FROM oven/bun:1.2-alpine

WORKDIR /app

# Install required system packages:
# - curl: health checks
# - nodejs + npm: Claude Code CLI
# - bash: Claude Code requires SHELL=/bin/bash
# - git: for project operations
# - tar: for S3 archive sync
# - Chromium dependencies for Playwright E2E tests
RUN apk add --no-cache \
    curl nodejs npm bash git tar gzip \
    # Playwright/Chromium dependencies
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

# Install Claude Code CLI globally (required for ai-sdk-provider-claude-code)
RUN npm install -g @anthropic-ai/claude-code

# Set SHELL environment variable (required by Claude Code CLI)
ENV SHELL=/bin/bash

# Create non-root user for security
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

# Configure Playwright to use system-installed Chromium
# Alpine uses musl-libc so we can't use Playwright's glibc-based browsers
# The system chromium package is installed via apk above
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Copy built artifacts and dependencies
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/state-api ./packages/state-api
COPY --from=builder /app/packages/mcp ./packages/mcp
COPY --from=builder /app/packages/project-runtime ./packages/project-runtime
COPY --from=builder /app/package.json ./
COPY --from=builder /app/tsconfig.base.json ./

# Copy template archives (tar.gz files with node_modules + .output pre-built)
# template.copy extracts from these for instant cold starts with pre-installed deps
COPY --from=template-deps /templates/archives ./packages/sdk/templates

# Create directories for project files and schemas
# /app/project - mounted volume or synced from S3
# /app/.schemas - project-specific schemas
# /app/.claude - Claude Code session data
RUN mkdir -p /app/project /app/.schemas /app/.claude && \
    chown -R appuser:appgroup /app

# Copy entrypoint script
COPY packages/project-runtime/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Environment defaults
ENV NODE_ENV=production
ENV PORT=8080
ENV PROJECT_DIR=/app/project
ENV SCHEMAS_PATH=/app/.schemas
ENV MCP_SERVER_PATH=/app/packages/mcp/src/server.ts
ENV HOME=/app
# Enable fast start mode by default
ENV FAST_START_MODE=true
ENV BUILD_STATUS_FILE=/tmp/build-status
# Playwright: use system Chromium (Alpine doesn't support Playwright's glibc binaries)
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Expose ports:
# - 8080: Agent server (chat endpoint)
# - 5173: Vite preview server
EXPOSE 8080 5173

# Health check - faster interval for quicker cold start detection
HEALTHCHECK --interval=3s --timeout=2s --start-period=5s --retries=10 \
  CMD curl -sf http://localhost:8080/health || exit 1

# Switch to non-root user
USER appuser

ENTRYPOINT ["/entrypoint.sh"]
