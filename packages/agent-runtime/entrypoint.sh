#!/bin/bash
# =============================================================================
# Agent Runtime Entrypoint
# =============================================================================
# Simpler than project-runtime: no Vite build, no template deps, no Prisma.
# Just S3 sync for agent workspace files + start the agent server.
# =============================================================================

set -e

STARTUP_TIME=$(date +%s%3N)
log_timing() {
  local now=$(date +%s%3N)
  local elapsed=$((now - STARTUP_TIME))
  echo "[entrypoint] [+${elapsed}ms] $1"
}

log_timing "=================================================="
log_timing "Agent Runtime Starting"
log_timing "=================================================="
log_timing "PROJECT_ID: ${PROJECT_ID:-not set}"
log_timing "AGENT_DIR: ${AGENT_DIR:-/app/agent}"
log_timing "NODE_ENV: ${NODE_ENV:-production}"
log_timing "S3_WORKSPACES_BUCKET: ${S3_WORKSPACES_BUCKET:-not set}"
log_timing "=================================================="

if [ -z "$PROJECT_ID" ]; then
  log_timing "ERROR: PROJECT_ID environment variable is required"
  exit 1
fi

AGENT_DIR="${AGENT_DIR:-/app/agent}"
export AGENT_DIR

# =============================================================================
# Ensure agent workspace directory exists with default config
# =============================================================================
mkdir -p "$AGENT_DIR"

if [ ! -f "$AGENT_DIR/config.json" ]; then
  log_timing "Creating default agent config..."
  cat > "$AGENT_DIR/config.json" << 'EOF'
{
  "model": { "provider": "anthropic", "name": "claude-sonnet-4-20250514" },
  "heartbeat": { "enabled": false, "intervalMs": 300000 },
  "channels": [],
  "skills": [],
  "memory": { "enabled": false }
}
EOF
  log_timing "Default config created"
fi

# =============================================================================
# Start the agent server
# =============================================================================
log_timing "Starting agent server..."
cd /app/packages/agent-runtime

export STARTUP_TIME="$STARTUP_TIME"

log_timing "Launching bun server..."
exec bun run src/server.ts
