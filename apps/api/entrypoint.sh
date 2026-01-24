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

# Run Prisma migrations if DATABASE_URL is set
if [ -n "$DATABASE_URL" ]; then
  echo "Running Prisma migrations..."
  cd /app
  bunx prisma migrate deploy
  cd /app/apps/api
  echo "Migrations complete"
fi

# Execute the main command
exec "$@"
