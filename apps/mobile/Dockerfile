# =============================================================================
# Shogo Web Frontend Dockerfile (Expo Web Export)
# =============================================================================
# Multi-stage build:
# 1. Install workspace deps with Bun, build with Expo/Metro (requires Node)
# 2. Serve static files with Nginx (reverse proxy for /api)
# =============================================================================

FROM --platform=$BUILDPLATFORM node:22-alpine AS builder

WORKDIR /app

# Build arguments — empty defaults produce relative URLs (proxied by nginx)
ARG EXPO_PUBLIC_API_URL=
ARG EXPO_PUBLIC_BUILD_HASH=dev
ARG GA4_MEASUREMENT_ID=
ARG FB_PIXEL_ID=
ENV EXPO_PUBLIC_API_URL=$EXPO_PUBLIC_API_URL
ENV EXPO_PUBLIC_BUILD_HASH=$EXPO_PUBLIC_BUILD_HASH
ENV EXPO_PUBLIC_GA4_ID=$GA4_MEASUREMENT_ID
ENV EXPO_PUBLIC_FB_PIXEL_ID=$FB_PIXEL_ID

# Install Bun (used for fast dependency installation)
RUN apk add --no-cache bash curl && \
    curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v1.3.9" && \
    rm -rf /root/.bun

# Copy workspace root files
COPY package.json bun.lock ./
COPY tsconfig.base.json ./

# Copy all workspace member package.json files for dependency resolution
COPY packages/project-runtime/package.json ./packages/project-runtime/
COPY packages/agent-runtime/package.json ./packages/agent-runtime/
COPY packages/shared-runtime/package.json ./packages/shared-runtime/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/domain-stores/package.json ./packages/domain-stores/
COPY packages/shared-app/package.json ./packages/shared-app/
COPY packages/shared-ui/package.json ./packages/shared-ui/
COPY packages/ui-kit/package.json ./packages/ui-kit/
COPY apps/api/package.json ./apps/api/
COPY apps/mobile/package.json ./apps/mobile/

# Copy scripts needed for postinstall
COPY scripts ./scripts

# Copy prisma schema and config before install (postinstall runs db:generate:all)
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
COPY prisma.config.local.ts ./prisma.config.local.ts

# Install all dependencies (postinstall generates Prisma client)
RUN bun install

# Copy workspace packages consumed by the mobile app
COPY packages/domain-stores ./packages/domain-stores
COPY packages/shared-app ./packages/shared-app
COPY packages/shared-ui ./packages/shared-ui
COPY packages/ui-kit ./packages/ui-kit
COPY packages/sdk ./packages/sdk

# Copy the mobile app source
COPY apps/mobile ./apps/mobile

# Build SDK (Metro resolves @shogo-ai/sdk → dist/index.js)
WORKDIR /app/packages/sdk
RUN bun run build

# Build Expo web export (Metro bundler outputs to apps/mobile/dist/)
WORKDIR /app/apps/mobile
RUN npx expo export --platform web

# Inject analytics scripts into the exported HTML (Expo "single" mode strips
# <script> tags from +html.tsx, so we inject them post-export)
RUN node scripts/inject-analytics.js

# =============================================================================
# Production image with Nginx
# =============================================================================
FROM nginx:alpine

ENV API_UPSTREAM=http://shogo-api.shogo-system.svc.cluster.local:8002
ENV API_HOST=shogo-api.shogo-system.svc.cluster.local
ENV DNS_RESOLVER=kube-dns.kube-system.svc.cluster.local

# Copy built static files
COPY --from=builder /app/apps/mobile/dist /usr/share/nginx/html

# Copy nginx configuration template
COPY apps/mobile/nginx.conf /etc/nginx/nginx.conf.template

EXPOSE 80

CMD ["/bin/sh", "-c", "envsubst '${API_UPSTREAM} ${API_HOST} ${DNS_RESOLVER}' < /etc/nginx/nginx.conf.template > /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"]
