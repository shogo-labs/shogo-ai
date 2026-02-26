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
COPY packages/domain-stores/package.json ./packages/domain-stores/
COPY packages/shared-app/package.json ./packages/shared-app/
COPY packages/shared-ui/package.json ./packages/shared-ui/
COPY packages/ui-kit/package.json ./packages/ui-kit/
COPY apps/api/package.json ./apps/api/
COPY apps/mobile/package.json ./apps/mobile/

COPY scripts ./scripts

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install

COPY packages/shared-runtime ./packages/shared-runtime
COPY packages/agent-runtime ./packages/agent-runtime

# Clean per-package node_modules (bun symlinks resolve to ~500MB of duplicates)
RUN rm -rf packages/*/node_modules apps/*/node_modules

# =============================================================================
# Stage 2: deps — full node_modules with workspace links
# =============================================================================
# Runs IN PARALLEL with builder. Full install ensures bun workspace resolution
# works correctly for @shogo/* packages in the production image.
# =============================================================================
FROM oven/bun:1.3-alpine AS deps

WORKDIR /app

COPY package.json bun.lock ./
COPY tsconfig.base.json ./

COPY packages/state-api/package.json ./packages/state-api/
COPY packages/mcp/package.json ./packages/mcp/
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

COPY scripts ./scripts

RUN bun install && \
    echo "Installed $(ls node_modules/ | wc -l) packages (full install, not --production)"

# =============================================================================
# Stage 3: production image
# =============================================================================
FROM oven/bun:1.3-alpine

WORKDIR /app

RUN echo "https://dl-cdn.alpinelinux.org/alpine/v3.21/main" >> /etc/apk/repositories && \
    apk add --no-cache \
    curl bash git tar gzip \
    'nodejs>22' npm \
    chromium nss freetype harfbuzz ca-certificates ttf-freefont

ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN npm install -g @anthropic-ai/claude-code

ENV SHELL=/bin/bash

RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

# Copy node_modules + source (no per-package node_modules bloat)
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=appuser:appgroup --from=builder /app/packages/shared-runtime ./packages/shared-runtime
COPY --chown=appuser:appgroup --from=builder /app/packages/agent-runtime ./packages/agent-runtime
COPY --chown=appuser:appgroup --from=builder /app/package.json ./
COPY --chown=appuser:appgroup --from=builder /app/bun.lock ./
COPY --chown=appuser:appgroup --from=builder /app/tsconfig.base.json ./

# Workspace member package.jsons needed by bun install for resolution
COPY --from=builder /app/packages/state-api/package.json ./packages/state-api/
COPY --from=builder /app/packages/mcp/package.json ./packages/mcp/
COPY --from=builder /app/packages/project-runtime/package.json ./packages/project-runtime/
COPY --from=builder /app/packages/sdk/package.json ./packages/sdk/
COPY --from=builder /app/packages/domain-stores/package.json ./packages/domain-stores/
COPY --from=builder /app/packages/shared-app/package.json ./packages/shared-app/
COPY --from=builder /app/packages/shared-ui/package.json ./packages/shared-ui/
COPY --from=builder /app/packages/ui-kit/package.json ./packages/ui-kit/
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/apps/mobile/package.json ./apps/mobile/

# Rebuild bun's module resolution links. Docker COPY from the deps stage
# preserves the .bun/ cache but destroys internal symlinks bun uses for
# package resolution. Re-running install rebuilds them without re-downloading.
RUN bun install --ignore-scripts && \
    chown -R appuser:appgroup node_modules

# Pre-install popular MCP server packages for instant startup.
# Without this, `npx -y` takes 30-45s per package (exceeding the 30s timeout).
# With pre-installed packages, the runtime detects them and uses `node` directly (~1.6s).
# To update this list, see `preinstalled: true` entries in mcp-catalog.ts.
RUN mkdir -p /app/mcp-packages && \
    cd /app/mcp-packages && \
    npm init -y --silent 2>/dev/null && \
    npm install --omit=dev --no-audit --no-fund \
      @openbnb/mcp-server-airbnb@0.1.3 \
      mcp-fetch-node@latest \
      @modelcontextprotocol/server-github@latest \
      @modelcontextprotocol/server-postgres@latest \
      @modelcontextprotocol/server-brave-search@latest \
      @notionhq/notion-mcp-server@latest \
      @modelcontextprotocol/server-slack@latest \
      @modelcontextprotocol/server-filesystem@latest \
    && rm -rf /app/mcp-packages/package.json /app/mcp-packages/package-lock.json

RUN mkdir -p /app/agent /app/.schemas /app/.claude && \
    chown -R appuser:appgroup /app /usr/local/lib/node_modules

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
