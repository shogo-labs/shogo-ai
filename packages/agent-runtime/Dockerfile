# syntax=docker/dockerfile:1.7-labs
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
#
# Workspace package.jsons are glob-copied via BuildKit `COPY --parents`
# (requires `# syntax=docker/dockerfile:1.7-labs` directive above).
# Adding a new `packages/<X>/` is now a no-op for this Dockerfile —
# the glob picks it up automatically. Cross-stage `--from` copies need
# an explicit `/./` pivot (e.g. `/app/./packages/*/...`) to preserve
# directory structure relative to /app rather than relative to the
# first wildcard.
# =============================================================================

ARG BASE_IMAGE=shogo-runtime-base:latest

# =============================================================================
# Stage 0: builder — install all deps, copy source
# =============================================================================
FROM oven/bun:1.3-debian AS builder

WORKDIR /app

# Native-module build toolchain (better-sqlite3 → node-gyp → python3).
# Required under QEMU where no prebuilt binary matches the emulated arch
# and better-sqlite3 has to compile from source. The Bun image ships
# neither Node.js nor node-gyp, so we install both explicitly.
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ nodejs npm && \
    npm install -g node-gyp && \
    rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
COPY tsconfig.base.json ./

# All workspace members must be present for bun install to resolve the
# `packages/*` and `apps/*` workspaces glob in the root package.json.
# Single glob copy preserves directory structure thanks to --parents.
COPY --parents packages/*/package.json ./
COPY --parents apps/*/package.json ./

COPY scripts ./scripts

# Copy patches required by `patchedDependencies` in package.json — bun install
# fails with "Couldn't find patch file" when this directory is missing from
# the build context.
COPY patches ./patches

# Copy prisma schema and config before install (postinstall runs db:generate:all)
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
COPY prisma.config.local.ts ./prisma.config.local.ts

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install

# Source for everything we build. The SDK's `dts: true` tsup pass
# needs every cross-package type import resolvable, and the Dockerfile
# previously enumerated 10+ packages anyway. Single COPY removes the
# per-package bleed and is cache-friendly when packages/ is unchanged.
COPY packages ./packages
COPY templates/runtime-template ./templates/runtime-template

# Build @shogo-ai/sdk and its split-out workspace deps in
# dependency order (core → agent → db → email → voice → cli →
# sdk). The SDK's package.json "exports" resolve to ./dist/*, so
# `import '@shogo-ai/sdk/memory'` fails at agent-runtime startup
# without this; and the SDK's tsup dts pass needs each dep's
# `dist/*.d.ts` to be present first.
RUN bun run build:packages

# Pre-install runtime-template dependencies so workspaces get node_modules instantly.
# This is the **single** template the runtime now seeds — the legacy
# `templates/skill-server/` install was retired alongside the unified
# server architecture (see migrations/skill-server-to-root.ts).
RUN --mount=type=cache,target=/root/.bun/install/cache \
    cd templates/runtime-template && bun install

# Pre-build per-template canvas dist/ bundles. Each agent template
# (packages/agent-runtime/templates/<id>/) ships a `src/App.tsx` rendering
# its curated surface; the build script stages it on top of the
# runtime-template, runs `vite build`, and writes the result to
# `templates/<id>/dist/`. `seedWorkspaceFromTemplate` and
# `overlayAgentTemplateCodeDirs` cp this dist over the workspace's dist
# (`force:true`), so the canvas iframe paints the correct template
# surface on the very first request — no flash of "Project Ready" while
# Vite does its cold rebuild.
#
# Rebuilding here (rather than relying on whatever `dist/` was committed)
# means staging/production images can never drift from the template's
# committed `src/`. ~30s for ~20 templates thanks to the symlinked
# node_modules.
RUN bun run --cwd packages/agent-runtime build-template-dists

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

# Native-module build toolchain (better-sqlite3 → node-gyp → python3).
# Required under QEMU where no prebuilt binary matches the emulated arch
# and better-sqlite3 has to compile from source. The Bun image ships
# neither Node.js nor node-gyp, so we install both explicitly.
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ nodejs npm && \
    npm install -g node-gyp && \
    rm -rf /var/lib/apt/lists/*

# Create user matching production uid so node_modules is pre-owned by uid 1001.
# COPY --from=deps preserves ownership, so no --chown or chown -R needed later.
RUN groupadd -g 1001 appgroup && useradd -u 1001 -g appgroup appuser

COPY package.json bun.lock ./
COPY tsconfig.base.json ./

# Single glob copy for all workspace package.jsons — same pattern as
# the builder stage above. See the file header for why.
COPY --parents packages/*/package.json ./
COPY --parents apps/*/package.json ./

COPY scripts ./scripts

# Same patches directory as the builder stage — bun install fails without it.
COPY patches ./patches

# Copy prisma schema and config before install (postinstall runs db:generate:all)
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
COPY prisma.config.local.ts ./prisma.config.local.ts

# chown the small set of config files (~30 files, instant), then install as appuser
# so all of node_modules is created with uid 1001 ownership from the start.
RUN chown -R appuser:appgroup /app
USER appuser
RUN --mount=type=cache,target=/home/appuser/.bun/install/cache,uid=1001,gid=1001 \
    bun install

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
COPY --chown=appuser:appgroup --from=builder /app/package.json ./
COPY --chown=appuser:appgroup --from=builder /app/bun.lock ./
COPY --chown=appuser:appgroup --from=builder /app/tsconfig.base.json ./

# Stub package.jsons for every workspace member not shipped in the image
# (the `bun install --ignore-scripts` further down still walks the workspace
# graph; missing package.jsons fail with `error: Workspace dependency not
# found`). Single glob copy preserves directory structure thanks to
# --parents. The `/app/./` pivot tells BuildKit to preserve everything
# after `/app/` (i.e., `packages/X/...`). Already-shipped source
# (shared-runtime, agent-runtime, sdk, model-catalog) gets its
# package.json overwritten by this same line, which is fine because the
# file content is identical.
COPY --chown=appuser:appgroup --from=builder --parents /app/./packages/*/package.json ./
COPY --chown=appuser:appgroup --from=builder --parents /app/./apps/*/package.json ./

# Same patches as builder/deps stages — `bun install --ignore-scripts` below
# still re-resolves the patched dependency and fails without these files.
COPY --chown=appuser:appgroup --from=builder /app/patches ./patches

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
RUN --mount=type=cache,target=/app/.bun/cache,uid=1001,gid=1001 \
    bun install --ignore-scripts

ENTRYPOINT ["/entrypoint.sh"]
