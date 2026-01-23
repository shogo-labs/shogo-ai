# =============================================================================
# Project Runtime Dockerfile (Optimized for Fast Cold Start)
# =============================================================================
# Runs Claude Code agent + MCP + Vite in an isolated per-project pod.
#
# Optimizations:
# - Pre-installed common dependencies (React, TanStack, Vite, Prisma)
# - Faster health check interval
# - Deferred initialization (server starts before build completes)
#
# Build: docker build -t project-runtime -f packages/project-runtime/Dockerfile .
# Run:   docker run -e PROJECT_ID=test -e ANTHROPIC_API_KEY=sk-... project-runtime
# =============================================================================

FROM oven/bun:1.2-alpine AS builder

WORKDIR /app

# Copy workspace root files
COPY package.json bun.lock ./
COPY tsconfig.base.json ./

# Copy package.json files for dependency resolution
COPY packages/state-api/package.json ./packages/state-api/
COPY packages/mcp/package.json ./packages/mcp/
COPY packages/project-runtime/package.json ./packages/project-runtime/

# Install all dependencies
RUN bun install

# Copy source code
COPY packages/state-api ./packages/state-api
COPY packages/mcp ./packages/mcp
COPY packages/project-runtime ./packages/project-runtime

# Build state-api (dependency)
WORKDIR /app/packages/state-api
RUN bun run build

# Build MCP package
WORKDIR /app/packages/mcp
RUN bun run build

# =============================================================================
# Pre-install common template dependencies (speeds up runtime bun install)
# =============================================================================
FROM oven/bun:1.2-alpine AS template-deps

WORKDIR /template-cache

# Create package.json with common template dependencies
RUN echo '{"name":"template-cache","private":true,"type":"module","dependencies":{"react":"^18.3.1","react-dom":"^18.3.1","@tanstack/react-start":"^1.114.3","@tanstack/react-router":"^1.114.3","@tanstack/nitro-v2-vite-plugin":"^1.114.3","@prisma/client":"^6.7.0","vite":"^5.4.2","@vitejs/plugin-react":"^4.3.1"},"devDependencies":{"@types/react":"^18.3.3","@types/react-dom":"^18.3.0","prisma":"^6.7.0","typescript":"^5.5.3"}}' > package.json

# Install and cache dependencies
RUN bun install

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
# - Chromium dependencies for Playwright E2E tests
RUN apk add --no-cache \
    curl nodejs npm bash git \
    # Playwright/Chromium dependencies
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

# Install Claude Code CLI globally (required for ai-sdk-provider-claude-code)
RUN npm install -g @anthropic-ai/claude-code

# Install Playwright with Chromium for E2E testing
# Use the system-installed Chromium to avoid downloading ~300MB of binaries
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser
RUN npm install -g playwright && \
    npx playwright install-deps chromium 2>/dev/null || true

# Set SHELL environment variable (required by Claude Code CLI)
ENV SHELL=/bin/bash

# Create non-root user for security
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

# Copy built artifacts and dependencies
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/state-api ./packages/state-api
COPY --from=builder /app/packages/mcp ./packages/mcp
COPY --from=builder /app/packages/project-runtime ./packages/project-runtime
COPY --from=builder /app/package.json ./
COPY --from=builder /app/tsconfig.base.json ./

# Copy SDK examples for template.list and template.copy tools
COPY packages/sdk/examples ./packages/sdk/examples

# Copy pre-installed template dependencies cache
# This dramatically speeds up "bun install" at runtime
COPY --from=template-deps /template-cache/node_modules /template-cache/node_modules
COPY --from=template-deps /template-cache/bun.lock /template-cache/bun.lock

# Create directories for project files and schemas
# /app/project - mounted volume or synced from S3
# /app/.schemas - project-specific schemas
# /app/.claude - Claude Code session data
RUN mkdir -p /app/project /app/.schemas /app/.claude && \
    chown -R appuser:appgroup /app /template-cache

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
# Playwright: use system Chromium to avoid downloading browsers at runtime
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
