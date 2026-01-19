#!/bin/bash
# E2E tests for agent persona selection
# Tests the select-persona.sh script behavior

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

TESTS_PASSED=0
TESTS_FAILED=0

# Helper to run a test
run_test() {
    local name="$1"
    local result="$2"

    if [ "$result" -eq 0 ]; then
        echo -e "${GREEN}✓${NC} $name"
        ((TESTS_PASSED++))
    else
        echo -e "${RED}✗${NC} $name"
        ((TESTS_FAILED++))
    fi
}

# Backup current configs
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

# Cleanup on exit
trap restore_configs EXIT

echo "Running persona selection e2e tests..."
echo ""

# Check prerequisites
if [ ! -f "$SCRIPT_DIR/select-persona.sh" ]; then
    echo -e "${RED}Error: select-persona.sh not found. Run implementation first.${NC}"
    exit 1
fi

if [ ! -d "$PROJECT_ROOT/.claude/personas/wavesmith" ] || [ ! -d "$PROJECT_ROOT/.claude/personas/code" ]; then
    echo -e "${RED}Error: Persona directories not found. Run implementation first.${NC}"
    exit 1
fi

backup_configs

# =============================================================================
# Test 1: Default persona (no env var) selects wavesmith
# =============================================================================
test_default_persona() {
    unset SHOGO_AGENT

    "$SCRIPT_DIR/select-persona.sh" > /dev/null 2>&1

    # Verify wavesmith CLAUDE.md was copied (should contain "Wavesmith" or full platform docs)
    if grep -q "platform-feature" "$PROJECT_ROOT/CLAUDE.md" 2>/dev/null; then
        return 0
    else
        return 1
    fi
}

run_test "Test 1: Default (no env var) selects wavesmith persona" "$(test_default_persona; echo $?)"

# =============================================================================
# Test 2: SHOGO_AGENT=wavesmith selects wavesmith
# =============================================================================
test_wavesmith_persona() {
    export SHOGO_AGENT=wavesmith

    "$SCRIPT_DIR/select-persona.sh" > /dev/null 2>&1

    # Verify wavesmith configs - should have wavesmith MCP server
    if grep -q "wavesmith" "$PROJECT_ROOT/.mcp.json" 2>/dev/null; then
        return 0
    else
        return 1
    fi
}

run_test "Test 2: SHOGO_AGENT=wavesmith selects wavesmith persona" "$(test_wavesmith_persona; echo $?)"

# =============================================================================
# Test 3: SHOGO_AGENT=code selects code persona
# =============================================================================
test_code_persona() {
    export SHOGO_AGENT=code

    "$SCRIPT_DIR/select-persona.sh" > /dev/null 2>&1

    # Verify code configs - should NOT have wavesmith MCP server, should NOT have platform-feature skills
    if ! grep -q "wavesmith" "$PROJECT_ROOT/.mcp.json" 2>/dev/null && \
       ! grep -q "platform-feature" "$PROJECT_ROOT/CLAUDE.md" 2>/dev/null; then
        return 0
    else
        return 1
    fi
}

run_test "Test 3: SHOGO_AGENT=code selects code persona" "$(test_code_persona; echo $?)"

# =============================================================================
# Summary
# =============================================================================
echo ""
echo "=========================================="
echo "Results: $TESTS_PASSED passed, $TESTS_FAILED failed"
echo "=========================================="

if [ "$TESTS_FAILED" -gt 0 ]; then
    exit 1
fi

exit 0
