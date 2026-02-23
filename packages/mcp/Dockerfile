# =============================================================================
# Shogo MCP Server Dockerfile
# =============================================================================
# Multi-stage build for production-optimized MCP server
# Runs the HTTP server on port 3100 (configurable via MCP_PORT)
# =============================================================================

FROM oven/bun:1.3-alpine AS builder

WORKDIR /app

# Copy workspace root files
COPY package.json bun.lock ./
COPY tsconfig.base.json ./

# Copy package.json files for dependency resolution
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

# Copy scripts needed for postinstall
COPY scripts ./scripts

# Install all dependencies
RUN bun install

# Copy source code
COPY packages/state-api ./packages/state-api
COPY packages/shared-runtime ./packages/shared-runtime
COPY packages/mcp ./packages/mcp

# Copy domain schemas (studio-core, platform-features, etc.)
# Schemas are located inside the mcp package
COPY packages/mcp/.schemas ./.schemas

# Build state-api first (dependency)
WORKDIR /app/packages/state-api
RUN bun run build

# Build mcp
WORKDIR /app/packages/mcp
RUN bun run build || true

# =============================================================================
# Production image
# =============================================================================
FROM oven/bun:1.3-alpine

WORKDIR /app

# Install curl for healthchecks
RUN apk add --no-cache curl

# Copy built artifacts and node_modules
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/state-api ./packages/state-api
COPY --from=builder /app/packages/shared-runtime ./packages/shared-runtime
COPY --from=builder /app/packages/mcp ./packages/mcp
COPY --from=builder /app/package.json ./
COPY --from=builder /app/tsconfig.base.json ./

# Copy domain schemas from builder
COPY --from=builder /app/.schemas ./.schemas

# Create data directory for user schemas (mounted volume in production)
RUN mkdir -p /data/schemas

# Environment defaults
# SCHEMAS_PATH points to bundled schemas; user data goes to /data/schemas via volume
ENV NODE_ENV=production
ENV SCHEMAS_PATH=/app/.schemas
ENV MCP_PORT=3100

# Expose MCP port
EXPOSE 3100

# Health check - FastMCP exposes /mcp and /sse endpoints
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:${MCP_PORT}/mcp -o /dev/null || curl -sf http://localhost:${MCP_PORT}/sse -o /dev/null || exit 1

# Run MCP HTTP server
WORKDIR /app/packages/mcp
CMD ["bun", "run", "src/server-http.ts"]

