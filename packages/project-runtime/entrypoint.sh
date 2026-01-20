#!/bin/bash
# =============================================================================
# Project Runtime Entrypoint
# =============================================================================
# Initializes the project environment and starts services:
# 1. Syncs project files from S3 (if configured)
# 2. Installs project dependencies
# 3. Starts Vite dev server (background)
# 4. Starts agent server (foreground)
# =============================================================================

set -e

echo "[entrypoint] =================================================="
echo "[entrypoint] Project Runtime Starting"
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

# =============================================================================
# Step 1: S3 sync is now handled by the server.ts using @aws-sdk/client-s3
# =============================================================================
# The S3 sync has been moved into the server code for better integration:
# - Downloads files from S3 on startup (via initializeS3Sync)
# - Uploads changes periodically (configurable via S3_SYNC_INTERVAL)
# - Optional file watcher for real-time sync (via S3_WATCH_ENABLED)
# - Graceful shutdown uploads pending changes
#
# Environment variables:
#   S3_WORKSPACES_BUCKET - S3 bucket name
#   S3_ENDPOINT - Custom S3 endpoint (for MinIO)
#   S3_REGION - AWS region (default: us-east-1)
#   S3_FORCE_PATH_STYLE - Use path-style URLs (for MinIO)
#   S3_SYNC_INTERVAL - Sync interval in ms (default: 60000)
#   S3_WATCH_ENABLED - Enable file watcher (default: false)
#
if [ -n "$S3_WORKSPACES_BUCKET" ] && [ -n "$PROJECT_ID" ]; then
  echo "[entrypoint] S3 sync configured:"
  echo "[entrypoint]   Bucket: $S3_WORKSPACES_BUCKET"
  echo "[entrypoint]   Prefix: $PROJECT_ID"
  echo "[entrypoint]   Endpoint: ${S3_ENDPOINT:-default}"
  echo "[entrypoint]   Sync will be handled by server.ts"
else
  echo "[entrypoint] S3 sync not configured (no S3_WORKSPACES_BUCKET)"
fi

# =============================================================================
# Step 2: Initialize project directory (if empty)
# =============================================================================
if [ ! -f "$PROJECT_DIR/package.json" ]; then
  echo "[entrypoint] No package.json found, initializing from template..."
  
  TEMPLATE_DIR="${TEMPLATE_DIR:-/app/packages/project-runtime/template}"
  
  if [ -d "$TEMPLATE_DIR" ]; then
    cp -r "$TEMPLATE_DIR"/* "$PROJECT_DIR/" 2>/dev/null || true
    echo "[entrypoint] Template files copied"
  else
    # Create minimal Vite project structure
    echo "[entrypoint] Creating minimal Vite project..."
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
    
    cat > "$PROJECT_DIR/vite.config.ts" << 'EOF'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
})
EOF
    
    mkdir -p "$PROJECT_DIR/src"
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
    
    echo "[entrypoint] Minimal Vite project created"
  fi
fi

# =============================================================================
# Step 3: Install project dependencies
# =============================================================================
if [ -f "$PROJECT_DIR/package.json" ]; then
  echo "[entrypoint] Installing project dependencies..."
  cd "$PROJECT_DIR"
  
  # Check if node_modules exists and is recent
  if [ -d "node_modules" ] && [ -f "bun.lock" ]; then
    echo "[entrypoint] Dependencies already installed, skipping"
  else
    bun install 2>&1 || echo "[entrypoint] Dependency install failed (continuing anyway)"
    echo "[entrypoint] Dependencies installed"
  fi
fi

# =============================================================================
# Step 4: Start Vite dev server (background)
# =============================================================================
echo "[entrypoint] Starting Vite dev server..."
cd "$PROJECT_DIR"

# Start Vite in background
bun run vite --port 5173 --host 0.0.0.0 &
VITE_PID=$!
echo "[entrypoint] Vite server started (PID: $VITE_PID)"

# Wait for Vite to be ready
echo "[entrypoint] Waiting for Vite server..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:5173 > /dev/null 2>&1; then
    echo "[entrypoint] Vite server is ready"
    break
  fi
  sleep 1
done

# =============================================================================
# Step 5: Start agent server (foreground)
# =============================================================================
echo "[entrypoint] Starting agent server..."
cd /app/packages/project-runtime

# Run the server - this blocks and keeps the container running
exec bun run src/server.ts
