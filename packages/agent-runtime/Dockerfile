# syntax=docker/dockerfile:1.4
# =============================================================================
# Agent Runtime Dockerfile
# =============================================================================
# Runs Claude Code builder AI + Agent Gateway (heartbeat, channels, skills)
# in an isolated per-agent pod.
#
# Much simpler than project-runtime: no Vite, no templates, no Prisma.
# The agent just needs Claude Code CLI, MCP tools, and the agent source.
#
# Build: DOCKER_BUILDKIT=1 docker build -t agent-runtime -f packages/agent-runtime/Dockerfile .
# Run:   docker run -e PROJECT_ID=test -e ANTHROPIC_API_KEY=sk-... agent-runtime
# =============================================================================

# =============================================================================
# Stage 1: builder — install all deps, copy source
# =============================================================================
FROM oven/bun:1.3-alpine AS builder

WORKDIR /app

COPY package.json bun.lock ./
COPY tsconfig.base.json ./

COPY packages/state-api/package.json ./packages/state-api/
COPY packages/mcp/package.json ./packages/mcp/
COPY packages/project-runtime/package.json ./packages/project-runtime/
COPY packages/agent-runtime/package.json ./packages/agent-runtime/
COPY packages/shared-runtime/package.json ./packages/shared-runtime/
COPY packages/sdk/package.json ./packages/sdk/
COPY apps/web/package.json ./apps/web/
COPY apps/api/package.json ./apps/api/
COPY apps/desktop/package.json ./apps/desktop/

COPY scripts ./scripts

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install

COPY packages/shared-runtime ./packages/shared-runtime
COPY packages/agent-runtime ./packages/agent-runtime

# Clean per-package node_modules (bun symlinks resolve to ~500MB of duplicates)
RUN rm -rf packages/*/node_modules apps/*/node_modules

# =============================================================================
# Stage 2: production-deps — lean node_modules without devDependencies
# =============================================================================
# Runs IN PARALLEL with builder. Excludes turbo, typescript, playwright,
# prisma CLI, @types/*, and other dev-only packages.
# =============================================================================
FROM oven/bun:1.3-alpine AS production-deps

WORKDIR /app

COPY package.json bun.lock ./
COPY tsconfig.base.json ./

COPY packages/state-api/package.json ./packages/state-api/
COPY packages/mcp/package.json ./packages/mcp/
COPY packages/project-runtime/package.json ./packages/project-runtime/
COPY packages/agent-runtime/package.json ./packages/agent-runtime/
COPY packages/shared-runtime/package.json ./packages/shared-runtime/
COPY packages/sdk/package.json ./packages/sdk/
COPY apps/web/package.json ./apps/web/
COPY apps/api/package.json ./apps/api/
COPY apps/desktop/package.json ./apps/desktop/

COPY scripts ./scripts

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --production

# =============================================================================
# Stage 3: production image
# =============================================================================
FROM oven/bun:1.3-alpine

WORKDIR /app

RUN echo "https://dl-cdn.alpinelinux.org/alpine/v3.21/main" >> /etc/apk/repositories && \
    apk add --no-cache \
    curl bash git tar gzip \
    'nodejs>22' npm

RUN npm install -g @anthropic-ai/claude-code

ENV SHELL=/bin/bash

RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

# Copy production-only node_modules + source (no per-package node_modules bloat)
COPY --chown=appuser:appgroup --from=production-deps /app/node_modules ./node_modules
COPY --chown=appuser:appgroup --from=builder /app/packages/shared-runtime ./packages/shared-runtime
COPY --chown=appuser:appgroup --from=builder /app/packages/agent-runtime ./packages/agent-runtime
COPY --chown=appuser:appgroup --from=builder /app/package.json ./
COPY --chown=appuser:appgroup --from=builder /app/tsconfig.base.json ./

RUN mkdir -p /app/agent /app/.schemas /app/.claude && \
    chown appuser:appgroup /app/agent /app/.schemas /app/.claude

COPY --chown=appuser:appgroup packages/agent-runtime/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production
ENV PORT=8080
ENV AGENT_DIR=/app/agent
ENV SCHEMAS_PATH=/app/.schemas
ENV MCP_SERVER_PATH=/app/packages/agent-runtime/src/tools/mcp-server.ts
ENV HOME=/app

WORKDIR /app/agent

EXPOSE 8080

HEALTHCHECK --interval=3s --timeout=2s --start-period=5s --retries=10 \
  CMD curl -sf http://localhost:8080/health || exit 1

USER appuser

ENTRYPOINT ["/entrypoint.sh"]
