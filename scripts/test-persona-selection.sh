#!/bin/bash
# Test script for persona selection
# Verifies that select-persona.sh correctly handles SHOGO_AGENT env var
#
# Usage: ./scripts/test-persona-selection.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

PASSED=0
FAILED=0

# Helper to run a test
run_test() {
    local test_name="$1"
    local result="$2"
    
    if [ "$result" = "0" ]; then
        echo -e "${GREEN}✓ PASS${NC}: $test_name"
        PASSED=$((PASSED + 1))
    else
        echo -e "${RED}✗ FAIL${NC}: $test_name"
        FAILED=$((FAILED + 1))
    fi
}

# Backup existing configs
backup_configs() {
    [ -f "$PROJECT_ROOT/CLAUDE.md" ] && cp "$PROJECT_ROOT/CLAUDE.md" "$PROJECT_ROOT/CLAUDE.md.bak"
    [ -f "$PROJECT_ROOT/.mcp.json" ] && cp "$PROJECT_ROOT/.mcp.json" "$PROJECT_ROOT/.mcp.json.bak"
    [ -f "$PROJECT_ROOT/.claude/settings.json" ] && cp "$PROJECT_ROOT/.claude/settings.json" "$PROJECT_ROOT/.claude/settings.json.bak"
}

# Restore configs
restore_configs() {
    [ -f "$PROJECT_ROOT/CLAUDE.md.bak" ] && mv "$PROJECT_ROOT/CLAUDE.md.bak" "$PROJECT_ROOT/CLAUDE.md"
    [ -f "$PROJECT_ROOT/.mcp.json.bak" ] && mv "$PROJECT_ROOT/.mcp.json.bak" "$PROJECT_ROOT/.mcp.json"
    [ -f "$PROJECT_ROOT/.claude/settings.json.bak" ] && mv "$PROJECT_ROOT/.claude/settings.json.bak" "$PROJECT_ROOT/.claude/settings.json"
}

# Check prerequisites
if [ ! -f "$SCRIPT_DIR/select-persona.sh" ]; then
    echo -e "${RED}Error: select-persona.sh not found${NC}"
    exit 1
fi

if [ ! -d "$PROJECT_ROOT/.claude/personas/shogo" ] || [ ! -d "$PROJECT_ROOT/.claude/personas/code" ]; then
    echo -e "${RED}Error: Persona directories not found. Run implementation first.${NC}"
    exit 1
fi

backup_configs

# =============================================================================
# Test 1: Default persona (no env var) selects shogo
# =============================================================================
test_default_persona() {
    unset SHOGO_AGENT

    "$SCRIPT_DIR/select-persona.sh" > /dev/null 2>&1

    # Verify shogo CLAUDE.md was copied (should contain platform docs)
    if grep -q "platform-feature" "$PROJECT_ROOT/CLAUDE.md" 2>/dev/null; then
        return 0
    else
        return 1
    fi
}

run_test "Test 1: Default (no env var) selects shogo persona" "$(test_default_persona; echo $?)"

# =============================================================================
# Test 2: SHOGO_AGENT=shogo selects shogo
# =============================================================================
test_shogo_persona() {
    export SHOGO_AGENT=shogo

    "$SCRIPT_DIR/select-persona.sh" > /dev/null 2>&1

    # Verify shogo configs - should have shogo MCP server
    if grep -q "shogo" "$PROJECT_ROOT/.mcp.json" 2>/dev/null; then
        return 0
    else
        return 1
    fi
}

run_test "Test 2: SHOGO_AGENT=shogo selects shogo persona" "$(test_shogo_persona; echo $?)"

# =============================================================================
# Test 3: SHOGO_AGENT=code selects code persona
# =============================================================================
test_code_persona() {
    export SHOGO_AGENT=code

    "$SCRIPT_DIR/select-persona.sh" > /dev/null 2>&1

    # Verify code configs - should NOT have shogo MCP server, should NOT have platform-feature skills
    if ! grep -q "shogo" "$PROJECT_ROOT/.mcp.json" 2>/dev/null && \
       ! grep -q "platform-feature" "$PROJECT_ROOT/CLAUDE.md" 2>/dev/null; then
        return 0
    else
        return 1
    fi
}

run_test "Test 3: SHOGO_AGENT=code selects code persona" "$(test_code_persona; echo $?)"

# Restore original configs
restore_configs

# =============================================================================
# Summary
# =============================================================================
echo ""
echo "Results: $PASSED passed, $FAILED failed"

if [ "$FAILED" -gt 0 ]; then
    exit 1
fi
