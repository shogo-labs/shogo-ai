# =============================================================================
# Shogo API Server Dockerfile
# =============================================================================
# Multi-stage build for production-optimized API server
# Runs Hono server on port 8002 (configurable via API_PORT)
# Includes BetterAuth for authentication
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
COPY apps/api/package.json ./apps/api/

# Install all dependencies
RUN bun install

# Copy source code
COPY packages/state-api ./packages/state-api
COPY packages/mcp ./packages/mcp
COPY packages/project-runtime ./packages/project-runtime
COPY apps/api ./apps/api

# Copy prisma schema for generation
COPY prisma ./prisma

# Generate Prisma client (must be done before building apps)
RUN bunx prisma generate

# Build state-api first (dependency)
WORKDIR /app/packages/state-api
RUN bun run build

# Build MCP package
WORKDIR /app/packages/mcp
RUN bun run build

# =============================================================================
# Production image
# =============================================================================
# Use Node.js 22 Alpine as base (Vite 7 requires Node.js 20.19+ or 22.12+)
FROM node:22-alpine

WORKDIR /app

# Install curl for healthchecks, bash for shell, and Bun
RUN apk add --no-cache curl bash unzip && \
    curl -fsSL https://bun.sh/install | bash && \
    mv /root/.bun/bin/bun /usr/local/bin/ && \
    rm -rf /root/.bun

# Install Claude Code CLI globally (required for ai-sdk-provider-claude-code)
RUN npm install -g @anthropic-ai/claude-code

# Set SHELL environment variable (required by Claude Code CLI)
ENV SHELL=/bin/bash

# Create non-root user for security (required for Claude Code CLI)
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

# Copy built artifacts and node_modules
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/state-api ./packages/state-api
COPY --from=builder /app/packages/mcp ./packages/mcp
COPY --from=builder /app/packages/project-runtime ./packages/project-runtime
COPY --from=builder /app/apps/api ./apps/api
COPY --from=builder /app/package.json ./
COPY --from=builder /app/tsconfig.base.json ./

# Copy prisma schema and migrations for runtime migrations
COPY --from=builder /app/prisma ./prisma

# Copy SDK examples folder for templates API
COPY packages/sdk/examples ./packages/sdk/examples

# Copy entrypoint script
COPY apps/api/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Create workspaces directory placeholder
RUN mkdir -p /app/workspaces

# Create .claude directory for Claude Code SDK
# Make /app and .claude world-writable so any user (including host UID override) can write
RUN mkdir -p /app/.claude && \
    chmod 777 /app /app/.claude

# Change ownership to non-root user (but keep world-writable for host UID override)
RUN chown -R appuser:appgroup /app

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
CMD ["bun", "run", "src/server.ts"]

