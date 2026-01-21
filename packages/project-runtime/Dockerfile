# =============================================================================
# Project Runtime Dockerfile
# =============================================================================
# Runs Claude Code agent + MCP + Vite in an isolated per-project pod.
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
# Production image
# =============================================================================
FROM oven/bun:1.2-alpine

WORKDIR /app

# Install required system packages:
# - curl: health checks
# - nodejs + npm: Claude Code CLI
# - bash: Claude Code requires SHELL=/bin/bash
# - git: for project operations
RUN apk add --no-cache curl nodejs npm bash git

# Install Claude Code CLI globally (required for ai-sdk-provider-claude-code)
RUN npm install -g @anthropic-ai/claude-code

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

# Expose ports:
# - 8080: Agent server (chat endpoint)
# - 5173: Vite preview server
EXPOSE 8080 5173

# Health check
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:8080/health || exit 1

# Switch to non-root user
USER appuser

ENTRYPOINT ["/entrypoint.sh"]
