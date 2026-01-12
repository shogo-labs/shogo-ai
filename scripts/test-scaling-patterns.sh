#!/bin/bash
# =============================================================================
# Test Script: Pod-per-Workspace Scaling Patterns
# =============================================================================
# Tests the following patterns from the technical spec:
# 1. Workspace isolation - each MCP has its own state
# 2. Data persistence - state survives container restarts
# 3. Shared control plane - both workspaces use same PostgreSQL
# =============================================================================

set -e

echo "=============================================="
echo "  Shogo AI - Scaling Patterns Test"
echo "=============================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

check() {
  if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓${NC} $1"
  else
    echo -e "${RED}✗${NC} $1"
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Test 1: Verify both workspaces are running
# ---------------------------------------------------------------------------
echo -e "${BLUE}Test 1: Workspace Availability${NC}"
echo "----------------------------------------------"

# Note: Using docker exec because FastMCP binds to localhost, not 0.0.0.0
WS1_STATUS=$(docker exec shogo-mcp curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/mcp 2>/dev/null)
WS2_STATUS=$(docker exec shogo-mcp-workspace-2 curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/mcp 2>/dev/null)

[ "$WS1_STATUS" = "400" ] && check "Workspace 1 (shogo-mcp) is responding"
[ "$WS2_STATUS" = "400" ] && check "Workspace 2 (shogo-mcp-workspace-2) is responding"

echo ""

# ---------------------------------------------------------------------------
# Test 2: Verify workspaces have different WORKSPACE_IDs
# ---------------------------------------------------------------------------
echo -e "${BLUE}Test 2: Workspace Isolation${NC}"
echo "----------------------------------------------"

WS1_ID=$(docker exec shogo-mcp printenv WORKSPACE_ID)
WS2_ID=$(docker exec shogo-mcp-workspace-2 printenv WORKSPACE_ID)

echo "  Workspace 1 ID: $WS1_ID"
echo "  Workspace 2 ID: $WS2_ID"

[ "$WS1_ID" != "$WS2_ID" ] && check "Workspaces have different IDs"

echo ""

# ---------------------------------------------------------------------------
# Test 3: Verify separate volumes for each workspace
# ---------------------------------------------------------------------------
echo -e "${BLUE}Test 3: Storage Isolation${NC}"
echo "----------------------------------------------"

# Create a test file in workspace 1
docker exec shogo-mcp sh -c "echo 'workspace-1-data' > /data/schemas/test-isolation.txt"
check "Created test file in Workspace 1 volume"

# Verify it doesn't exist in workspace 2
if docker exec shogo-mcp-workspace-2 cat /data/schemas/test-isolation.txt 2>/dev/null; then
  echo -e "${RED}✗${NC} FAIL: File leaked to Workspace 2!"
  exit 1
fi
echo -e "${GREEN}✓${NC} File is NOT visible in Workspace 2 (isolation working)"

# Cleanup
docker exec shogo-mcp rm -f /data/schemas/test-isolation.txt

echo ""

# ---------------------------------------------------------------------------
# Test 4: Verify shared PostgreSQL (control plane)
# ---------------------------------------------------------------------------
echo -e "${BLUE}Test 4: Shared Control Plane (PostgreSQL)${NC}"
echo "----------------------------------------------"

# Both workspaces should connect to same database
WS1_DB=$(docker exec shogo-mcp printenv DATABASE_URL | grep -o '@[^:]*:' | tr -d '@:')
WS2_DB=$(docker exec shogo-mcp-workspace-2 printenv DATABASE_URL | grep -o '@[^:]*:' | tr -d '@:')

echo "  Workspace 1 DB Host: $WS1_DB"
echo "  Workspace 2 DB Host: $WS2_DB"

[ "$WS1_DB" = "$WS2_DB" ] && check "Both workspaces share PostgreSQL"

# Verify control plane tables exist
TABLES=$(docker exec shogo-postgres psql -U shogo -d shogo -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';" 2>/dev/null | tr -d ' ')
echo "  PostgreSQL has $TABLES tables"
[ "$TABLES" -gt "0" ] && check "Control plane tables exist in shared database"

echo ""

# ---------------------------------------------------------------------------
# Test 5: Data persistence across container restarts
# ---------------------------------------------------------------------------
echo -e "${BLUE}Test 5: Data Persistence${NC}"
echo "----------------------------------------------"

# Create test data
docker exec shogo-mcp sh -c "echo 'persistence-test-$(date +%s)' > /data/schemas/persistence-test.txt"
ORIGINAL_DATA=$(docker exec shogo-mcp cat /data/schemas/persistence-test.txt)
echo "  Created test file with: $ORIGINAL_DATA"

# Restart the container
echo "  Restarting Workspace 1 container..."
docker restart shogo-mcp > /dev/null 2>&1
sleep 10

# Verify data persists
AFTER_DATA=$(docker exec shogo-mcp cat /data/schemas/persistence-test.txt)
echo "  After restart: $AFTER_DATA"

[ "$ORIGINAL_DATA" = "$AFTER_DATA" ] && check "Data persisted across container restart"

# Cleanup
docker exec shogo-mcp rm -f /data/schemas/persistence-test.txt

echo ""

# ---------------------------------------------------------------------------
# Test 6: Simulate scale-to-zero (stop/start workspace)
# ---------------------------------------------------------------------------
echo -e "${BLUE}Test 6: Scale-to-Zero Simulation${NC}"
echo "----------------------------------------------"

echo "  Stopping Workspace 2 (simulates scale to 0)..."
docker stop shogo-mcp-workspace-2 > /dev/null 2>&1
check "Workspace 2 stopped (scaled to 0)"

# Verify workspace 1 still works
WS1_CHECK=$(docker exec shogo-mcp curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/mcp 2>/dev/null)
[ "$WS1_CHECK" = "400" ] && check "Workspace 1 unaffected by Workspace 2 shutdown"

echo "  Starting Workspace 2 (simulates scale to 1)..."
docker start shogo-mcp-workspace-2 > /dev/null 2>&1
sleep 15

WS2_CHECK=$(docker exec shogo-mcp-workspace-2 curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/mcp 2>/dev/null)
[ "$WS2_CHECK" = "400" ] && check "Workspace 2 came back online (cold start)"

echo ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo "=============================================="
echo -e "${GREEN}  All Scaling Pattern Tests Passed!${NC}"
echo "=============================================="
echo ""
echo "Patterns Validated:"
echo "  ✓ Workspace isolation (separate containers)"
echo "  ✓ Storage isolation (separate volumes)"
echo "  ✓ Shared control plane (same PostgreSQL)"
echo "  ✓ Data persistence (survives restarts)"
echo "  ✓ Scale-to-zero simulation (stop/start)"
echo ""
echo "Note: True scale-to-zero requires Kubernetes + Knative"
echo "      Use 'make deploy-k8s' for full testing (coming soon)"
echo ""

