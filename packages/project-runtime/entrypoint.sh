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

echo "[entrypoint] =================================================="
echo "[entrypoint] Project Runtime Starting (Fast Mode)"
echo "[entrypoint] =================================================="
echo "[entrypoint] PROJECT_ID: ${PROJECT_ID:-not set}"
echo "[entrypoint] PROJECT_DIR: ${PROJECT_DIR:-/app/project}"
echo "[entrypoint] NODE_ENV: ${NODE_ENV:-production}"
echo "[entrypoint] =================================================="

# Validate required environment
if [ -z "$PROJECT_ID" ]; then
  echo "[entrypoint] ERROR: PROJECT_ID environment variable is required"
  exit 1
fi

PROJECT_DIR="${PROJECT_DIR:-/app/project}"
export PROJECT_DIR

# =============================================================================
# S3 sync configuration (handled by server.ts)
# =============================================================================
if [ -n "$S3_WORKSPACES_BUCKET" ] && [ -n "$PROJECT_ID" ]; then
  echo "[entrypoint] S3 sync configured: $S3_WORKSPACES_BUCKET/$PROJECT_ID"
else
  echo "[entrypoint] S3 sync not configured"
fi

# =============================================================================
# Quick project initialization (just create minimal structure if needed)
# =============================================================================
if [ ! -f "$PROJECT_DIR/package.json" ]; then
  echo "[entrypoint] Creating minimal project structure..."
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
  
  echo "[entrypoint] Minimal project created"
fi

# =============================================================================
# Background initialization script
# =============================================================================
cat > /tmp/background-init.sh << 'BGSCRIPT'
#!/bin/bash
set -e

PROJECT_DIR="${PROJECT_DIR:-/app/project}"
BUILD_STATUS_FILE="/tmp/build-status"
TEMPLATE_CACHE="/template-cache/node_modules"

echo "initializing" > "$BUILD_STATUS_FILE"

cd "$PROJECT_DIR"

# Step 1: Install dependencies (with cache optimization)
echo "[bg-init] Installing dependencies..."
if [ -d "node_modules" ] && [ -f "bun.lock" ]; then
  echo "[bg-init] Dependencies already installed"
else
  # Use pre-cached template dependencies if available
  # This dramatically speeds up install by using pre-downloaded packages
  if [ -d "$TEMPLATE_CACHE" ]; then
    echo "[bg-init] Using pre-cached template dependencies..."
    # Copy cache to speed up bun install resolution
    cp -r "$TEMPLATE_CACHE" ./node_modules 2>/dev/null || true
  fi
  
  if bun install 2>&1; then
    echo "[bg-init] Dependencies installed"
  else
    echo "[bg-init] Dependency install failed"
    echo "failed:install" > "$BUILD_STATUS_FILE"
    exit 1
  fi
fi

# Step 2: Detect project type
IS_TANSTACK_START=false
if grep -q "@tanstack/react-start" "$PROJECT_DIR/package.json" 2>/dev/null; then
  IS_TANSTACK_START=true
  echo "[bg-init] TanStack Start project detected"
else
  echo "[bg-init] Plain Vite project detected"
  
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
echo "[bg-init] Building project..."
if bun --bun vite build 2>&1; then
  echo "[bg-init] Build completed"
else
  echo "[bg-init] Build failed"
  echo "failed:build" > "$BUILD_STATUS_FILE"
  exit 1
fi

# Step 4: Start Nitro server if TanStack Start
if [ "$IS_TANSTACK_START" = true ] && [ -f "$PROJECT_DIR/.output/server/index.mjs" ]; then
  echo "[bg-init] Starting TanStack Start server..."
  PORT=3000 bun run "$PROJECT_DIR/.output/server/index.mjs" &
  sleep 2
fi

echo "ready" > "$BUILD_STATUS_FILE"
echo "[bg-init] Initialization complete!"
BGSCRIPT
chmod +x /tmp/background-init.sh

# =============================================================================
# Start background initialization (non-blocking)
# =============================================================================
echo "[entrypoint] Starting background initialization..."
/tmp/background-init.sh &
BG_PID=$!
echo "[entrypoint] Background init PID: $BG_PID"

# =============================================================================
# Start agent server IMMEDIATELY (fast health check)
# =============================================================================
echo "[entrypoint] Starting agent server (fast mode)..."
cd /app/packages/project-runtime

# Export for server.ts
export BUILD_STATUS_FILE="/tmp/build-status"
export FAST_START_MODE=true

# Run the server - this blocks and keeps the container running
exec bun run src/server.ts
