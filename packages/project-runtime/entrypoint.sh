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
log_timing "Creating background init script..."
cat > /tmp/background-init.sh << 'BGSCRIPT'
#!/bin/bash
set -e

PROJECT_DIR="${PROJECT_DIR:-/app/project}"
BUILD_STATUS_FILE="/tmp/build-status"

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

# Step 1: Install dependencies (skip if pre-installed from template)
bg_log "Step 1: Checking dependencies..."
STEP_START=$(date +%s%3N)

# Check if node_modules exists and has key packages (pre-installed from template)
if [ -d "node_modules/react" ] && [ -d "node_modules/vite" ]; then
  STEP_END=$(date +%s%3N)
  bg_log "⚡ Dependencies pre-installed from template (took $((STEP_END - STEP_START))ms)"
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
  
  # Generate vite config
  PREVIEW_BASE="/api/projects/${PROJECT_ID}/preview/"
  cat > "$PROJECT_DIR/vite.config.ts" << EOF
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '${PREVIEW_BASE}',
})
EOF
fi

# Step 3: Build
bg_log "Step 3: Building project..."
STEP_START=$(date +%s%3N)
if bun --bun vite build 2>&1; then
  STEP_END=$(date +%s%3N)
  bg_log "Build completed (took $((STEP_END - STEP_START))ms)"
else
  bg_log "Build failed"
  echo "failed:build" > "$BUILD_STATUS_FILE"
  exit 1
fi

# Step 4: Start Nitro server if TanStack Start
if [ "$IS_TANSTACK_START" = true ] && [ -f "$PROJECT_DIR/.output/server/index.mjs" ]; then
  bg_log "Step 4: Starting TanStack Start server..."
  STEP_START=$(date +%s%3N)
  PORT=3000 bun run "$PROJECT_DIR/.output/server/index.mjs" &
  sleep 2
  STEP_END=$(date +%s%3N)
  bg_log "Nitro server started (took $((STEP_END - STEP_START))ms)"
fi

echo "ready" > "$BUILD_STATUS_FILE"
TOTAL_END=$(date +%s%3N)
bg_log "=================================================="
bg_log "Initialization complete! Total time: $((TOTAL_END - BG_START_TIME))ms"
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
