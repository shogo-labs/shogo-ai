# syntax=docker/dockerfile:1.7-labs
# =============================================================================
# Shogo API Server Dockerfile
# =============================================================================
# Multi-stage build for production-optimized API server.
# Runs Hono server on port 8002 (configurable via API_PORT).
# Includes BetterAuth for authentication.
#
# Phase B refactor: builder/deps stages collapsed into a single FROM of the
# pre-baked shogo-workspace-deps image (see docker/workspace-deps/Dockerfile),
# which contains the JS workspace already installed (uid 1001), with
# build:packages, generate:routes, build-template-dists, and external skills
# all pre-applied. The production stage now just COPY --from=workspace and
# rebuilds module resolution links.
#
# The production base is node:25-slim (debian) rather than node:25-alpine to
# match workspace-deps' libc (glibc), so prisma engines and other native
# binaries copy across cleanly without rebuilding.
# =============================================================================

ARG WORKSPACE_DEPS

FROM ${WORKSPACE_DEPS} AS workspace
# No-op: workspace-deps already has node_modules + source + built artifacts.
# Aliased here so the COPY --from=workspace lines below read naturally.

# =============================================================================
# Production image (debian-slim, glibc — matches workspace-deps libc)
# =============================================================================
FROM node:25-slim

WORKDIR /app

# Runtime deps for the entrypoint and healthcheck:
#   curl  -> healthcheck
#   bash  -> shell scripts
#   netcat-openbsd -> entrypoint.sh nc port-wait
#   ca-certificates -> outbound HTTPS
# Plus Bun (entry point uses `bun run`).
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        curl bash unzip ca-certificates netcat-openbsd && \
    curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v1.3.9" && \
    rm -rf /root/.bun /var/lib/apt/lists/*

RUN groupadd -g 1001 appgroup && useradd -u 1001 -g appgroup -m -s /bin/bash appuser

# Pull node_modules and the full prebuilt workspace from the workspace-deps
# image. Files are already owned by uid 1001 (workspace-deps installs as
# appuser), so COPY preserves ownership without a --chown traversal.
COPY --from=workspace /app/node_modules ./node_modules
COPY --from=workspace /app/packages/agent-runtime ./packages/agent-runtime
COPY --from=workspace /app/packages/shared-runtime ./packages/shared-runtime
COPY --from=workspace /app/packages/sdk ./packages/sdk
COPY --from=workspace /app/packages/model-catalog ./packages/model-catalog
COPY --from=workspace /app/packages/shogo-worker ./packages/shogo-worker
# SDK split-out packages (3a2798abc "refactor(sdk): split monorepo into focused
# packages"). packages/sdk re-exports from all six; without these, importing
# anything from `@shogo-ai/sdk` chains into a missing module and crashes the
# API at boot (`Cannot find module '@shogo-ai/email/server'` etc.).
COPY --from=workspace /app/packages/core ./packages/core
COPY --from=workspace /app/packages/agent ./packages/agent
COPY --from=workspace /app/packages/db ./packages/db
COPY --from=workspace /app/packages/email ./packages/email
COPY --from=workspace /app/packages/voice ./packages/voice
COPY --from=workspace /app/packages/cli ./packages/cli
COPY --from=workspace /app/apps/api ./apps/api
COPY --from=workspace /app/package.json /app/bun.lock /app/tsconfig.base.json ./

# Stub package.jsons for every workspace member not shipped in the image
# (the `bun install --ignore-scripts` below still walks the workspace
# graph; missing package.jsons fail with `error: Workspace dependency not
# found`). The `/app/./` pivot tells BuildKit to preserve everything after
# `/app/`. Already-shipped source dirs get their package.json overwritten
# here, which is fine because the content is identical.
COPY --from=workspace --parents /app/./packages/*/package.json ./
COPY --from=workspace --parents /app/./apps/*/package.json ./

# Same patches as workspace-deps used during install — `bun install
# --ignore-scripts` below resolves patchedDependencies and fails without them.
COPY --from=workspace /app/patches ./patches

# Prisma schema + config for runtime migrations.
COPY --from=workspace /app/prisma ./prisma
COPY --from=workspace /app/prisma.config.ts ./prisma.config.ts

# Runtime template for RuntimeManager project initialization (workspace-deps
# stripped its node_modules after building template dists; the dists travel
# with packages/agent-runtime/templates above).
COPY --from=workspace /app/templates/runtime-template ./templates/runtime-template

COPY --chown=appuser:appgroup apps/api/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Re-create workspace symlinks (Docker COPY doesn't preserve cross-tree symlinks).
RUN mkdir -p node_modules/@shogo && \
    ln -sf ../../../packages/shared-runtime node_modules/@shogo/shared-runtime && \
    ln -sf ../../../packages/sdk node_modules/@shogo/sdk && \
    ln -sf ../../../packages/agent-runtime node_modules/@shogo/agent-runtime && \
    ln -sf ../../../packages/model-catalog node_modules/@shogo/model-catalog && \
    chown -h appuser:appgroup node_modules/@shogo node_modules/@shogo/*

RUN mkdir -p /app/workspaces /app/.claude && \
    chmod 777 /app /app/.claude && \
    chown appuser:appgroup /app/workspaces /app/.claude

USER appuser

# Rebuild per-package module resolution links from .bun/ cache (no downloads
# under normal operation). Running as appuser so output is correctly owned.
RUN --mount=type=cache,target=/home/appuser/.bun/install/cache,uid=1001,gid=1001 \
    bun install --ignore-scripts

ARG BUILD_HASH=dev
ENV BUILD_HASH=$BUILD_HASH

ENV NODE_ENV=production
ENV API_PORT=8002

EXPOSE 8002
EXPOSE 5200-5209

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -sf http://localhost:${API_PORT}/api/health || exit 1

WORKDIR /app/apps/api
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["bun", "run", "src/entry.ts"]
