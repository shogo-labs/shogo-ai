#!/bin/bash
# =============================================================================
# Setup Local Kubernetes with Knative (mirrors EKS deployment)
# =============================================================================
# Prerequisites:
#   - Docker Desktop running
#   - k3d installed: brew install k3d
#   - kubectl installed: brew install kubectl
#   - helm installed: brew install helm
# =============================================================================

set -e

CLUSTER_NAME="shogo-dev"
REGISTRY_NAME="shogo-registry"
REGISTRY_PORT=5050

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}=============================================="
echo "  Shogo AI - Local Kubernetes Setup"
echo -e "==============================================${NC}"
echo ""

# ---------------------------------------------------------------------------
# Check prerequisites
# ---------------------------------------------------------------------------
echo -e "${YELLOW}Checking prerequisites...${NC}"

command -v docker >/dev/null 2>&1 || { echo "❌ Docker is required. Install Docker Desktop."; exit 1; }
command -v k3d >/dev/null 2>&1 || { echo "❌ k3d is required. Run: brew install k3d"; exit 1; }
command -v kubectl >/dev/null 2>&1 || { echo "❌ kubectl is required. Run: brew install kubectl"; exit 1; }
command -v helm >/dev/null 2>&1 || { echo "❌ helm is required. Run: brew install helm"; exit 1; }

echo -e "${GREEN}✓${NC} All prerequisites installed"
echo ""

# ---------------------------------------------------------------------------
# Create local registry (for pushing images)
# ---------------------------------------------------------------------------
echo -e "${YELLOW}Setting up local registry...${NC}"

if k3d registry list | grep -q "$REGISTRY_NAME"; then
  echo -e "${GREEN}✓${NC} Registry $REGISTRY_NAME already exists"
else
  k3d registry create $REGISTRY_NAME --port $REGISTRY_PORT
  echo -e "${GREEN}✓${NC} Created registry $REGISTRY_NAME on port $REGISTRY_PORT"
fi

# ---------------------------------------------------------------------------
# Create k3d cluster
# ---------------------------------------------------------------------------
echo -e "${YELLOW}Creating k3d cluster...${NC}"

if k3d cluster list | grep -q "$CLUSTER_NAME"; then
  echo -e "${GREEN}✓${NC} Cluster $CLUSTER_NAME already exists"
else
  k3d cluster create $CLUSTER_NAME \
    --registry-use k3d-$REGISTRY_NAME:$REGISTRY_PORT \
    --port "80:80@loadbalancer" \
    --port "443:443@loadbalancer" \
    --agents 2 \
    --k3s-arg "--disable=traefik@server:0"
  echo -e "${GREEN}✓${NC} Created cluster $CLUSTER_NAME"
fi

# Set kubectl context
kubectl config use-context k3d-$CLUSTER_NAME

echo ""

# ---------------------------------------------------------------------------
# Install Knative Serving
# ---------------------------------------------------------------------------
echo -e "${YELLOW}Installing Knative Serving...${NC}"

KNATIVE_VERSION="1.12.0"

# Install Knative Serving CRDs
if kubectl get crd services.serving.knative.dev >/dev/null 2>&1; then
  echo -e "${GREEN}✓${NC} Knative CRDs already installed"
else
  kubectl apply -f https://github.com/knative/serving/releases/download/knative-v${KNATIVE_VERSION}/serving-crds.yaml
  echo -e "${GREEN}✓${NC} Installed Knative CRDs"
fi

# Install Knative Serving core
if kubectl get deployment controller -n knative-serving >/dev/null 2>&1; then
  echo -e "${GREEN}✓${NC} Knative Serving core already installed"
else
  kubectl apply -f https://github.com/knative/serving/releases/download/knative-v${KNATIVE_VERSION}/serving-core.yaml
  echo -e "${GREEN}✓${NC} Installed Knative Serving core"
fi

# Install Kourier (lightweight ingress for Knative)
if kubectl get deployment 3scale-kourier-gateway -n kourier-system >/dev/null 2>&1; then
  echo -e "${GREEN}✓${NC} Kourier already installed"
else
  kubectl apply -f https://github.com/knative/net-kourier/releases/download/knative-v${KNATIVE_VERSION}/kourier.yaml
  echo -e "${GREEN}✓${NC} Installed Kourier ingress"
fi

# Configure Knative to use Kourier
kubectl patch configmap/config-network \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"ingress-class":"kourier.ingress.networking.knative.dev"}}'

# Configure Knative domain (use .local for local dev)
kubectl patch configmap/config-domain \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"127.0.0.1.sslip.io":""}}'

# Enable scale-to-zero
kubectl patch configmap/config-autoscaler \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"enable-scale-to-zero":"true","scale-to-zero-grace-period":"30s","scale-to-zero-pod-retention-period":"0s"}}'

echo ""

# ---------------------------------------------------------------------------
# Wait for Knative to be ready
# ---------------------------------------------------------------------------
echo -e "${YELLOW}Waiting for Knative to be ready...${NC}"

kubectl wait --for=condition=Available deployment/controller -n knative-serving --timeout=120s
kubectl wait --for=condition=Available deployment/webhook -n knative-serving --timeout=120s
kubectl wait --for=condition=Available deployment/3scale-kourier-gateway -n kourier-system --timeout=120s

echo -e "${GREEN}✓${NC} Knative Serving is ready"
echo ""

# ---------------------------------------------------------------------------
# Create Shogo namespaces
# ---------------------------------------------------------------------------
echo -e "${YELLOW}Creating Shogo namespaces...${NC}"

kubectl apply -f - <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: shogo-system
  labels:
    app.kubernetes.io/part-of: shogo
---
apiVersion: v1
kind: Namespace
metadata:
  name: shogo-workspaces
  labels:
    app.kubernetes.io/part-of: shogo
    # Enable Knative in this namespace
    knative-eventing-injection: enabled
EOF

echo -e "${GREEN}✓${NC} Created namespaces"
echo ""

# ---------------------------------------------------------------------------
# Build and push images to local registry
# ---------------------------------------------------------------------------
echo -e "${YELLOW}Building and pushing images...${NC}"

cd /Users/russell/git/shogo-ai

# Build MCP image
docker build -t localhost:$REGISTRY_PORT/shogo-mcp:latest -f packages/mcp/Dockerfile .
docker push localhost:$REGISTRY_PORT/shogo-mcp:latest
echo -e "${GREEN}✓${NC} Built and pushed shogo-mcp"

# Build API image
docker build -t localhost:$REGISTRY_PORT/shogo-api:latest -f apps/api/Dockerfile .
docker push localhost:$REGISTRY_PORT/shogo-api:latest
echo -e "${GREEN}✓${NC} Built and pushed shogo-api"

# Build Web image
docker build -t localhost:$REGISTRY_PORT/shogo-web:latest -f apps/web/Dockerfile \
  --build-arg VITE_API_URL=http://localhost:8002 \
  --build-arg VITE_MCP_URL=http://localhost:3100 \
  --build-arg VITE_BETTER_AUTH_URL=http://localhost:8002 \
  --build-arg VITE_WORKSPACE=default .
docker push localhost:$REGISTRY_PORT/shogo-web:latest
echo -e "${GREEN}✓${NC} Built and pushed shogo-web"

echo ""

# ---------------------------------------------------------------------------
# Deploy base infrastructure
# ---------------------------------------------------------------------------
echo -e "${YELLOW}Deploying base infrastructure...${NC}"

# Apply base resources individually (not using kustomize for simplicity)
kubectl apply -f k8s/base/postgres.yaml
kubectl apply -f k8s/base/redis.yaml
kubectl apply -f k8s/base/api.yaml
kubectl apply -f k8s/base/web.yaml
kubectl apply -f k8s/base/ingress.yaml 2>/dev/null || true

echo -e "${GREEN}✓${NC} Deployed base infrastructure"
echo ""

# ---------------------------------------------------------------------------
# Deploy Knative workspaces
# ---------------------------------------------------------------------------
echo -e "${YELLOW}Deploying Knative workspace services...${NC}"

kubectl apply -f k8s/knative/namespace.yaml
kubectl apply -f k8s/knative/secrets.yaml
kubectl apply -f k8s/knative/workspace-template.yaml

echo -e "${GREEN}✓${NC} Deployed Knative services"
echo ""

# ---------------------------------------------------------------------------
# Wait for pods to be ready
# ---------------------------------------------------------------------------
echo -e "${YELLOW}Waiting for pods to be ready...${NC}"

kubectl wait --for=condition=Ready pod -l app=postgres -n shogo-system --timeout=120s 2>/dev/null || true
kubectl wait --for=condition=Ready pod -l app=redis -n shogo-system --timeout=60s 2>/dev/null || true
kubectl wait --for=condition=Ready pod -l app=shogo-api -n shogo-system --timeout=120s 2>/dev/null || true

echo ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo -e "${GREEN}=============================================="
echo "  Local Kubernetes Setup Complete!"
echo -e "==============================================${NC}"
echo ""
echo "Cluster: k3d-$CLUSTER_NAME"
echo "Registry: localhost:$REGISTRY_PORT"
echo ""
echo "Services:"
echo "  - Web:      http://localhost (via Kourier)"
echo "  - API:      http://localhost:8002"
echo "  - MCP:      Knative Services in shogo-workspaces namespace"
echo ""
echo "Useful commands:"
echo "  kubectl get pods -n shogo-system"
echo "  kubectl get ksvc -n shogo-workspaces"
echo "  kubectl get pods -n shogo-workspaces"
echo ""
echo "Test scale-to-zero:"
echo "  ./scripts/test-knative-scaling.sh"
echo ""

