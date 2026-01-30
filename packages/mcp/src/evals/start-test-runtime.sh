#!/bin/bash
# Start project-runtime for eval testing
#
# Usage: ./start-test-runtime.sh [port]
#
# This starts the project-runtime agent server with test configuration.
# The Shogo agent will be available at http://localhost:${PORT}/agent/chat
#
# The project-runtime contains the REAL Shogo agent with template tools:
#   - template.list - List available templates
#   - template.copy - Copy a template to set up a project
#
# This is different from the platform /api/chat which uses persona-based prompts
# without template tools.

set -e

PORT="${1:-6300}"
PROJECT_ID="eval-test-project"
PROJECT_DIR="/tmp/shogo-eval-test"

# Get the monorepo root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MONOREPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

# MCP server path (CRITICAL for template tools to work)
MCP_SERVER_PATH="$MONOREPO_ROOT/packages/mcp/src/server-templates.ts"

# Create test project directory if it doesn't exist
mkdir -p "$PROJECT_DIR"

echo "=============================================="
echo "  Starting Shogo Agent for Eval Testing"
echo "=============================================="
echo ""
echo "  PROJECT_ID: $PROJECT_ID"
echo "  PROJECT_DIR: $PROJECT_DIR"
echo "  PORT: $PORT"
echo ""
echo "  Agent endpoint: http://localhost:$PORT/agent/chat"
echo ""
echo "  Run evals with:"
echo "    bun run packages/mcp/src/evals/cli.ts smoke --endpoint http://localhost:$PORT/agent/chat"
echo ""
echo "=============================================="
echo ""

# Change to project-runtime directory
cd "$(dirname "$0")/../../../../packages/project-runtime"

# Start the server with MCP server configured
PROJECT_ID="$PROJECT_ID" \
PROJECT_DIR="$PROJECT_DIR" \
PORT="$PORT" \
MCP_SERVER_PATH="$MCP_SERVER_PATH" \
bun run src/server.ts
