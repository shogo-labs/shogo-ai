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
COPY apps/api/package.json ./apps/api/

# Install all dependencies
RUN bun install

# Copy source code
COPY packages/state-api ./packages/state-api
COPY apps/api ./apps/api

# Build state-api first (dependency)
WORKDIR /app/packages/state-api
RUN bun run build

# =============================================================================
# Production image
# =============================================================================
FROM oven/bun:1.2-alpine

WORKDIR /app

# Install curl for healthchecks
RUN apk add --no-cache curl

# Create non-root user for security (required for Claude Code CLI)
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

# Copy built artifacts and node_modules
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/state-api ./packages/state-api
COPY --from=builder /app/apps/api ./apps/api
COPY --from=builder /app/package.json ./
COPY --from=builder /app/tsconfig.base.json ./

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

