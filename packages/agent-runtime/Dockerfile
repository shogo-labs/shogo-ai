# syntax=docker/dockerfile:1.4
# =============================================================================
# Unified Runtime Dockerfile
# =============================================================================
# Builds on the pre-built base image (Dockerfile.base) which contains system
# packages, Claude Code CLI, template archives, and MCP servers.
# This layer only adds application source code and bun dependencies.
#
# Build: DOCKER_BUILDKIT=1 docker build \
#          --build-arg BASE_IMAGE=<ecr>/shogo/shogo-runtime-base:latest \
#          -t runtime -f packages/agent-runtime/Dockerfile .
# Run:   docker run -e PROJECT_ID=test -e AI_PROXY_TOKEN=... runtime
# =============================================================================

ARG BASE_IMAGE=shogo-runtime-base:latest

# =============================================================================
# Stage 0: canvas-build — build canvas-runtime static assets (native arch)
# =============================================================================
# Canvas-runtime produces platform-independent HTML/CSS/JS, so we build it
# without QEMU to avoid the massive slowdown of running Vite under emulation.
FROM --platform=$BUILDPLATFORM oven/bun:1.3-alpine AS canvas-build

WORKDIR /app

COPY package.json bun.lock ./
COPY tsconfig.base.json ./

COPY packages/canvas-runtime/package.json ./packages/canvas-runtime/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/project-runtime/package.json ./packages/project-runtime/
COPY packages/agent-runtime/package.json ./packages/agent-runtime/
COPY packages/shared-runtime/package.json ./packages/shared-runtime/
COPY packages/domain-stores/package.json ./packages/domain-stores/
COPY packages/shared-app/package.json ./packages/shared-app/
COPY packages/shared-ui/package.json ./packages/shared-ui/
COPY packages/ui-kit/package.json ./packages/ui-kit/
COPY apps/api/package.json ./apps/api/
COPY apps/mobile/package.json ./apps/mobile/

COPY scripts ./scripts
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
COPY prisma.config.local.ts ./prisma.config.local.ts

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install

COPY packages/sdk ./packages/sdk
COPY packages/canvas-runtime ./packages/canvas-runtime

RUN bun run --cwd packages/canvas-runtime build

# =============================================================================
# Stage 1: builder — install all deps, copy source
# =============================================================================
FROM oven/bun:1.3-alpine AS builder

WORKDIR /app

COPY package.json bun.lock ./
COPY tsconfig.base.json ./

COPY packages/project-runtime/package.json ./packages/project-runtime/
COPY packages/agent-runtime/package.json ./packages/agent-runtime/
COPY packages/shared-runtime/package.json ./packages/shared-runtime/
COPY packages/canvas-runtime/package.json ./packages/canvas-runtime/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/domain-stores/package.json ./packages/domain-stores/
COPY packages/shared-app/package.json ./packages/shared-app/
COPY packages/shared-ui/package.json ./packages/shared-ui/
COPY packages/ui-kit/package.json ./packages/ui-kit/
COPY apps/api/package.json ./apps/api/
COPY apps/mobile/package.json ./apps/mobile/

COPY scripts ./scripts

# Copy prisma schema and config before install (postinstall runs db:generate:all)
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
COPY prisma.config.local.ts ./prisma.config.local.ts

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install

COPY packages/shared-runtime ./packages/shared-runtime
COPY packages/agent-runtime ./packages/agent-runtime
COPY templates/runtime-template ./templates/runtime-template

# Fetch external Claude Code skills from skill-registry.json
RUN apk add --no-cache git && \
    bun run scripts/fetch-external-skills.ts && \
    apk del git

RUN rm -rf packages/*/node_modules apps/*/node_modules

# =============================================================================
# Stage 2: deps — full node_modules with workspace links
# =============================================================================
FROM oven/bun:1.3-alpine AS deps

WORKDIR /app

COPY package.json bun.lock ./
COPY tsconfig.base.json ./

COPY packages/project-runtime/package.json ./packages/project-runtime/
COPY packages/agent-runtime/package.json ./packages/agent-runtime/
COPY packages/shared-runtime/package.json ./packages/shared-runtime/
COPY packages/canvas-runtime/package.json ./packages/canvas-runtime/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/domain-stores/package.json ./packages/domain-stores/
COPY packages/shared-app/package.json ./packages/shared-app/
COPY packages/shared-ui/package.json ./packages/shared-ui/
COPY packages/ui-kit/package.json ./packages/ui-kit/
COPY apps/api/package.json ./apps/api/
COPY apps/mobile/package.json ./apps/mobile/

COPY scripts ./scripts

# Copy prisma schema and config before install (postinstall runs db:generate:all)
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
COPY prisma.config.local.ts ./prisma.config.local.ts

RUN bun install && \
    echo "Installed $(ls node_modules/ | wc -l) packages"

# =============================================================================
# Stage 3: production image — layer source code onto base image
# =============================================================================
FROM ${BASE_IMAGE}

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=appuser:appgroup --from=builder /app/packages/shared-runtime ./packages/shared-runtime
COPY --chown=appuser:appgroup --from=builder /app/packages/agent-runtime ./packages/agent-runtime
COPY --chown=appuser:appgroup --from=canvas-build /app/packages/canvas-runtime/dist ./packages/canvas-runtime/dist
COPY --chown=appuser:appgroup --from=builder /app/templates/runtime-template ./templates/runtime-template
COPY --chown=appuser:appgroup --from=builder /app/package.json ./
COPY --chown=appuser:appgroup --from=builder /app/bun.lock ./
COPY --chown=appuser:appgroup --from=builder /app/tsconfig.base.json ./

# Workspace member package.jsons for bun resolution
COPY --from=builder /app/packages/project-runtime/package.json ./packages/project-runtime/
COPY --from=builder /app/packages/canvas-runtime/package.json ./packages/canvas-runtime/
COPY --from=builder /app/packages/sdk/package.json ./packages/sdk/
COPY --from=builder /app/packages/domain-stores/package.json ./packages/domain-stores/
COPY --from=builder /app/packages/shared-app/package.json ./packages/shared-app/
COPY --from=builder /app/packages/shared-ui/package.json ./packages/shared-ui/
COPY --from=builder /app/packages/ui-kit/package.json ./packages/ui-kit/
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/apps/mobile/package.json ./apps/mobile/

RUN bun install --ignore-scripts && \
    chown -R appuser:appgroup node_modules

COPY --chown=appuser:appgroup packages/agent-runtime/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production
ENV PORT=8080
ENV WORKSPACE_DIR=/app/workspace
ENV SCHEMAS_PATH=/app/.schemas
ENV MCP_SERVER_PATH=/app/packages/agent-runtime/src/tools/mcp-server.ts
ENV HOME=/app

WORKDIR /app/workspace

EXPOSE 8080 5173

HEALTHCHECK --interval=3s --timeout=2s --start-period=5s --retries=10 \
  CMD curl -sf http://localhost:8080/health || exit 1

USER appuser

ENTRYPOINT ["/entrypoint.sh"]
