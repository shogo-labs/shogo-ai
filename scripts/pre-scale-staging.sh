#!/bin/bash
# =============================================================================
# Pre-scale staging EKS nodes for dry runs / load tests
# =============================================================================
# Usage:
#   ./scripts/pre-scale-staging.sh up      # Scale to 4 nodes before dry run
#   ./scripts/pre-scale-staging.sh down    # Scale back to 2 nodes after
#   ./scripts/pre-scale-staging.sh status  # Show current node count + pod capacity
# =============================================================================

set -euo pipefail

CLUSTER_NAME="shogo-staging"
NODE_GROUP="shogo-staging-main"
REGION="us-east-1"
PROFILE="shogo"

NORMAL_SIZE=2
SCALED_SIZE=4

ACTION="${1:-status}"

case "$ACTION" in
  up)
    echo "Scaling $CLUSTER_NAME node group to $SCALED_SIZE nodes..."
    aws eks update-nodegroup-config \
      --cluster-name "$CLUSTER_NAME" \
      --nodegroup-name "$NODE_GROUP" \
      --scaling-config "desiredSize=$SCALED_SIZE,minSize=$NORMAL_SIZE,maxSize=5" \
      --profile "$PROFILE" \
      --region "$REGION" \
      --output text --query 'update.id'

    echo ""
    echo "Scaling initiated. Nodes will be ready in ~2-3 minutes."
    echo "Monitor with: kubectl get nodes -w"
    echo ""
    echo "Once nodes are ready, restart the API to replenish the warm pool:"
    echo "  kubectl rollout restart deployment -n shogo-staging-system -l serving.knative.dev/service=api"
    ;;

  down)
    echo "Scaling $CLUSTER_NAME node group back to $NORMAL_SIZE nodes..."
    aws eks update-nodegroup-config \
      --cluster-name "$CLUSTER_NAME" \
      --nodegroup-name "$NODE_GROUP" \
      --scaling-config "desiredSize=$NORMAL_SIZE,minSize=$NORMAL_SIZE,maxSize=5" \
      --profile "$PROFILE" \
      --region "$REGION" \
      --output text --query 'update.id'

    echo ""
    echo "Scale-down initiated. Excess nodes will drain over ~5-10 minutes."
    ;;

  status)
    echo "=== Nodes ==="
    kubectl get nodes -o custom-columns="NAME:.metadata.name,TYPE:.metadata.labels.node\.kubernetes\.io/instance-type,STATUS:.status.conditions[-1].type,CPU:.status.capacity.cpu,MEM:.status.capacity.memory"
    echo ""

    echo "=== Node Resource Usage ==="
    kubectl top nodes 2>/dev/null || echo "(metrics-server not available)"
    echo ""

    echo "=== Warm Pool Status ==="
    kubectl get pods -n shogo-staging-workspaces --no-headers 2>/dev/null | grep "warm-pool" | awk '{print $1, $2, $3}' | column -t
    echo ""

    PROJ_READY=$(kubectl get pods -n shogo-staging-workspaces --no-headers 2>/dev/null | grep "warm-pool-project" | grep "2/2.*Running" | wc -l | tr -d ' ')
    AGENT_READY=$(kubectl get pods -n shogo-staging-workspaces --no-headers 2>/dev/null | grep "warm-pool-agent" | grep "2/2.*Running" | wc -l | tr -d ' ')
    echo "Ready warm pods: ${PROJ_READY} project, ${AGENT_READY} agent"
    echo ""

    NODE_COUNT=$(kubectl get nodes --no-headers 2>/dev/null | wc -l | tr -d ' ')
    echo "Capacity estimate: ~$((NODE_COUNT * 8)) warm pods at 100m CPU request each"
    ;;

  *)
    echo "Usage: $0 {up|down|status}"
    exit 1
    ;;
esac
