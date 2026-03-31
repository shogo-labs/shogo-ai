#!/bin/bash
# =============================================================================
# SWE-bench Entrypoint
# =============================================================================
# Starts the Shogo gateway inside a SWE-bench Docker container.
# Handles both SWE-bench Pro (pre-configured env) and regular SWE-bench
# (conda testbed env) images by sourcing available profiles before launch.
#
# The key trick: activating the environment BEFORE starting the gateway
# means process.env.PATH includes the correct Python/Go/Node binaries.
# All subsequent exec() calls from the gateway inherit this PATH.
# =============================================================================

set -e

# Source environment setup from the SWE-bench base image
[ -f /etc/profile ] && source /etc/profile || true
[ -f /root/.bashrc ] && source /root/.bashrc || true
[ -f ~/.bashrc ] && source ~/.bashrc || true

# Activate conda if present (regular SWE-bench images use conda testbed env)
if [ -f /opt/miniconda3/etc/profile.d/conda.sh ]; then
  source /opt/miniconda3/etc/profile.d/conda.sh
  conda activate testbed 2>/dev/null || true
fi

WORKSPACE_DIR="${WORKSPACE_DIR:-/app/workspace}"
export WORKSPACE_DIR
mkdir -p "$WORKSPACE_DIR"

if [ ! -f "$WORKSPACE_DIR/config.json" ]; then
  cat > "$WORKSPACE_DIR/config.json" << 'CONF'
{
  "model": { "provider": "anthropic", "name": "claude-sonnet-4-6" },
  "activeMode": "none",
  "heartbeat": { "enabled": false, "intervalMs": 300000 },
  "channels": [],
  "skills": [],
  "memory": { "enabled": false }
}
CONF
fi

cd /app/packages/agent-runtime
exec bun run src/server.ts
