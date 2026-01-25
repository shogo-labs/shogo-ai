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
if [ ! -f "$PROJECT_DIR/package.json" ]; then
  log_timing "Creating minimal project structure..."
  mkdir -p "$PROJECT_DIR/src"
  
  cat > "$PROJECT_DIR/package.json" << 'EOF'
{
  "name": "project",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "vite": "^5.4.2"
  }
}
EOF
  
  cat > "$PROJECT_DIR/src/main.tsx" << 'EOF'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
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
  
  cat > "$PROJECT_DIR/index.html" << 'EOF'
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Project</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
EOF
  
  log_timing "Minimal project created"
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
if [ -n "$S3_WORKSPACES_BUCKET" ]; then
  bg_log "Waiting for S3 sync to complete..."
  WAIT_START=$(date +%s%3N)
  
  # Wait up to 30 seconds for S3 restore
  for i in $(seq 1 60); do
    if [ -f "$S3_RESTORE_MARKER" ]; then
      WAIT_END=$(date +%s%3N)
      bg_log "S3 sync complete (waited $((WAIT_END - WAIT_START))ms)"
      break
    fi
    sleep 0.5
  done
  
  if [ ! -f "$S3_RESTORE_MARKER" ]; then
    bg_log "S3 sync did not complete in time, proceeding anyway..."
  fi
fi

# =============================================================================
# Check if this is a restored project (node_modules already present from S3)
# =============================================================================
RESTORED_FROM_S3=false
if [ -d "node_modules/react" ] && [ -d "node_modules/vite" ]; then
  RESTORED_FROM_S3=true
  bg_log "⚡ Project restored from S3 archive (node_modules present)"
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
IS_TANSTACK_START=false
if grep -q "@tanstack/react-start" "$PROJECT_DIR/package.json" 2>/dev/null; then
  IS_TANSTACK_START=true
  bg_log "TanStack Start project detected"
else
  bg_log "Plain Vite project detected"
  
  # Generate vite config (only if not restored from S3)
  if [ "$RESTORED_FROM_S3" = false ]; then
    PREVIEW_BASE="/api/projects/${PROJECT_ID}/preview/"
    cat > "$PROJECT_DIR/vite.config.ts" << EOF
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// HMR configuration for iframe embedding:
// - In production (HTTPS): use wss:// on port 443 via proxy, path '/' avoids base path in WS URL
// - Locally: let Vite auto-detect (ws:// on dev server port)
const isProduction = process.env.NODE_ENV === 'production' || process.env.SHOGO_RUNTIME === 'true'
const hmrConfig = isProduction ? { clientPort: 443, protocol: 'wss' as const, path: '/' } : undefined

export default defineConfig({
  plugins: [react()],
  base: '${PREVIEW_BASE}',
  server: {
    host: '0.0.0.0',
    port: 5173,
    cors: true,
    headers: { 'X-Frame-Options': 'ALLOWALL' },
    hmr: hmrConfig,
  },
  build: {
    target: 'esnext',
    minify: false,
  },
})
EOF
  fi
fi

# Step 3: Build (skip if restored from S3 with existing build)
bg_log "Step 3: Checking build status..."
STEP_START=$(date +%s%3N)

BUILD_EXISTS=false
if [ "$IS_TANSTACK_START" = true ] && [ -f "$PROJECT_DIR/.output/server/index.mjs" ]; then
  BUILD_EXISTS=true
elif [ "$IS_TANSTACK_START" = false ] && [ -d "$PROJECT_DIR/dist" ]; then
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
  
  # Generate Prisma client first (fast, needed for types)
  bunx prisma generate 2>&1 || true
  
  # Push schema to database
  if bunx prisma db push --skip-generate 2>&1; then
    STEP_END=$(date +%s%3N)
    bg_log "Prisma db push completed (took $((STEP_END - STEP_START))ms)"
  else
    bg_log "Prisma db push failed (non-fatal)"
  fi
fi

# Step 5: Start Nitro server if TanStack Start
if [ "$IS_TANSTACK_START" = true ] && [ -f "$PROJECT_DIR/.output/server/index.mjs" ]; then
  bg_log "Step 5: Starting TanStack Start server..."
  STEP_START=$(date +%s%3N)
  PORT=3000 bun run "$PROJECT_DIR/.output/server/index.mjs" &
  
  # Wait for server to be ready (max 2s with exponential backoff)
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -sf http://localhost:3000/ > /dev/null 2>&1; then
      bg_log "Nitro server ready after $i attempt(s)"
      break
    fi
    sleep 0.$((i * 10))  # 0.1s, 0.2s, 0.3s, etc.
  done
  
  STEP_END=$(date +%s%3N)
  bg_log "Nitro server started (took $((STEP_END - STEP_START))ms)"
fi

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
