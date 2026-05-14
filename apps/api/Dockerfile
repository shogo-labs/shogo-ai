# syntax=docker/dockerfile:1.7-labs
# =============================================================================
# Shogo API Server Dockerfile
# =============================================================================
# Multi-stage build for production-optimized API server
# Runs Hono server on port 8002 (configurable via API_PORT)
# Includes BetterAuth for authentication
#
# Workspace package.jsons are glob-copied via BuildKit `COPY --parents`
# (requires `# syntax=docker/dockerfile:1.7-labs` directive above).
# Adding a new `packages/<X>/` is now a no-op for this Dockerfile —
# the glob picks it up automatically. The `--parents` flag preserves
# the directory structure (without it, all package.jsons would land
# in the same dest dir and clobber each other).
# =============================================================================

FROM oven/bun:1.3-alpine AS builder

WORKDIR /app

# Native-module build toolchain (better-sqlite3 → node-gyp → python3).
# Required under QEMU where no prebuilt binary matches the emulated arch
# and better-sqlite3 has to compile from source. The Bun image ships
# neither Node.js nor node-gyp, so we install both explicitly.
RUN apk add --no-cache python3 make g++ nodejs npm && \
    npm install -g node-gyp

# Copy workspace root files
COPY package.json bun.lock ./
COPY tsconfig.base.json ./

# All workspace members must be present for bun install to resolve the
# `packages/*` and `apps/*` workspaces glob in the root package.json.
# Single glob copy preserves directory structure thanks to --parents.
COPY --parents packages/*/package.json ./
COPY --parents apps/*/package.json ./

# Copy scripts needed for postinstall
COPY scripts ./scripts

# Copy patches required by `patchedDependencies` in package.json — bun install
# fails fast if a referenced .patch file isn't present in the build context.
COPY patches ./patches

# Copy prisma schema and config before install (postinstall runs db:generate:all)
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
COPY prisma.config.local.ts ./prisma.config.local.ts

# Copy shogo SDK config (drives `bun run generate:routes` later in this stage)
COPY shogo.config.json ./shogo.config.json

# Install all dependencies (postinstall generates Prisma client)
RUN bun install

# Source for everything we build. The SDK's `dts: true` tsup pass
# needs every cross-package type import resolvable (e.g.
# `import { ... } from '@shogo-ai/core/chat-message'`), so we copy
# the lot rather than try to enumerate which ones each upstream
# build touches. Build context size is dominated by node_modules
# anyway, and BuildKit caches this layer across rebuilds when the
# packages/ tree hasn't changed.
COPY packages ./packages
COPY apps/api ./apps/api
COPY templates/runtime-template ./templates/runtime-template

# Build the SDK and its split-out workspace deps in dependency
# order (core → agent → db → email → voice → cli → sdk). The root
# `build:packages` script encodes this graph and is the canonical
# entry point — building only `packages/sdk` is no longer enough
# because its tsup dts pass needs each dep's `dist/*.d.ts` first.
WORKDIR /app
RUN bun run build:packages

# Regenerate Hono routes/hooks/admin-routes from prisma/schema.prisma so that
# adding a model (e.g. WorkspaceGrant) only requires committing the schema
# change — the per-model `*.routes.ts` and `*.hooks.ts` files under
# `apps/api/src/generated/` are reproduced from the schema here. Without this
# step, anything ignored by `**/src/generated/` in .gitignore (i.e. any file
# generated after that rule was added) silently never reaches the image and
# crash-loops the API on first import. Outputs are governed by
# shogo.config.json.
WORKDIR /app
RUN bun run generate:routes

# Pre-build per-template canvas dist/ bundles so the API's
# `RuntimeManager.ensureProjectDirectory` ships them into every project
# workspace and the canvas iframe paints the correct surface on the
# first request (no "Project Ready" flash). Requires the runtime-template
# to have its deps installed because the build script symlinks
# templates/runtime-template/node_modules into each per-template staging
# dir to share vite/react/postcss/tailwind. The deps tree is dropped
# afterwards — the API doesn't need it at runtime, only the
# (now-populated) `templates/<id>/dist/` directories.
WORKDIR /app/templates/runtime-template
RUN bun install
WORKDIR /app
RUN bun run --cwd packages/agent-runtime build-template-dists && \
    rm -rf templates/runtime-template/node_modules

# Clean per-package node_modules (bun symlinks that resolve via .bun/ cache).
# These are rebuilt in the production stage via `bun install --ignore-scripts`.
RUN rm -rf packages/*/node_modules

# =============================================================================
# Parallel deps stage — node_modules pre-owned by uid 1001
# =============================================================================
# Runs IN PARALLEL with builder (BuildKit). Installs as appuser so all files
# in node_modules are created with uid 1001 ownership. COPY --from=deps
# preserves this ownership natively — no --chown flag or chown -R needed.
# =============================================================================
FROM oven/bun:1.3-alpine AS deps

WORKDIR /app

# Native-module build toolchain (better-sqlite3 → node-gyp → python3).
# Required under QEMU where no prebuilt binary matches the emulated arch
# and better-sqlite3 has to compile from source. The Bun image ships
# neither Node.js nor node-gyp, so we install both explicitly.
RUN apk add --no-cache python3 make g++ nodejs npm && \
    npm install -g node-gyp

RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup

COPY package.json bun.lock ./
COPY tsconfig.base.json ./

# Single glob copy for all workspace package.jsons — same pattern as
# the builder stage above. See the file header for why.
COPY --parents packages/*/package.json ./
COPY --parents apps/*/package.json ./

COPY scripts ./scripts

# Same patches directory as the builder stage — bun install fails without it.
COPY patches ./patches

COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
COPY prisma.config.local.ts ./prisma.config.local.ts

RUN chown -R appuser:appgroup /app
USER appuser
RUN bun install

# =============================================================================
# Production image
# =============================================================================
FROM node:25-alpine

WORKDIR /app

# Install curl for healthchecks, bash for shell, and Bun
RUN apk add --no-cache curl bash unzip && \
    curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v1.3.9" && \
    rm -rf /root/.bun

# Create non-root user for security
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

# Copy node_modules from deps stage. Files are already owned by uid 1001
# (installed as appuser in deps), so COPY preserves ownership natively —
# no --chown flag needed, eliminating the ~480s ownership traversal.
COPY --from=deps /app/node_modules ./node_modules

# Copy built source from builder (small files, --chown is fast here)
COPY --chown=appuser:appgroup --from=builder /app/packages/agent-runtime ./packages/agent-runtime
COPY --chown=appuser:appgroup --from=builder /app/packages/shared-runtime ./packages/shared-runtime
COPY --chown=appuser:appgroup --from=builder /app/packages/sdk ./packages/sdk
COPY --chown=appuser:appgroup --from=builder /app/apps/api ./apps/api
COPY --chown=appuser:appgroup --from=builder /app/package.json ./
COPY --chown=appuser:appgroup --from=builder /app/bun.lock ./
COPY --chown=appuser:appgroup --from=builder /app/tsconfig.base.json ./

# Re-create workspace symlinks (Docker COPY doesn't preserve cross-tree symlinks)
RUN mkdir -p node_modules/@shogo && \
    ln -sf ../../../packages/shared-runtime node_modules/@shogo/shared-runtime && \
    ln -sf ../../../packages/sdk node_modules/@shogo/sdk && \
    ln -sf ../../../packages/agent-runtime node_modules/@shogo/agent-runtime && \
    ln -sf ../../../packages/model-catalog node_modules/@shogo/model-catalog && \
    chown -h appuser:appgroup node_modules/@shogo node_modules/@shogo/*

# Stub package.jsons for every workspace member not shipped in the image
# (the `bun install --ignore-scripts` further down still walks the workspace
# graph; missing package.jsons fail with `error: Workspace dependency not
# found`). Single glob copy preserves directory structure thanks to
# --parents; adding new packages is automatic. The `/app/./` pivot tells
# BuildKit to preserve everything after `/app/` (i.e., `packages/X/...`).
# Already-shipped source (agent-runtime, shared-runtime, sdk) gets its
# package.json overwritten by this same line, which is fine because the
# file content is identical.
COPY --chown=appuser:appgroup --from=builder --parents /app/./packages/*/package.json ./
COPY --chown=appuser:appgroup --from=builder --parents /app/./apps/*/package.json ./
# model-catalog ships its source (canvas-runtime peer needs it at runtime)
COPY --chown=appuser:appgroup --from=builder /app/packages/model-catalog ./packages/model-catalog/

# Same patches as builder/deps stages — bun install --ignore-scripts at line ~189
# also resolves `patchedDependencies` and fails without these files.
COPY --chown=appuser:appgroup --from=builder /app/patches ./patches

# Copy prisma schema, config, and migrations for runtime migrations
COPY --chown=appuser:appgroup --from=builder /app/prisma ./prisma
COPY --chown=appuser:appgroup --from=builder /app/prisma.config.ts ./prisma.config.ts

# Copy SDK examples folder for templates API
COPY --chown=appuser:appgroup packages/sdk/examples ./packages/sdk/examples

# Copy runtime template for RuntimeManager project initialization
COPY --chown=appuser:appgroup templates/runtime-template ./templates/runtime-template

# Copy entrypoint script
COPY --chown=appuser:appgroup apps/api/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Create directories and set permissions (must be done as root)
RUN mkdir -p /app/workspaces /app/.claude && \
    chmod 777 /app /app/.claude && \
    chown appuser:appgroup /app/workspaces /app/.claude

# Switch to non-root user before rebuilding workspace links
USER appuser

# Rebuild per-package module resolution links from .bun/ cache (no downloads).
# Running as appuser so output is correctly owned — no chown -R needed.
RUN bun install --ignore-scripts

# Build hash for version detection (set at build time by CI)
ARG BUILD_HASH=dev
ENV BUILD_HASH=$BUILD_HASH

# Environment defaults
ENV NODE_ENV=production
ENV API_PORT=8002

# Expose API port and Vite runtime ports
EXPOSE 8002
EXPOSE 5200-5209

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -sf http://localhost:${API_PORT}/api/health || exit 1

# Run API server
WORKDIR /app/apps/api
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["bun", "run", "src/entry.ts"]

