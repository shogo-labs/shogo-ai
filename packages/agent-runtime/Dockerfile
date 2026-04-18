# syntax=docker/dockerfile:1.4
# =============================================================================
# Unified Runtime Dockerfile
# =============================================================================
# Builds on the pre-built base image (Dockerfile.base) which contains system
# packages, template archives, and MCP servers.
# This layer only adds application source code and bun dependencies.
#
# Build: DOCKER_BUILDKIT=1 docker build \
#          --build-arg BASE_IMAGE=<ecr>/shogo/shogo-runtime-base:latest \
#          -t runtime -f packages/agent-runtime/Dockerfile .
# Run:   docker run -e PROJECT_ID=test -e AI_PROXY_TOKEN=... runtime
# =============================================================================

ARG BASE_IMAGE=shogo-runtime-base:latest

# =============================================================================
# Stage 0: builder — install all deps, copy source
# =============================================================================
FROM oven/bun:1.3-debian AS builder

WORKDIR /app

COPY package.json bun.lock ./
COPY tsconfig.base.json ./

COPY packages/agent-runtime/package.json ./packages/agent-runtime/
COPY packages/shared-runtime/package.json ./packages/shared-runtime/
COPY packages/canvas-runtime/package.json ./packages/canvas-runtime/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/domain-stores/package.json ./packages/domain-stores/
COPY packages/shared-app/package.json ./packages/shared-app/
COPY packages/shared-ui/package.json ./packages/shared-ui/
COPY packages/ui-kit/package.json ./packages/ui-kit/
COPY packages/model-catalog/package.json ./packages/model-catalog/
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
COPY packages/model-catalog ./packages/model-catalog
COPY packages/sdk ./packages/sdk
COPY templates/runtime-template ./templates/runtime-template

# Pre-install runtime-template dependencies so workspaces get node_modules instantly
RUN cd templates/runtime-template && bun install

# Pre-install skill server dependencies so schema regeneration doesn't need network
RUN mkdir -p templates/skill-server && \
    printf '{"name":"skill-server","private":true,"dependencies":{"hono":"^4.7.0","prisma":"7.4.1","@prisma/client":"7.4.1","prisma-adapter-bun-sqlite":"^0.6.8"}}' \
      > templates/skill-server/package.json && \
    cd templates/skill-server && bun install

# Fetch external Claude Code skills from skill-registry.json
RUN apt-get update && apt-get install -y --no-install-recommends git && \
    bun run scripts/fetch-external-skills.ts && \
    apt-get purge -y git && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

RUN rm -rf packages/*/node_modules apps/*/node_modules

# =============================================================================
# Stage 1: deps — full node_modules with workspace links
# =============================================================================
FROM oven/bun:1.3-debian AS deps

WORKDIR /app

# Create user matching production uid so node_modules is pre-owned by uid 1001.
# COPY --from=deps preserves ownership, so no --chown or chown -R needed later.
RUN groupadd -g 1001 appgroup && useradd -u 1001 -g appgroup appuser

COPY package.json bun.lock ./
COPY tsconfig.base.json ./

COPY packages/agent-runtime/package.json ./packages/agent-runtime/
COPY packages/shared-runtime/package.json ./packages/shared-runtime/
COPY packages/canvas-runtime/package.json ./packages/canvas-runtime/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/domain-stores/package.json ./packages/domain-stores/
COPY packages/shared-app/package.json ./packages/shared-app/
COPY packages/shared-ui/package.json ./packages/shared-ui/
COPY packages/ui-kit/package.json ./packages/ui-kit/
COPY packages/model-catalog/package.json ./packages/model-catalog/
COPY apps/api/package.json ./apps/api/
COPY apps/mobile/package.json ./apps/mobile/

COPY scripts ./scripts

# Copy prisma schema and config before install (postinstall runs db:generate:all)
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
COPY prisma.config.local.ts ./prisma.config.local.ts

# chown the small set of config files (~30 files, instant), then install as appuser
# so all of node_modules is created with uid 1001 ownership from the start.
RUN chown -R appuser:appgroup /app
USER appuser
RUN bun install

# =============================================================================
# Stage 2: production image — layer source code onto base image
# =============================================================================
FROM ${BASE_IMAGE}

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=appuser:appgroup --from=builder /app/packages/shared-runtime ./packages/shared-runtime
COPY --chown=appuser:appgroup --from=builder /app/packages/agent-runtime ./packages/agent-runtime
COPY --chown=appuser:appgroup --from=builder /app/packages/model-catalog ./packages/model-catalog
COPY --chown=appuser:appgroup --from=builder /app/packages/sdk ./packages/sdk
COPY --chown=appuser:appgroup --from=builder /app/templates/runtime-template ./templates/runtime-template
COPY --chown=appuser:appgroup --from=builder /app/templates/skill-server ./templates/skill-server
COPY --chown=appuser:appgroup --from=builder /app/package.json ./
COPY --chown=appuser:appgroup --from=builder /app/bun.lock ./
COPY --chown=appuser:appgroup --from=builder /app/tsconfig.base.json ./

# Workspace member package.jsons for bun resolution
COPY --chown=appuser:appgroup --from=builder /app/packages/canvas-runtime/package.json ./packages/canvas-runtime/
COPY --chown=appuser:appgroup --from=builder /app/packages/domain-stores/package.json ./packages/domain-stores/
COPY --chown=appuser:appgroup --from=builder /app/packages/shared-app/package.json ./packages/shared-app/
COPY --chown=appuser:appgroup --from=builder /app/packages/shared-ui/package.json ./packages/shared-ui/
COPY --chown=appuser:appgroup --from=builder /app/packages/ui-kit/package.json ./packages/ui-kit/
COPY --chown=appuser:appgroup --from=builder /app/apps/api/package.json ./apps/api/
COPY --chown=appuser:appgroup --from=builder /app/apps/mobile/package.json ./apps/mobile/

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

# Rebuild bun's module resolution links from .bun/ cache (no downloads).
# Running as appuser so output is correctly owned — no chown -R needed.
RUN bun install --ignore-scripts

ENTRYPOINT ["/entrypoint.sh"]
