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

if [ -n "$DATABASE_URL" ] && [ "$SKIP_MIGRATIONS" != "true" ]; then
  echo "[entrypoint] Waiting for database to be reachable..."
  MAX_RETRIES=${DB_WAIT_RETRIES:-30}
  RETRY_DELAY=${DB_WAIT_DELAY:-5}
  ATTEMPT=0
  DB_HOST=$(echo "$DATABASE_URL" | sed -n 's|.*@\([^:/]*\).*|\1|p')
  DB_PORT=$(echo "$DATABASE_URL" | sed -n 's|.*:\([0-9]*\)/.*|\1|p')
  DB_PORT=${DB_PORT:-5432}

  while [ "$ATTEMPT" -lt "$MAX_RETRIES" ]; do
    if nc -z "$DB_HOST" "$DB_PORT" 2>/dev/null; then
      echo "[entrypoint] Database reachable at ${DB_HOST}:${DB_PORT}"
      break
    fi
    ATTEMPT=$((ATTEMPT + 1))
    echo "[entrypoint] Database not ready (attempt ${ATTEMPT}/${MAX_RETRIES}), retrying in ${RETRY_DELAY}s..."
    sleep "$RETRY_DELAY"
  done

  if [ "$ATTEMPT" -ge "$MAX_RETRIES" ]; then
    echo "[entrypoint] WARNING: Database not reachable after ${MAX_RETRIES} attempts, attempting migration anyway..."
  fi

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
elif [ "$SKIP_MIGRATIONS" = "true" ]; then
  echo "[entrypoint] SKIP_MIGRATIONS=true, skipping Prisma migrations"
fi

exec "$@"
