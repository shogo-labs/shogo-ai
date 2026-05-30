# syntax=docker/dockerfile:1.7-labs
# =============================================================================
# Unified Runtime Dockerfile
# =============================================================================
# Phase B refactor: the previous builder + deps stages are gone. The runtime
# image now layers source from the pre-baked shogo-workspace-deps image
# (`docker/workspace-deps/Dockerfile`) onto the system-package base image
# (`packages/agent-runtime/Dockerfile.base`). All of bun install,
# build:packages, runtime-template install, build-template-dists, and
# fetch-external-skills happen exactly once per CI run inside workspace-deps.
#
# Build:
#   DOCKER_BUILDKIT=1 docker build \
#     --build-arg BASE_IMAGE=<reg>/shogo/shogo-runtime-base:latest \
#     --build-arg WORKSPACE_DEPS=<reg>/shogo/shogo-workspace-deps:latest \
#     -t runtime -f packages/agent-runtime/Dockerfile .
# =============================================================================

ARG BASE_IMAGE=shogo-runtime-base:latest
ARG WORKSPACE_DEPS

FROM ${WORKSPACE_DEPS} AS workspace
# No-op: workspace-deps already has node_modules + source + built artifacts.

# =============================================================================
# Production image — layer source code onto base image
# =============================================================================
FROM ${BASE_IMAGE}

WORKDIR /app

# node_modules and built source from workspace-deps. Files are already owned
# by uid 1001 (workspace-deps installs as appuser), so COPY preserves
# ownership without --chown traversal.
COPY --from=workspace /app/node_modules ./node_modules
COPY --from=workspace /app/packages/shared-runtime ./packages/shared-runtime
COPY --from=workspace /app/packages/agent-runtime ./packages/agent-runtime
# pty-core (34123b03 "feat(desktop): add cursor-parity terminal") holds the
# shared PTY protocol primitives. packages/agent-runtime/src/pty-protocol.ts
# re-exports from `@shogo/pty-core` and agent-runtime's server.ts imports the
# PTY WS handler at boot — without the source dir the runtime crashes with
# `Cannot find module '@shogo/pty-core'`. Same omission pattern as 27619a00.
COPY --from=workspace /app/packages/pty-core ./packages/pty-core
COPY --from=workspace /app/packages/model-catalog ./packages/model-catalog
COPY --from=workspace /app/packages/sdk ./packages/sdk
COPY --from=workspace /app/packages/shogo-worker ./packages/shogo-worker
# SDK split-out packages (3a2798abc "refactor(sdk): split monorepo into focused
# packages"). packages/sdk re-exports from all six; without these, importing
# anything from `@shogo-ai/sdk` chains into a missing module and crashes the
# runtime at project boot (`Cannot find module '@shogo-ai/agent/pi-adapter'`
# from `/app/packages/sdk/dist/pi-adapter.js` was the staging incident on
# 2026-05-14 — same root cause as 27619a00 for the API image).
COPY --from=workspace /app/packages/core ./packages/core
COPY --from=workspace /app/packages/agent ./packages/agent
COPY --from=workspace /app/packages/db ./packages/db
COPY --from=workspace /app/packages/email ./packages/email
COPY --from=workspace /app/packages/voice ./packages/voice
COPY --from=workspace /app/packages/cli ./packages/cli
COPY --from=workspace /app/templates/runtime-template ./templates/runtime-template
COPY --from=workspace /app/package.json /app/bun.lock /app/tsconfig.base.json ./

# Stub package.jsons for every workspace member not shipped in the image
# (the `bun install --ignore-scripts` further down still walks the workspace
# graph; missing package.jsons fail with `error: Workspace dependency not
# found`). The `/app/./` pivot tells BuildKit to preserve everything after
# `/app/`. Already-shipped source dirs get their package.json overwritten
# here, which is fine because the content is identical.
COPY --from=workspace --parents /app/./packages/*/package.json ./
COPY --from=workspace --parents /app/./apps/*/package.json ./

# Same patches workspace-deps used during install — `bun install
# --ignore-scripts` below resolves patchedDependencies and fails without them.
COPY --from=workspace /app/patches ./patches

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
# Cache target matches BUN_INSTALL_CACHE_DIR set in Dockerfile.base.
#
# Skipping the lockfile save is required: the stubbed workspace package.jsons
# copied above make bun recompute the dependency graph, so a plain `bun install`
# tries to persist an updated bun.lock by writing a temp file into the
# root-owned /app dir and fails with
# `EACCES: failed to create temporary file to save lockfile`. We only need the
# node_modules relink here, never a lockfile rewrite. BUN_CONFIG_SKIP_SAVE_LOCKFILE
# is the documented, guaranteed switch for this; --no-save is kept as a belt-and-
# suspenders (and to leave package.json untouched), mirroring the prewarm install
# in Dockerfile.base.
RUN --mount=type=cache,target=/app/.bun/cache,uid=1001,gid=1001 \
    BUN_CONFIG_SKIP_SAVE_LOCKFILE=1 bun install --ignore-scripts --no-save

ENTRYPOINT ["/entrypoint.sh"]
