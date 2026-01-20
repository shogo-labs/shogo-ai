#!/bin/sh
# =============================================================================
# API Server Entrypoint
# =============================================================================
# Handles runtime setup before starting the API server
# =============================================================================

# Create workspaces directory if it doesn't exist
if [ -n "$WORKSPACES_DIR" ]; then
  mkdir -p "$WORKSPACES_DIR"
  echo "Workspaces directory: $WORKSPACES_DIR"
fi

# Execute the main command
exec "$@"
