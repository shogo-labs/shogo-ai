#!/bin/sh
# Docker development entrypoint
# Installs dependencies if node_modules is missing/incomplete, then runs the command

set -e

# Check if node_modules exists and has packages
if [ ! -d "node_modules" ] || [ ! -d "node_modules/.bin" ]; then
  echo "[entrypoint] Installing dependencies..."
  bun install
fi

echo "[entrypoint] Running: $@"
exec "$@"
