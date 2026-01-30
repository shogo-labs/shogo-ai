#!/bin/bash
#
# Start the project-runtime server for agent evals
#
# Usage:
#   ./start-eval-server.sh [model]
#
# Models: haiku, sonnet, opus (default: sonnet)
#
# Example:
#   ./start-eval-server.sh haiku
#

set -e

MODEL="${1:-sonnet}"
PORT="${PORT:-6300}"
PROJECT_DIR="${PROJECT_DIR:-/tmp/shogo-eval-test}"

# Validate model
if [[ ! "$MODEL" =~ ^(haiku|sonnet|opus)$ ]]; then
  echo "Invalid model: $MODEL"
  echo "Valid models: haiku, sonnet, opus"
  exit 1
fi

echo "🔧 Setting up eval environment..."
echo "   Model: claude-$MODEL"
echo "   Port: $PORT"
echo "   Project Dir: $PROJECT_DIR"

# Kill any existing server on the port
echo "🔪 Killing any existing server on port $PORT..."
lsof -ti :$PORT | xargs kill -9 2>/dev/null || true

# Clean project directory
echo "🧹 Cleaning project directory..."
rm -rf "$PROJECT_DIR"
mkdir -p "$PROJECT_DIR"

# Get the directory of this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
MCP_SERVER_PATH="$REPO_ROOT/packages/mcp/src/server-templates.ts"

echo "📂 MCP Server: $MCP_SERVER_PATH"

# Start the server
echo "🚀 Starting project-runtime with claude-$MODEL..."
cd "$REPO_ROOT/packages/project-runtime"

PROJECT_ID="eval-$MODEL" \
PROJECT_DIR="$PROJECT_DIR" \
PORT="$PORT" \
MCP_SERVER_PATH="$MCP_SERVER_PATH" \
SHOGO_EVAL_MODE="true" \
AGENT_MODEL="$MODEL" \
bun run src/server.ts &

SERVER_PID=$!
echo "   Server PID: $SERVER_PID"

# Wait for server to be ready
echo "⏳ Waiting for server to be ready..."
for i in {1..30}; do
  if curl -s "http://localhost:$PORT/health" > /dev/null 2>&1; then
    echo "✅ Server ready on port $PORT with claude-$MODEL"
    exit 0
  fi
  sleep 1
done

echo "❌ Server failed to start within 30 seconds"
kill $SERVER_PID 2>/dev/null || true
exit 1
