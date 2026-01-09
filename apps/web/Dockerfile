# =============================================================================
# Shogo Web Frontend Dockerfile
# =============================================================================
# Multi-stage build:
# 1. Build React app with Vite
# 2. Serve static files with Nginx
# =============================================================================

FROM oven/bun:1.2-alpine AS builder

WORKDIR /app

# Build arguments for Vite environment variables
ARG VITE_API_URL=http://localhost:8002
ARG VITE_MCP_URL=http://localhost:3100
ARG VITE_BETTER_AUTH_URL=http://localhost:8002
ARG VITE_WORKSPACE=local-dev

# Set as environment variables for build
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_MCP_URL=$VITE_MCP_URL
ENV VITE_BETTER_AUTH_URL=$VITE_BETTER_AUTH_URL
ENV VITE_WORKSPACE=$VITE_WORKSPACE

# Copy workspace root files
COPY package.json bun.lock ./
COPY tsconfig.base.json ./

# Copy package.json files for dependency resolution
COPY packages/state-api/package.json ./packages/state-api/
COPY packages/mcp/package.json ./packages/mcp/
COPY apps/web/package.json ./apps/web/

# Install all dependencies
RUN bun install

# Copy source code (including mcp for raw imports in WavesmithMetaDemo)
COPY packages/state-api ./packages/state-api
COPY packages/mcp ./packages/mcp
COPY apps/web ./apps/web

# Build state-api first (dependency)
WORKDIR /app/packages/state-api
RUN bun run build

# Build web app
WORKDIR /app/apps/web
RUN bun run build

# =============================================================================
# Production image with Nginx
# =============================================================================
FROM nginx:alpine

# Copy built static files
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

# Copy nginx configuration
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

# Expose port 80
EXPOSE 80

# Nginx runs in foreground by default
CMD ["nginx", "-g", "daemon off;"]

