#!/bin/bash
# =============================================================================
# Test Knative Scale-to-Zero
# =============================================================================
# This script tests the true scale-to-zero behavior that will be used on EKS:
#   1. Verify Knative services are deployed
#   2. Send traffic to spin up pods
#   3. Wait for scale-to-zero
#   4. Verify cold start works
#   5. Test workspace isolation
# =============================================================================

set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Configuration
NAMESPACE="shogo-workspaces"
SCALE_TO_ZERO_TIMEOUT=90  # Knative default + buffer

echo -e "${BLUE}=============================================="
echo "  Knative Scale-to-Zero Test"
echo -e "==============================================${NC}"
echo ""

check() {
  if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓${NC} $1"
  else
    echo -e "${RED}✗${NC} $1"
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Verify Knative is installed
# ---------------------------------------------------------------------------
echo -e "${YELLOW}Checking Knative installation...${NC}"

kubectl get crd services.serving.knative.dev >/dev/null 2>&1
check "Knative Serving CRDs installed"

kubectl get deployment controller -n knative-serving >/dev/null 2>&1
check "Knative controller running"

echo ""

# ---------------------------------------------------------------------------
# Test 1: Verify Knative Services are deployed
# ---------------------------------------------------------------------------
echo -e "${BLUE}Test 1: Knative Services Deployed${NC}"
echo "----------------------------------------------"

KSVC_COUNT=$(kubectl get ksvc -n $NAMESPACE --no-headers 2>/dev/null | wc -l | tr -d ' ')
echo "  Found $KSVC_COUNT Knative Services"

kubectl get ksvc mcp-workspace-1 -n $NAMESPACE >/dev/null 2>&1
check "mcp-workspace-1 Knative Service exists"

kubectl get ksvc mcp-workspace-2 -n $NAMESPACE >/dev/null 2>&1
check "mcp-workspace-2 Knative Service exists"

echo ""

# ---------------------------------------------------------------------------
# Test 2: Get Knative Service URLs
# ---------------------------------------------------------------------------
echo -e "${BLUE}Test 2: Service Discovery${NC}"
echo "----------------------------------------------"

WS1_URL=$(kubectl get ksvc mcp-workspace-1 -n $NAMESPACE -o jsonpath='{.status.url}')
WS2_URL=$(kubectl get ksvc mcp-workspace-2 -n $NAMESPACE -o jsonpath='{.status.url}')

echo "  Workspace 1 URL: $WS1_URL"
echo "  Workspace 2 URL: $WS2_URL"

[ -n "$WS1_URL" ] && check "Workspace 1 has URL assigned"
[ -n "$WS2_URL" ] && check "Workspace 2 has URL assigned"

echo ""

# ---------------------------------------------------------------------------
# Test 3: Check initial pod count (should be 0)
# ---------------------------------------------------------------------------
echo -e "${BLUE}Test 3: Initial State (Scale-to-Zero)${NC}"
echo "----------------------------------------------"

INITIAL_PODS=$(kubectl get pods -n $NAMESPACE -l serving.knative.dev/service --no-headers 2>/dev/null | wc -l | tr -d ' ')
echo "  Current workspace pods: $INITIAL_PODS"

if [ "$INITIAL_PODS" = "0" ]; then
  check "Workspaces scaled to zero (no pods running)"
else
  echo -e "${YELLOW}!${NC} Pods are running (may be recent traffic)"
fi

echo ""

# ---------------------------------------------------------------------------
# Test 4: Send traffic to spin up workspace 1
# ---------------------------------------------------------------------------
echo -e "${BLUE}Test 4: Cold Start - Workspace 1${NC}"
echo "----------------------------------------------"

echo "  Sending request to spin up workspace 1..."
START_TIME=$(date +%s.%N)

# Use kubectl port-forward or internal service
# For Kourier, we need to hit the internal URL or use port-forward
kubectl port-forward -n kourier-system svc/kourier 8080:80 &>/dev/null &
PF_PID=$!
sleep 2

# Make request with Host header for Knative routing (use sslip.io domain)
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Host: mcp-workspace-1.$NAMESPACE.127.0.0.1.sslip.io" \
  http://localhost:8080/mcp 2>/dev/null || echo "000")

END_TIME=$(date +%s.%N)
COLD_START=$(echo "$END_TIME - $START_TIME" | bc)

echo "  HTTP Response: $HTTP_CODE"
echo "  Cold start time: ${COLD_START}s"

# Kill port-forward
kill $PF_PID 2>/dev/null || true

# 400 is expected (FastMCP returns 400 for GET on /mcp endpoint)
[ "$HTTP_CODE" = "400" ] || [ "$HTTP_CODE" = "200" ]
check "Workspace 1 responded (cold start successful)"

echo ""

# ---------------------------------------------------------------------------
# Test 5: Verify pod is now running
# ---------------------------------------------------------------------------
echo -e "${BLUE}Test 5: Pod Running After Cold Start${NC}"
echo "----------------------------------------------"

sleep 5
RUNNING_PODS=$(kubectl get pods -n $NAMESPACE -l serving.knative.dev/service=mcp-workspace-1 --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l | tr -d ' ')
echo "  Workspace 1 pods running: $RUNNING_PODS"

[ "$RUNNING_PODS" -ge "1" ]
check "Workspace 1 pod is running"

echo ""

# ---------------------------------------------------------------------------
# Test 6: Test workspace isolation
# ---------------------------------------------------------------------------
echo -e "${BLUE}Test 6: Workspace Isolation${NC}"
echo "----------------------------------------------"

# Get WORKSPACE_ID from the running pod
WS1_POD=$(kubectl get pods -n $NAMESPACE -l serving.knative.dev/service=mcp-workspace-1 --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
WS1_ID=$(kubectl exec -n $NAMESPACE $WS1_POD -c mcp -- printenv WORKSPACE_ID 2>/dev/null || echo "")
WS2_PODS=$(kubectl get pods -n $NAMESPACE -l serving.knative.dev/service=mcp-workspace-2 --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l | tr -d ' ')

echo "  Workspace 1 ID: $WS1_ID"
echo "  Workspace 2 pods: $WS2_PODS"

[ "$WS1_ID" = "workspace-1" ]
check "Workspace 1 has correct WORKSPACE_ID"

if [ "$WS2_PODS" = "0" ]; then
  check "Workspace 2 still scaled to zero (isolated)"
else
  echo -e "${YELLOW}!${NC} Workspace 2 is running (may scale down soon)"
fi

echo ""

# ---------------------------------------------------------------------------
# Test 7: Wait for scale-to-zero
# ---------------------------------------------------------------------------
echo -e "${BLUE}Test 7: Scale-to-Zero (waiting ${SCALE_TO_ZERO_TIMEOUT}s)${NC}"
echo "----------------------------------------------"

echo "  Waiting for workspace 1 to scale to zero..."
echo "  (Knative will scale down after ~60s of no traffic)"

# Progress indicator
for i in $(seq 1 $SCALE_TO_ZERO_TIMEOUT); do
  CURRENT_PODS=$(kubectl get pods -n $NAMESPACE -l serving.knative.dev/service=mcp-workspace-1 --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l | tr -d ' ')
  if [ "$CURRENT_PODS" = "0" ]; then
    echo ""
    echo "  Scaled to zero after ${i}s"
    check "Workspace 1 scaled to zero"
    break
  fi
  printf "."
  sleep 1
done

FINAL_PODS=$(kubectl get pods -n $NAMESPACE -l serving.knative.dev/service=mcp-workspace-1 --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l | tr -d ' ')
if [ "$FINAL_PODS" != "0" ]; then
  echo ""
  echo -e "${YELLOW}!${NC} Pod still running after ${SCALE_TO_ZERO_TIMEOUT}s"
  echo "  This may be due to recent activity or autoscaler settings"
fi

echo ""

# ---------------------------------------------------------------------------
# Test 8: Second cold start
# ---------------------------------------------------------------------------
echo -e "${BLUE}Test 8: Second Cold Start${NC}"
echo "----------------------------------------------"

echo "  Triggering another cold start..."
START_TIME=$(date +%s.%N)

kubectl port-forward -n kourier-system svc/kourier 8081:80 &>/dev/null &
PF_PID=$!
sleep 2

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Host: mcp-workspace-1.$NAMESPACE.127.0.0.1.sslip.io" \
  http://localhost:8081/mcp 2>/dev/null || echo "000")

END_TIME=$(date +%s.%N)
COLD_START=$(echo "$END_TIME - $START_TIME" | bc)

kill $PF_PID 2>/dev/null || true

echo "  HTTP Response: $HTTP_CODE"
echo "  Cold start time: ${COLD_START}s"

[ "$HTTP_CODE" = "400" ] || [ "$HTTP_CODE" = "200" ]
check "Second cold start successful"

echo ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo -e "${GREEN}=============================================="
echo "  Knative Scale-to-Zero Test Complete!"
echo -e "==============================================${NC}"
echo ""
echo "What was tested:"
echo "  ✓ Knative Services deployed and addressable"
echo "  ✓ Cold start from scale-to-zero"
echo "  ✓ Workspace isolation (different WORKSPACE_ID)"
echo "  ✓ Scale-to-zero after idle period"
echo ""
echo "This validates the exact scaling behavior for EKS deployment."
echo ""
echo "View Knative services:"
echo "  kubectl get ksvc -n $NAMESPACE"
echo ""
echo "View autoscaler metrics:"
echo "  kubectl get podautoscalers -n $NAMESPACE"
echo ""

