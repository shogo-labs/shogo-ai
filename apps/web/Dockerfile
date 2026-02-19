# =============================================================================
# Shogo Web Frontend Dockerfile
# =============================================================================
# Multi-stage build:
# 1. Build React app with Vite
# 2. Serve static files with Nginx
# =============================================================================

FROM oven/bun:1.3-alpine AS builder

WORKDIR /app

# Build arguments for Vite environment variables
# Empty defaults allow the code to use relative paths (for k8s deployment)
ARG VITE_API_URL=
ARG VITE_MCP_URL=
ARG VITE_BETTER_AUTH_URL=
# VITE_WORKSPACE must match the S3 schema prefix (default: "workspace")
ARG VITE_WORKSPACE=workspace

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
COPY packages/project-runtime/package.json ./packages/project-runtime/
COPY packages/agent-runtime/package.json ./packages/agent-runtime/
COPY packages/shared-runtime/package.json ./packages/shared-runtime/
COPY packages/sdk/package.json ./packages/sdk/
COPY apps/web/package.json ./apps/web/
COPY apps/api/package.json ./apps/api/
RUN mkdir -p apps/desktop && echo '{"name":"@shogo/desktop","version":"0.1.0","private":true}' > apps/desktop/package.json

# Copy scripts needed for postinstall
COPY scripts ./scripts

# Install all dependencies
RUN bun install

# Copy source code (including mcp for raw imports in ShogoMetaDemo)
COPY packages/state-api ./packages/state-api
COPY packages/mcp ./packages/mcp
COPY packages/sdk ./packages/sdk
COPY apps/web ./apps/web

# Copy scripts directory (needed for list-skills.ts)
COPY scripts ./scripts

# Copy .claude/skills directory (needed for list-skills.ts)
COPY .claude/skills ./.claude/skills

# Build SDK first (dependency)
WORKDIR /app/packages/sdk
RUN bun run build

# Build state-api (dependency)
WORKDIR /app/packages/state-api
RUN bun run build

# Build web app
WORKDIR /app/apps/web
RUN bun run build

# =============================================================================
# Production image with Nginx
# =============================================================================
FROM nginx:alpine

# Default API and MCP upstream (overridden by environment variables at runtime)
ENV API_UPSTREAM=http://shogo-api.shogo-system.svc.cluster.local:8002
ENV API_HOST=shogo-api.shogo-system.svc.cluster.local
# MCP proxies to platform-mcp singleton (not per-workspace)
ENV MCP_UPSTREAM=http://platform-mcp.shogo-system.svc.cluster.local:3100
ENV MCP_HOST=platform-mcp.shogo-system.svc.cluster.local
# DNS resolver: Docker=127.0.0.11, K8s=kube-dns.kube-system.svc.cluster.local
ENV DNS_RESOLVER=kube-dns.kube-system.svc.cluster.local

# Copy built static files
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

# Copy nginx configuration template (NOT to templates/ dir - we handle envsubst ourselves)
COPY apps/web/nginx.conf /etc/nginx/nginx.conf.template

# Expose port 80
EXPOSE 80

# Custom entrypoint: run envsubst on API, MCP, and DNS variables, then start nginx
CMD ["/bin/sh", "-c", "envsubst '${API_UPSTREAM} ${API_HOST} ${MCP_UPSTREAM} ${MCP_HOST} ${DNS_RESOLVER}' < /etc/nginx/nginx.conf.template > /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"]

