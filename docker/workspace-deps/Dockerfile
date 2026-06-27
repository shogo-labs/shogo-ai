# syntax=docker/dockerfile:1.7-labs
# =============================================================================
# Workspace Deps Image (Debian)
# =============================================================================
# Single-stage image baked once per CI run, then consumed by every matrix
# image (api, web, runtime) so each one stops re-running `bun install` and
# `bun run build:packages`. Contents:
#
#   /app/node_modules                            (full install, uid 1001)
#   /app/packages/*/package.json                 (workspace stubs)
#   /app/packages/*/dist                         (output of build:packages)
#   /app/packages/agent-runtime/templates/*/dist (per-template canvas dists)
#   /app/packages/agent-runtime/src/bundled-claude-skills/*
#                                                (fetched external skills)
#   /app/apps/api/src/generated/*                (generate:routes output)
#   /app/templates/runtime-template              (deps stripped after build)
#   /app/patches /app/prisma /app/scripts        (config/source needed
#                                                downstream)
#
# Downstream matrix Dockerfiles use `FROM ${WORKSPACE_DEPS}` to inherit
# everything above. We bake debian (matches Dockerfile.base) so binary
# native modules layer-copy cleanly into both python:3.12-slim
# (runtime base) and node:25-alpine (api production) — same arm64 ABI.
# =============================================================================

FROM oven/bun:1.3-debian

WORKDIR /app

# Native-module build toolchain (better-sqlite3 → node-gyp → python3) and
# git for fetch-external-skills.ts. Even on ARM-native runners, some
# packages (e.g. better-sqlite3 for non-aligned bun versions) still build
# from source.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 make g++ nodejs npm git curl ca-certificates && \
    npm install -g node-gyp && \
    rm -rf /var/lib/apt/lists/*

# Match downstream uid 1001 ownership so COPY --from=workspace-deps preserves
# permissions cleanly into api/runtime production stages.
RUN groupadd -g 1001 appgroup && useradd -u 1001 -g appgroup -m -s /bin/bash appuser

# Workspace root files
COPY package.json bun.lock tsconfig.base.json ./

# Workspace member package.jsons (BuildKit `COPY --parents` preserves dirs)
COPY --parents packages/*/package.json ./
COPY --parents apps/*/package.json ./

COPY scripts ./scripts
COPY patches ./patches
COPY prisma ./prisma
COPY prisma.config.ts prisma.config.local.ts shogo.config.json ./

RUN chown -R appuser:appgroup /app
USER appuser

# Full install as appuser → node_modules owned by uid 1001 from the start,
# so downstream COPY --from=workspace-deps doesn't need --chown.
# --frozen-lockfile keys this layer purely on bun.lock: app-only deploys (no
# lockfile change) get a clean registry-cache hit, so node_modules keeps a
# stable digest and downstream images pull only the changed source layers.
RUN --mount=type=cache,target=/home/appuser/.bun/install/cache,uid=1001,gid=1001 \
    bun install --frozen-lockfile

# Source for everything build:packages and generate:routes touch. The SDK's
# `dts: true` tsup pass needs every cross-package type import resolvable.
COPY --chown=appuser:appgroup packages ./packages
COPY --chown=appuser:appgroup apps/api ./apps/api
COPY --chown=appuser:appgroup templates/runtime-template ./templates/runtime-template

# Build the SDK and its split-out workspace deps in dependency order
# (core → agent → db → email → voice → cli → sdk). The root build:packages
# script encodes this graph.
RUN bun run build:packages

# Regenerate Hono routes/hooks/admin-routes from prisma/schema.prisma. The
# postinstall hook also runs this, but rerun explicitly here so the output
# is part of an immutable layer (postinstall is best-effort).
RUN bun run generate:routes

# Pre-build per-template canvas dist/ bundles. Reuses the runtime-template
# node_modules (symlinked into per-template staging dirs) and drops them
# afterwards — the API/runtime images ship the populated templates/<id>/dist/
# directories only.
# Plain `bun install` (no --frozen-lockfile): the runtime-template's
# bun.lock has drift relative to its package.json on this branch and the
# original apps/api/runtime Dockerfiles also use plain bun install here.
# Materialize the `@shogo-ai/sdk: workspace:*` sentinel to a concrete
# `^X.Y.Z` first (this image has npm + network, so it resolves npm's latest
# published version). The resulting node_modules is transient — it only
# feeds build-template-dists and is removed below.
RUN --mount=type=cache,target=/home/appuser/.bun/install/cache,uid=1001,gid=1001 \
    bun run scripts/materialize-runtime-template.ts templates/runtime-template/package.json && \
    cd templates/runtime-template && \
    bun install && \
    cd /app && \
    bun run --cwd packages/agent-runtime build-template-dists && \
    rm -rf templates/runtime-template/node_modules

# Fetch external Claude Code skills declared in skill-registry.json. Writes
# to packages/agent-runtime/src/bundled-claude-skills/<source>/<skill>/SKILL.md.
RUN bun run scripts/fetch-external-skills.ts
