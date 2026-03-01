#!/bin/sh
# =============================================================================
# API Server Entrypoint
# =============================================================================
# Handles runtime setup before starting the API server.
# Migrations MUST succeed before the server starts — a failed migration means
# the Prisma client and database are out of sync, which causes 500s on every
# query that touches the affected models.
# =============================================================================

set -e

if [ -n "$WORKSPACES_DIR" ]; then
  mkdir -p "$WORKSPACES_DIR"
  echo "Workspaces directory: $WORKSPACES_DIR"
fi

if [ -n "$DATABASE_URL" ]; then
  echo "[entrypoint] Running Prisma migrations..."
  cd /app
  if npx prisma migrate deploy; then
    echo "[entrypoint] Migrations complete"
  else
    echo "[entrypoint] ERROR: Prisma migrations failed! Aborting startup."
    echo "[entrypoint] The API will NOT start to prevent serving requests against a mismatched schema."
    echo "[entrypoint] Fix the failed migration, then redeploy. See: https://pris.ly/d/migrate-resolve"
    exit 1
  fi
  cd /app/apps/api
fi

exec "$@"
