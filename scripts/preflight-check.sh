#!/bin/bash
# =============================================================================
# Pre-dry-run preflight checklist
# =============================================================================
# Run this before a planned dry run to verify the staging cluster is healthy
# and ready for concurrent users.
#
# Usage:
#   ./scripts/preflight-check.sh
#
# Exit codes:
#   0 = all checks passed
#   1 = one or more checks failed (see output for details)
# =============================================================================

set -euo pipefail

NAMESPACE_SYSTEM="shogo-staging-system"
NAMESPACE_WORKSPACES="shogo-staging-workspaces"
PASS=0
FAIL=0
WARN=0

pass() { echo "  ✅ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL + 1)); }
warn() { echo "  ⚠️  $1"; WARN=$((WARN + 1)); }

echo "============================================================"
echo "  SHOGO STAGING — Pre-Dry-Run Preflight Check"
echo "  $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "============================================================"
echo ""

# ── 1. Cluster connectivity ──────────────────────────────────────
echo "1. Cluster connectivity"
if kubectl cluster-info --request-timeout=5s &>/dev/null; then
  pass "kubectl connected to cluster"
else
  fail "Cannot connect to cluster"
  echo ""; echo "RESULT: ABORT — fix cluster connectivity first"; exit 1
fi

# ── 2. Node health ──────────────────────────────────────────────
echo ""
echo "2. Node health"
NODE_COUNT=$(kubectl get nodes --no-headers 2>/dev/null | wc -l | tr -d ' ')
READY_NODES=$(kubectl get nodes --no-headers 2>/dev/null | grep ' Ready' | wc -l | tr -d ' ')
if [ "$NODE_COUNT" -ge 2 ] && [ "$NODE_COUNT" -eq "$READY_NODES" ]; then
  pass "$READY_NODES/$NODE_COUNT nodes Ready"
else
  fail "Only $READY_NODES/$NODE_COUNT nodes Ready"
fi

if [ "$NODE_COUNT" -ge 3 ]; then
  pass "Node count ($NODE_COUNT) sufficient for dry run"
else
  warn "Only $NODE_COUNT nodes — consider running: ./scripts/pre-scale-staging.sh up"
fi

# ── 3. Core services ────────────────────────────────────────────
echo ""
echo "3. Core services"
for SVC in api studio; do
  STATUS=$(kubectl get ksvc "$SVC" -n "$NAMESPACE_SYSTEM" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "NotFound")
  if [ "$STATUS" = "True" ]; then
    pass "$SVC Knative service Ready"
  else
    fail "$SVC Knative service NOT ready (status=$STATUS)"
  fi
done

MCP_STATUS=$(kubectl get ksvc mcp-workspace-1 -n "$NAMESPACE_WORKSPACES" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "NotFound")
if [ "$MCP_STATUS" = "True" ]; then
  pass "mcp-workspace-1 Ready"
else
  fail "mcp-workspace-1 NOT ready (status=$MCP_STATUS)"
fi

# ── 4. Warm pool status ─────────────────────────────────────────
echo ""
echo "4. Warm pool"
PROJ_TOTAL=$(kubectl get pods -n "$NAMESPACE_WORKSPACES" --no-headers 2>/dev/null | grep "warm-pool-project" | wc -l | tr -d ' ')
PROJ_READY=$(kubectl get pods -n "$NAMESPACE_WORKSPACES" --no-headers 2>/dev/null | grep "warm-pool-project" | grep "2/2.*Running" | wc -l | tr -d ' ')
AGENT_TOTAL=$(kubectl get pods -n "$NAMESPACE_WORKSPACES" --no-headers 2>/dev/null | grep "warm-pool-agent" | wc -l | tr -d ' ')
AGENT_READY=$(kubectl get pods -n "$NAMESPACE_WORKSPACES" --no-headers 2>/dev/null | grep "warm-pool-agent" | grep "2/2.*Running" | wc -l | tr -d ' ')

if [ "$PROJ_READY" -ge 6 ]; then
  pass "Project warm pool: $PROJ_READY/$PROJ_TOTAL ready"
elif [ "$PROJ_READY" -ge 3 ]; then
  warn "Project warm pool: $PROJ_READY/$PROJ_TOTAL ready (low)"
else
  fail "Project warm pool: $PROJ_READY/$PROJ_TOTAL ready (critically low)"
fi

if [ "$AGENT_READY" -ge 6 ]; then
  pass "Agent warm pool: $AGENT_READY/$AGENT_TOTAL ready"
elif [ "$AGENT_READY" -ge 3 ]; then
  warn "Agent warm pool: $AGENT_READY/$AGENT_TOTAL ready (low)"
else
  fail "Agent warm pool: $AGENT_READY/$AGENT_TOTAL ready (critically low)"
fi

# ── 5. API health endpoint ──────────────────────────────────────
echo ""
echo "5. API health"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "https://studio-staging.shogo.ai/api/health" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  pass "API /api/health returned 200"
else
  fail "API /api/health returned $HTTP_CODE"
fi

# ── 6. Resource pressure ────────────────────────────────────────
echo ""
echo "6. Resource pressure"
if kubectl top nodes &>/dev/null; then
  HIGH_CPU=$(kubectl top nodes --no-headers 2>/dev/null | awk '{gsub(/%/,"",$3); if($3+0 > 80) print $1}')
  HIGH_MEM=$(kubectl top nodes --no-headers 2>/dev/null | awk '{gsub(/%/,"",$5); if($5+0 > 85) print $1}')
  if [ -z "$HIGH_CPU" ]; then
    pass "No nodes over 80% CPU"
  else
    warn "High CPU nodes: $HIGH_CPU"
  fi
  if [ -z "$HIGH_MEM" ]; then
    pass "No nodes over 85% memory"
  else
    warn "High memory nodes: $HIGH_MEM"
  fi
else
  warn "metrics-server not available (kubectl top failed)"
fi

# ── 7. Pending/crashlooping pods ────────────────────────────────
echo ""
echo "7. Pod health"
PENDING=$(kubectl get pods -n "$NAMESPACE_WORKSPACES" --no-headers 2>/dev/null | grep -c "Pending" || true)
CRASHLOOP=$(kubectl get pods -n "$NAMESPACE_WORKSPACES" --no-headers 2>/dev/null | grep -c "CrashLoopBackOff" || true)
ERRORED=$(kubectl get pods -n "$NAMESPACE_SYSTEM" --no-headers 2>/dev/null | grep -c "Error\|CrashLoopBackOff" || true)

if [ "$PENDING" -eq 0 ]; then
  pass "No pending pods in workspaces namespace"
else
  warn "$PENDING pending pods in workspaces namespace"
fi
if [ "$CRASHLOOP" -eq 0 ] && [ "$ERRORED" -eq 0 ]; then
  pass "No crash-looping pods"
else
  fail "$((CRASHLOOP + ERRORED)) crash-looping/errored pods"
fi

# ── Summary ─────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo "  RESULTS: $PASS passed, $FAIL failed, $WARN warnings"
echo "============================================================"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "  ❌ PREFLIGHT FAILED — resolve failures before dry run"
  echo ""
  exit 1
elif [ "$WARN" -gt 0 ]; then
  echo ""
  echo "  ⚠️  PREFLIGHT PASSED WITH WARNINGS — review above"
  echo ""
  exit 0
else
  echo ""
  echo "  ✅ ALL CHECKS PASSED — ready for dry run!"
  echo ""
  exit 0
fi
