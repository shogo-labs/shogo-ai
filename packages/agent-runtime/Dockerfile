# syntax=docker/dockerfile:1.4
# =============================================================================
# Agent Runtime Dockerfile
# =============================================================================
# Runs Claude Code builder AI + Agent Gateway (heartbeat, channels, skills)
# in an isolated per-agent pod.
#
# Much simpler than project-runtime: no Vite, no templates, no Prisma.
# The agent just needs Claude Code CLI, MCP tools, and the agent source.
#
# Build: DOCKER_BUILDKIT=1 docker build -t agent-runtime -f packages/agent-runtime/Dockerfile .
# Run:   docker run -e PROJECT_ID=test -e ANTHROPIC_API_KEY=sk-... agent-runtime
# =============================================================================

FROM oven/bun:1.2-alpine AS builder

WORKDIR /app

# Copy workspace root files
COPY package.json bun.lock ./
COPY tsconfig.base.json ./

# Copy package.json files for dependency resolution (cached layer)
# All workspace members must be present for bun install to succeed
COPY packages/state-api/package.json ./packages/state-api/
COPY packages/mcp/package.json ./packages/mcp/
COPY packages/project-runtime/package.json ./packages/project-runtime/
COPY packages/agent-runtime/package.json ./packages/agent-runtime/
COPY packages/shared-runtime/package.json ./packages/shared-runtime/
COPY packages/sdk/package.json ./packages/sdk/
COPY apps/web/package.json ./apps/web/
COPY apps/api/package.json ./apps/api/
COPY apps/desktop/package.json ./apps/desktop/

# Copy scripts needed for postinstall (patch-claude-sdk runs during bun install)
COPY scripts ./scripts

# Install all dependencies (with BuildKit cache mount for faster rebuilds)
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install

# Copy source code for packages the agent-runtime depends on
COPY packages/shared-runtime ./packages/shared-runtime
COPY packages/agent-runtime ./packages/agent-runtime

# =============================================================================
# Production image
# =============================================================================
FROM oven/bun:1.2-alpine

WORKDIR /app

# Install required system packages:
# - curl: health checks
# - nodejs + npm: Claude Code CLI requires Node.js
# - bash: Claude Code requires SHELL=/bin/bash
# - git: for agent file operations
# - tar: for S3 archive sync
RUN echo "https://dl-cdn.alpinelinux.org/alpine/v3.21/main" >> /etc/apk/repositories && \
    apk add --no-cache \
    curl bash git tar gzip \
    'nodejs>22' npm

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Set SHELL environment variable (required by Claude Code CLI)
ENV SHELL=/bin/bash

# Create non-root user for security
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

# Copy built artifacts and dependencies
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared-runtime ./packages/shared-runtime
COPY --from=builder /app/packages/agent-runtime ./packages/agent-runtime
COPY --from=builder /app/package.json ./
COPY --from=builder /app/tsconfig.base.json ./

# Create directories for agent workspace, schemas, and Claude Code session data
RUN mkdir -p /app/agent /app/.schemas /app/.claude && \
    chown -R appuser:appgroup /app

# Copy entrypoint script
COPY packages/agent-runtime/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Environment defaults
ENV NODE_ENV=production
ENV PORT=8080
ENV AGENT_DIR=/app/agent
ENV SCHEMAS_PATH=/app/.schemas
ENV MCP_SERVER_PATH=/app/packages/agent-runtime/src/tools/mcp-server.ts
ENV HOME=/app

# Set working directory to the agent workspace
WORKDIR /app/agent

# Expose port (agent server only — no Vite)
EXPOSE 8080

# Health check
HEALTHCHECK --interval=3s --timeout=2s --start-period=5s --retries=10 \
  CMD curl -sf http://localhost:8080/health || exit 1

# Switch to non-root user
USER appuser

ENTRYPOINT ["/entrypoint.sh"]
