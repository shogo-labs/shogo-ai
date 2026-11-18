#!/bin/bash
# =============================================================================
# Unified Runtime Entrypoint
# =============================================================================
# Starts the unified Shogo runtime: Pi agent with optional app building
# capabilities (Claude Code + Vite). Mode switching happens at runtime.
# =============================================================================

set -e

STARTUP_TIME=$(date +%s%3N)
log_timing() {
  local now=$(date +%s%3N)
  local elapsed=$((now - STARTUP_TIME))
  echo "[entrypoint] [+${elapsed}ms] $1"
}

log_timing "=================================================="
log_timing "Shogo Unified Runtime Starting"
log_timing "=================================================="
log_timing "PROJECT_ID: ${PROJECT_ID:-not set}"
log_timing "WORKSPACE_DIR: ${WORKSPACE_DIR:-/app/workspace}"
log_timing "NODE_ENV: ${NODE_ENV:-production}"
log_timing "S3_WORKSPACES_BUCKET: ${S3_WORKSPACES_BUCKET:-not set}"
log_timing "=================================================="

# Truthiness must match isTruthyEnv() in shared-runtime/src/standalone.ts:
# 1/true/yes/on, case-insensitive, surrounding whitespace ignored.
is_truthy() {
  local value
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  case "$value" in
    1|true|yes|on) return 0 ;;
  esac
  return 1
}

# A standalone runtime (SHOGO_STANDALONE) has no Shogo API and no project to be
# assigned — it is statically bound to its own workspace. Default PROJECT_ID
# here, before the guard: the `standalone` default in src/server.ts is only
# reached once the server starts, and the guard below would exit first.
if is_truthy "$SHOGO_STANDALONE" && [ -z "$PROJECT_ID" ]; then
  PROJECT_ID=standalone
  export PROJECT_ID
  log_timing "SHOGO_STANDALONE set: defaulting PROJECT_ID to 'standalone'"
fi

# A workspace runtime (WORKSPACE_RUNTIME=true) is identified by WORKSPACE_ID
# and mounts several attached projects as subfolders — it has no single
# PROJECT_ID. Only single-project runtimes require PROJECT_ID.
if [ -z "$PROJECT_ID" ] && [ "$WORKSPACE_RUNTIME" != "true" ]; then
  log_timing "ERROR: PROJECT_ID environment variable is required"
  exit 1
fi

if [ "$WORKSPACE_RUNTIME" = "true" ]; then
  log_timing "WORKSPACE_RUNTIME=true (WORKSPACE_ID: ${WORKSPACE_ID:-not set}, projects: ${WORKSPACE_PROJECT_IDS:-none})"
fi

WORKSPACE_DIR="${WORKSPACE_DIR:-/app/workspace}"
export WORKSPACE_DIR

# =============================================================================
# Ensure workspace directory exists
# =============================================================================
# Workspace runtimes treat WORKSPACE_DIR as the parent of several attached
# project subfolders, so we must NOT create a stray `project/` child (it would
# surface as a bogus project in the merged tree). Standalone runtimes are the
# same shape: the file tools and the default file API root at WORKSPACE_DIR
# itself, and `?scope=project` resolves to WORKSPACE_DIR too, so a `project/`
# child would be an empty folder nothing ever reads. Single-project runtimes
# keep the legacy `project/` working dir.
if [ "$WORKSPACE_RUNTIME" = "true" ] || is_truthy "$SHOGO_STANDALONE"; then
  mkdir -p "$WORKSPACE_DIR"
else
  mkdir -p "$WORKSPACE_DIR" "$WORKSPACE_DIR/project"
fi

if [ ! -f "$WORKSPACE_DIR/config.json" ]; then
  log_timing "Creating default workspace config..."
  cat > "$WORKSPACE_DIR/config.json" << 'EOF'
{
  "model": { "provider": "anthropic", "name": "auto" },
  "activeMode": "none",
  "heartbeat": { "enabled": false, "intervalMs": 300000 },
  "channels": [],
  "skills": [],
  "memory": { "enabled": false }
}
EOF
  log_timing "Default config created"
fi

# =============================================================================
# Start the unified server
# =============================================================================
log_timing "Starting unified runtime server..."
cd /app/packages/agent-runtime

export STARTUP_TIME="$STARTUP_TIME"

log_timing "Launching bun server..."
exec bun run src/server.ts
