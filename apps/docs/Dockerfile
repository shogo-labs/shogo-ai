# =============================================================================
# Shogo Docs Dockerfile
# =============================================================================
# Multi-stage build:
# 1. Build Docusaurus static site with Bun
# 2. Serve static files with Nginx
# =============================================================================

FROM --platform=$BUILDPLATFORM oven/bun:1.3-alpine AS builder

WORKDIR /app

# Copy package files and lockfile for deterministic dependency resolution
COPY apps/docs/package.json ./package.json
COPY apps/docs/bun.lock ./bun.lock

# Install dependencies
RUN bun install --frozen-lockfile

# Copy docs source
COPY apps/docs/ ./

# Build the Docusaurus site
RUN bun run build

# =============================================================================
# Production image with Nginx
# =============================================================================
FROM nginx:alpine

# Copy built static files
COPY --from=builder /app/build /usr/share/nginx/html

# Copy nginx configuration
COPY apps/docs/nginx.conf /etc/nginx/conf.d/default.conf

# Expose port 80
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
