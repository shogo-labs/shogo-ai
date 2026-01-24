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
# Pre-install ALL template dependencies (dramatically speeds up template.copy)
# =============================================================================
# Instead of a generic cache, we install each template's exact dependencies.
# This allows template.copy to copy node_modules directly (~1-2s vs ~12s for bun install)
# =============================================================================
FROM oven/bun:1.2-alpine AS template-deps

WORKDIR /templates

# Copy all SDK examples (templates)
COPY packages/sdk/examples ./examples
# Copy the SDK package itself (templates depend on @shogo-ai/sdk)
COPY packages/sdk/package.json ./sdk-package.json
COPY packages/sdk/src ./sdk-src

# Install dependencies for each template
# Templates don't have lockfiles committed, so bun will generate them
RUN cd /templates/examples/todo-app && bun install && \
    cd /templates/examples/expense-tracker && bun install && \
    cd /templates/examples/crm && bun install && \
    cd /templates/examples/inventory && bun install && \
    cd /templates/examples/kanban && bun install && \
    cd /templates/examples/ai-chat && bun install && \
    cd /templates/examples/form-builder && bun install && \
    cd /templates/examples/feedback-form && bun install && \
    cd /templates/examples/booking-app && bun install

# Generate bun.lock files for each template (helps with faster subsequent installs)
RUN for dir in /templates/examples/*/; do \
      if [ -f "$dir/package.json" ]; then \
        echo "Generated lockfile for $(basename $dir)"; \
      fi; \
    done

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

# Copy SDK examples WITH pre-installed node_modules from template-deps stage
# This allows template.copy to copy node_modules directly (~1-2s vs ~12s for bun install)
COPY --from=template-deps /templates/examples ./packages/sdk/examples

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
