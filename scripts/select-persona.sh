#!/bin/bash
# Agent Persona Selection Script
# Reads SHOGO_AGENT env var and copies appropriate persona configs to root
#
# Usage:
#   SHOGO_AGENT=code claude    # Use code agent
#   SHOGO_AGENT=shogo claude   # Use shogo agent (default)
#   claude                     # Defaults to shogo

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PERSONAS_DIR="$PROJECT_ROOT/.claude/personas"

# Default to shogo if not set or invalid
PERSONA="${SHOGO_AGENT:-shogo}"

# Validate persona
if [ "$PERSONA" != "shogo" ] && [ "$PERSONA" != "code" ]; then
    echo "Warning: Invalid SHOGO_AGENT='$PERSONA', defaulting to shogo"
    PERSONA="shogo"
fi

PERSONA_DIR="$PERSONAS_DIR/$PERSONA"

# Verify persona directory exists
if [ ! -d "$PERSONA_DIR" ]; then
    echo "Error: Persona directory not found: $PERSONA_DIR"
    exit 1
fi

echo "Selecting '$PERSONA' agent persona..."

# Copy persona configs to root
cp "$PERSONA_DIR/CLAUDE.md" "$PROJECT_ROOT/CLAUDE.md"
cp "$PERSONA_DIR/mcp.json" "$PROJECT_ROOT/.mcp.json"
cp "$PERSONA_DIR/settings.json" "$PROJECT_ROOT/.claude/settings.json"

echo "✓ Persona '$PERSONA' activated"

# Run build only for shogo persona (needs MCP server)
if [ "$PERSONA" = "shogo" ]; then
    echo "Building MCP server..."
    cd "$PROJECT_ROOT" && bun run build
    echo "✓ Build complete - MCP servers ready"
fi
