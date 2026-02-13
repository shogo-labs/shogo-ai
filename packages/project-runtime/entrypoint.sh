#!/bin/bash
# =============================================================================
# Project Runtime Entrypoint (Optimized for Fast Startup)
# =============================================================================
# FAST START: Server starts immediately, heavy initialization runs in background
#
# Architecture:
# 1. Start agent server IMMEDIATELY (health check passes in <2s)
# 2. Background process handles: S3 sync, bun install, vite build
# 3. /ready endpoint returns 503 until build completes
# 4. Preview shows "loading" state during initialization
# =============================================================================

set -e

# =============================================================================
# Startup timing - tracks elapsed time from container start
# =============================================================================
STARTUP_TIME=$(date +%s%3N)
log_timing() {
  local now=$(date +%s%3N)
  local elapsed=$((now - STARTUP_TIME))
  echo "[entrypoint] [+${elapsed}ms] $1"
}

log_timing "=================================================="
log_timing "Project Runtime Starting (Fast Mode)"
log_timing "=================================================="
log_timing "PROJECT_ID: ${PROJECT_ID:-not set}"
log_timing "PROJECT_DIR: ${PROJECT_DIR:-/app/project}"
log_timing "NODE_ENV: ${NODE_ENV:-production}"
log_timing "S3_WORKSPACES_BUCKET: ${S3_WORKSPACES_BUCKET:-not set}"
log_timing "S3_WATCH_ENABLED: ${S3_WATCH_ENABLED:-true}"
log_timing "=================================================="

# Validate required environment
if [ -z "$PROJECT_ID" ]; then
  log_timing "ERROR: PROJECT_ID environment variable is required"
  exit 1
fi

PROJECT_DIR="${PROJECT_DIR:-/app/project}"
export PROJECT_DIR

# =============================================================================
# S3 sync configuration (handled by server.ts)
# =============================================================================
if [ -n "$S3_WORKSPACES_BUCKET" ] && [ -n "$PROJECT_ID" ]; then
  log_timing "S3 sync configured: $S3_WORKSPACES_BUCKET/$PROJECT_ID"
else
  log_timing "S3 sync not configured (emptyDir will be ephemeral)"
fi

# =============================================================================
# Quick project initialization (just create minimal structure if needed)
# =============================================================================
# Uses the bundled runtime-template (single source of truth) which includes:
# - vite.config.ts (React plugin, tsconfig paths)
# - tsconfig.json (TypeScript configuration)
# - server.tsx (Hono API server)
# - prisma/ (schema + config)
# - src/ (App.tsx, main.tsx, index.css, lib/db.ts)
# =============================================================================
BUNDLED_TEMPLATE="/app/packages/state-api/runtime-template"

if [ ! -f "$PROJECT_DIR/package.json" ]; then
  if [ -d "$BUNDLED_TEMPLATE" ] && [ -f "$BUNDLED_TEMPLATE/package.json" ]; then
    log_timing "Copying bundled runtime-template to project directory..."
    mkdir -p "$PROJECT_DIR"
    cp -r "$BUNDLED_TEMPLATE/"* "$PROJECT_DIR/"
    # Copy dotfiles separately (cp * doesn't include them)
    cp "$BUNDLED_TEMPLATE/.gitignore" "$PROJECT_DIR/" 2>/dev/null || true
    log_timing "Project initialized from bundled template"
  else
    log_timing "WARNING: Bundled template not found at $BUNDLED_TEMPLATE, creating minimal fallback..."
    mkdir -p "$PROJECT_DIR/src"
    
    cat > "$PROJECT_DIR/package.json" << 'EOF'
{
  "name": "project",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "concurrently \"bun run dev:server\" \"bun run dev:client\"",
    "dev:server": "bun --watch run server.tsx",
    "dev:client": "vite",
    "build": "vite build",
    "start": "bun run server.tsx",
    "generate": "bun scripts/generate.ts",
    "db:generate": "bunx --bun prisma generate",
    "db:push": "bunx --bun prisma db push",
    "db:reset": "bunx --bun prisma db push --force-reset --accept-data-loss",
    "db:studio": "bunx --bun prisma studio"
  },
  "dependencies": {
    "@prisma/adapter-pg": "^7.3.0",
    "@prisma/client": "^7.3.0",
    "hono": "^4.0.0",
    "mobx": "^6.13.0",
    "mobx-react-lite": "^4.0.0",
    "pg": "^8.11.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@prisma/internals": "^7.3.0",
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^5.1.2",
    "concurrently": "^8.2.0",
    "prisma": "^7.3.0",
    "typescript": "^5.0.0",
    "vite": "^7.3.1",
    "vite-tsconfig-paths": "^5.0.0"
  }
}
EOF
    
    cat > "$PROJECT_DIR/vite.config.ts" << 'EOF'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsConfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  server: {
    port: 3000,
    host: '0.0.0.0',
    cors: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  plugins: [
    tsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    react(),
  ],
  build: {
    target: 'esnext',
    minify: false,
  },
})
EOF
    
    cat > "$PROJECT_DIR/tsconfig.json" << 'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "jsxImportSource": "react",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "paths": {
      "~/*": ["./src/*"]
    }
  },
  "include": ["src/**/*", "*.config.ts"]
}
EOF
    
    cat > "$PROJECT_DIR/src/main.tsx" << 'EOF'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(<App />)
}
EOF
    
    cat > "$PROJECT_DIR/src/App.tsx" << 'EOF'
export default function App() {
  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui' }}>
      <h1>Project Ready</h1>
      <p>Start building your app!</p>
    </div>
  )
}
EOF

    cat > "$PROJECT_DIR/src/index.css" << 'EOF'
*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  line-height: 1.6;
  color: #333;
  background-color: #f9fafb;
}
EOF
    
    cat > "$PROJECT_DIR/index.html" << 'EOF'
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Shogo App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
EOF
    
    log_timing "Minimal fallback project created"
  fi
fi

# =============================================================================
# Background initialization script (with timing)
# =============================================================================
# OPTIMIZED: When restored from S3 archive (includes node_modules),
# we skip bun install and build - only run prisma db push for database setup.
# =============================================================================
log_timing "Creating background init script..."
cat > /tmp/background-init.sh << 'BGSCRIPT'
#!/bin/bash
set -e

PROJECT_DIR="${PROJECT_DIR:-/app/project}"
BUILD_STATUS_FILE="/tmp/build-status"
S3_RESTORE_MARKER="/tmp/s3-restore-complete"

# Timing function for background init
BG_START_TIME=$(date +%s%3N)
bg_log() {
  local now=$(date +%s%3N)
  local elapsed=$((now - BG_START_TIME))
  echo "[bg-init] [+${elapsed}ms] $1"
}

echo "initializing" > "$BUILD_STATUS_FILE"
bg_log "Background initialization started"

cd "$PROJECT_DIR"

# =============================================================================
# Wait for S3 sync to complete (if configured)
# =============================================================================
S3_RESTORE_STATUS="none"
if [ -n "$S3_WORKSPACES_BUCKET" ]; then
  bg_log "Waiting for S3 sync to complete..."
  WAIT_START=$(date +%s%3N)
  
  # Wait up to 5 minutes for S3 restore (large archives can take 100+ seconds to extract)
  MAX_S3_WAIT=600  # 600 iterations × 0.5s = 300 seconds
  for i in $(seq 1 $MAX_S3_WAIT); do
    if [ -f "$S3_RESTORE_MARKER" ]; then
      WAIT_END=$(date +%s%3N)
      S3_RESTORE_STATUS=$(cat "$S3_RESTORE_MARKER" | cut -d: -f1)
      bg_log "S3 sync marker found: '$S3_RESTORE_STATUS' (waited $((WAIT_END - WAIT_START))ms)"
      
      # Check if download actually succeeded
      if [ "$S3_RESTORE_STATUS" = "restored" ] || [ "$S3_RESTORE_STATUS" = "restored-retry" ]; then
        bg_log "✅ S3 download succeeded - project files restored"
      elif [ "$S3_RESTORE_STATUS" = "download-failed" ]; then
        bg_log "⚠️ S3 download failed - will wait for retry to complete..."
        # The server.ts retry logic will update the marker.
        # Wait an additional 60 seconds for the retry to succeed.
        RETRY_WAIT_START=$(date +%s%3N)
        for j in $(seq 1 120); do
          S3_RESTORE_STATUS=$(cat "$S3_RESTORE_MARKER" | cut -d: -f1)
          if [ "$S3_RESTORE_STATUS" = "restored-retry" ]; then
            RETRY_WAIT_END=$(date +%s%3N)
            bg_log "✅ S3 retry download succeeded (waited additional $((RETRY_WAIT_END - RETRY_WAIT_START))ms)"
            break
          fi
          sleep 0.5
        done
        if [ "$S3_RESTORE_STATUS" != "restored-retry" ]; then
          bg_log "⚠️ S3 retry did not succeed in time (status: $S3_RESTORE_STATUS)"
        fi
      elif [ "$S3_RESTORE_STATUS" = "skipped" ]; then
        bg_log "S3 sync not configured, proceeding with template"
      elif [ "$S3_RESTORE_STATUS" = "error" ]; then
        bg_log "⚠️ S3 sync initialization failed completely"
      else
        bg_log "⚠️ Unknown S3 restore status: $S3_RESTORE_STATUS"
      fi
      break
    fi
    sleep 0.5
    # Log progress every 30 seconds
    if [ $((i % 60)) -eq 0 ]; then
      ELAPSED=$(( ($(date +%s%3N) - WAIT_START) / 1000 ))
      bg_log "Still waiting for S3 sync... (${ELAPSED}s elapsed)"
    fi
  done
  
  if [ ! -f "$S3_RESTORE_MARKER" ]; then
    bg_log "⚠️ S3 sync did not complete in 5 minutes, proceeding anyway..."
  fi
fi

# =============================================================================
# Check if this is a restored project (node_modules already present from S3)
# =============================================================================
RESTORED_FROM_S3=false
if [ "$S3_RESTORE_STATUS" = "restored" ] || [ "$S3_RESTORE_STATUS" = "restored-retry" ]; then
  # S3 download confirmed successful - check for actual node_modules
  if [ -d "node_modules/react" ] && [ -d "node_modules/vite" ]; then
    RESTORED_FROM_S3=true
    bg_log "⚡ Project restored from S3 archive (download succeeded + node_modules present)"
  else
    bg_log "⚠️ S3 download succeeded but node_modules not found - will install"
  fi
elif [ -d "node_modules/react" ] && [ -d "node_modules/vite" ] && [ "$S3_RESTORE_STATUS" = "none" ]; then
  # No S3 configured but node_modules exist (e.g., pre-installed in image)
  RESTORED_FROM_S3=true
  bg_log "⚡ Dependencies already present (no S3 configured)"
else
  bg_log "S3 restore status: $S3_RESTORE_STATUS - will install fresh dependencies"
fi

# Step 1: Install dependencies (skip if restored from S3 or pre-installed)
bg_log "Step 1: Checking dependencies..."
STEP_START=$(date +%s%3N)

if [ "$RESTORED_FROM_S3" = true ]; then
  STEP_END=$(date +%s%3N)
  bg_log "⚡ Dependencies already present from S3 archive (skipped install)"
elif [ -d "node_modules" ] && [ -f "bun.lock" ]; then
  bg_log "Dependencies already installed (cached)"
else
  bg_log "Installing dependencies..."
  if bun install 2>&1; then
    STEP_END=$(date +%s%3N)
    bg_log "Dependencies installed (took $((STEP_END - STEP_START))ms)"
  else
    bg_log "Dependency install failed"
    echo "failed:install" > "$BUILD_STATUS_FILE"
    exit 1
  fi
fi

# Step 2: Detect project type
bg_log "Step 2: Detecting project type..."
bg_log "Vite + Hono project detected"

# Step 3: Build (skip if restored from S3 with existing build)
bg_log "Step 3: Checking build status..."
STEP_START=$(date +%s%3N)

BUILD_EXISTS=false
if [ -d "$PROJECT_DIR/dist" ]; then
  BUILD_EXISTS=true
fi

if [ "$RESTORED_FROM_S3" = true ] && [ "$BUILD_EXISTS" = true ]; then
  bg_log "⚡ Build already present from S3 archive (skipped build)"
else
  bg_log "════════════════════════════════════════"
  bg_log "🔨 VITE BUILD STARTING..."
  bg_log "════════════════════════════════════════"
  if bun --bun vite build 2>&1; then
    STEP_END=$(date +%s%3N)
    BUILD_DURATION=$((STEP_END - STEP_START))
    bg_log "════════════════════════════════════════"
    bg_log "✅ VITE BUILD COMPLETED: ${BUILD_DURATION}ms ($(echo "scale=2; $BUILD_DURATION/1000" | bc)s)"
    bg_log "════════════════════════════════════════"
  else
    bg_log "Build failed"
    echo "failed:build" > "$BUILD_STATUS_FILE"
    exit 1
  fi
fi

# Step 4: Run Prisma db push (always needed to ensure database schema is in sync)
if [ -f "$PROJECT_DIR/prisma/schema.prisma" ]; then
  bg_log "Step 4: Running prisma db push..."
  STEP_START=$(date +%s%3N)
  
  # Wait for PostgreSQL to be ready before running Prisma commands
  # Supports both local sidecar (localhost) and remote shared cluster (CloudNativePG)
  # Parse host from DATABASE_URL, fallback to localhost
  PG_HOST="localhost"
  PG_PORT="5432"
  if [ -n "$DATABASE_URL" ]; then
    # Extract host and port from postgres://user:pass@host:port/db
    PG_HOST=$(echo "$DATABASE_URL" | sed -n 's|.*@\([^:/]*\).*|\1|p')
    PG_PORT=$(echo "$DATABASE_URL" | sed -n 's|.*@[^:]*:\([0-9]*\)/.*|\1|p')
    PG_PORT="${PG_PORT:-5432}"
  fi
  bg_log "Waiting for PostgreSQL at ${PG_HOST}:${PG_PORT}..."
  MAX_RETRIES=30
  RETRY_COUNT=0
  PG_READY=false
  
  while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    # Try TCP connection check (works for both local and remote postgres)
    if nc -z "$PG_HOST" "$PG_PORT" 2>/dev/null || (echo > /dev/tcp/"$PG_HOST"/"$PG_PORT") 2>/dev/null; then
      PG_READY=true
      bg_log "PostgreSQL is ready at ${PG_HOST}:${PG_PORT} (attempt $((RETRY_COUNT + 1)))"
      break
    fi
    RETRY_COUNT=$((RETRY_COUNT + 1))
    sleep 0.5
  done
  
  if [ "$PG_READY" = false ]; then
    bg_log "WARNING: PostgreSQL readiness check timed out after ${MAX_RETRIES} attempts at ${PG_HOST}:${PG_PORT}"
    bg_log "Continuing anyway - Prisma may fail"
  fi
  
  # Generate Prisma client first (fast, needed for types)
  bunx prisma generate 2>&1 || true
  
  # Push schema to database with retry logic
  PUSH_RETRIES=3
  PUSH_SUCCESS=false
  
  for i in $(seq 1 $PUSH_RETRIES); do
    if bunx prisma db push 2>&1; then
      PUSH_SUCCESS=true
      STEP_END=$(date +%s%3N)
      bg_log "Prisma db push completed (took $((STEP_END - STEP_START))ms)"
      break
    else
      bg_log "Prisma db push attempt $i failed, retrying in 2s..."
      sleep 2
    fi
  done
  
  if [ "$PUSH_SUCCESS" = false ]; then
    bg_log "Prisma db push failed after ${PUSH_RETRIES} attempts (non-fatal)"
  fi
fi

# Step 5: Complete (no separate server needed - Hono runs standalone)

echo "ready" > "$BUILD_STATUS_FILE"
TOTAL_END=$(date +%s%3N)
bg_log "=================================================="
bg_log "Initialization complete! Total time: $((TOTAL_END - BG_START_TIME))ms"
if [ "$RESTORED_FROM_S3" = true ]; then
  bg_log "⚡ FAST PATH: Restored from S3 archive"
fi
bg_log "=================================================="
BGSCRIPT
chmod +x /tmp/background-init.sh

# =============================================================================
# Start background initialization (non-blocking)
# =============================================================================
log_timing "Starting background initialization..."
/tmp/background-init.sh &
BG_PID=$!
log_timing "Background init PID: $BG_PID"

# =============================================================================
# Start agent server IMMEDIATELY (fast health check)
# =============================================================================
log_timing "Starting agent server (fast mode)..."
cd /app/packages/project-runtime

# Export for server.ts
export BUILD_STATUS_FILE="/tmp/build-status"
export FAST_START_MODE=true
export STARTUP_TIME="$STARTUP_TIME"

log_timing "Launching bun server..."

# Run the server - this blocks and keeps the container running
exec bun run src/server.ts
