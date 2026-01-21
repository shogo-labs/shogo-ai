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
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
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
# Install nginx-ingress controller (simpler than Knative for local dev)
# ---------------------------------------------------------------------------
echo -e "${YELLOW}Installing nginx-ingress controller...${NC}"

if kubectl get deployment ingress-nginx-controller -n ingress-nginx >/dev/null 2>&1; then
  echo -e "${GREEN}✓${NC} nginx-ingress already installed"
else
  kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.8.2/deploy/static/provider/cloud/deploy.yaml
  echo -e "${GREEN}✓${NC} Installed nginx-ingress controller"
fi

# Wait for ingress controller
echo -e "${YELLOW}Waiting for ingress controller...${NC}"
kubectl wait --namespace ingress-nginx \
  --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller \
  --timeout=120s 2>/dev/null || echo "Ingress controller may take longer to start"

echo ""

# ---------------------------------------------------------------------------
# Create Shogo namespace
# ---------------------------------------------------------------------------
echo -e "${YELLOW}Creating Shogo namespace...${NC}"

kubectl apply -f - <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: shogo-system
  labels:
    app.kubernetes.io/part-of: shogo
EOF

echo -e "${GREEN}✓${NC} Created namespace"
echo ""

# ---------------------------------------------------------------------------
# Pre-pull required images to local Docker
# ---------------------------------------------------------------------------
echo -e "${YELLOW}Pre-pulling required images...${NC}"

# Pull images if not present
docker pull postgres:16-alpine 2>/dev/null || true
docker pull redis:7-alpine 2>/dev/null || true
docker pull minio/minio:latest 2>/dev/null || true
docker pull minio/mc:latest 2>/dev/null || true

# Import images into k3d
k3d image import postgres:16-alpine redis:7-alpine minio/minio:latest minio/mc:latest -c $CLUSTER_NAME 2>/dev/null || true

echo -e "${GREEN}✓${NC} Images pre-pulled"
echo ""

# ---------------------------------------------------------------------------
# Build and push Shogo images to local registry
# ---------------------------------------------------------------------------
echo -e "${YELLOW}Building and pushing Shogo images...${NC}"

cd "$PROJECT_ROOT"

# Build MCP image
echo "Building shogo-mcp..."
docker build -t localhost:$REGISTRY_PORT/shogo-mcp:latest -f packages/mcp/Dockerfile .
docker push localhost:$REGISTRY_PORT/shogo-mcp:latest
echo -e "${GREEN}✓${NC} Built and pushed shogo-mcp"

# Build API image
echo "Building shogo-api..."
docker build -t localhost:$REGISTRY_PORT/shogo-api:latest -f apps/api/Dockerfile .
docker push localhost:$REGISTRY_PORT/shogo-api:latest
echo -e "${GREEN}✓${NC} Built and pushed shogo-api"

# Build Web image with correct build args
# IMPORTANT: VITE_WORKSPACE=workspace must match S3 schema path
echo "Building shogo-web..."
docker build -t localhost:$REGISTRY_PORT/shogo-web:latest -f apps/web/Dockerfile \
  --build-arg VITE_API_URL=http://localhost:8002 \
  --build-arg VITE_MCP_URL=http://localhost:3100 \
  --build-arg VITE_BETTER_AUTH_URL=http://localhost:8002 \
  --build-arg VITE_WORKSPACE=workspace \
  .
docker push localhost:$REGISTRY_PORT/shogo-web:latest
echo -e "${GREEN}✓${NC} Built and pushed shogo-web"

echo ""

# ---------------------------------------------------------------------------
# Deploy base infrastructure
# ---------------------------------------------------------------------------
echo -e "${YELLOW}Deploying base infrastructure...${NC}"

# Update image references to use local registry
sed "s|k3d-shogo-registry:5000|localhost:$REGISTRY_PORT|g" k8s/base/api.yaml > /tmp/api.yaml
sed "s|k3d-shogo-registry:5000|localhost:$REGISTRY_PORT|g" k8s/base/web.yaml > /tmp/web.yaml
sed "s|ghcr.io/shogo-ai/shogo-mcp|localhost:$REGISTRY_PORT/shogo-mcp|g" k8s/base/platform-mcp.yaml > /tmp/platform-mcp.yaml

# Apply base resources
kubectl apply -f k8s/base/postgres.yaml
kubectl apply -f k8s/base/redis.yaml
kubectl apply -f k8s/base/minio.yaml
kubectl apply -f k8s/base/shogo-config.yaml
kubectl apply -f /tmp/platform-mcp.yaml
kubectl apply -f /tmp/api.yaml
kubectl apply -f /tmp/web.yaml

echo -e "${GREEN}✓${NC} Deployed base infrastructure"
echo ""

# ---------------------------------------------------------------------------
# Wait for infrastructure pods to be ready
# ---------------------------------------------------------------------------
echo -e "${YELLOW}Waiting for infrastructure pods...${NC}"

kubectl wait --for=condition=Ready pod -l app=postgres -n shogo-system --timeout=120s
kubectl wait --for=condition=Ready pod -l app=redis -n shogo-system --timeout=60s
kubectl wait --for=condition=Ready pod -l app=minio -n shogo-system --timeout=60s

echo -e "${GREEN}✓${NC} Infrastructure pods ready"
echo ""

# ---------------------------------------------------------------------------
# Initialize MinIO buckets and sync schemas
# ---------------------------------------------------------------------------
echo -e "${YELLOW}Initializing MinIO...${NC}"

# Create bucket initialization job
kubectl apply -f - <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: minio-init
  namespace: shogo-system
spec:
  ttlSecondsAfterFinished: 60
  template:
    spec:
      containers:
        - name: mc
          image: minio/mc:latest
          imagePullPolicy: IfNotPresent
          command:
            - /bin/sh
            - -c
            - |
              set -e
              mc alias set minio http://minio:9000 minioadmin minioadmin --api S3v4
              mc mb minio/shogo-schemas --ignore-existing
              mc mb minio/shogo-workspaces --ignore-existing
              echo "MinIO buckets created"
      restartPolicy: Never
  backoffLimit: 3
EOF

# Wait for job completion
kubectl wait --for=condition=complete job/minio-init -n shogo-system --timeout=60s
kubectl logs job/minio-init -n shogo-system

# Check if schemas exist locally (from docker-compose)
if docker ps | grep -q "shogo-minio"; then
  echo -e "${YELLOW}Syncing schemas from local Docker MinIO...${NC}"
  
  # Connect Docker MinIO to k3d network
  docker network connect k3d-$CLUSTER_NAME shogo-minio 2>/dev/null || true
  
  # Get Docker MinIO IP on k3d network
  DOCKER_MINIO_IP=$(docker inspect shogo-minio -f '{{range $k, $v := .NetworkSettings.Networks}}{{if eq $k "k3d-'$CLUSTER_NAME'"}}{{$v.IPAddress}}{{end}}{{end}}')
  
  if [ -n "$DOCKER_MINIO_IP" ]; then
    # Create schema sync job
    kubectl apply -f - <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: schema-sync
  namespace: shogo-system
spec:
  ttlSecondsAfterFinished: 60
  template:
    spec:
      containers:
        - name: mc
          image: minio/mc:latest
          imagePullPolicy: IfNotPresent
          command:
            - /bin/sh
            - -c
            - |
              set -e
              mc alias set source http://${DOCKER_MINIO_IP}:9000 minioadmin minioadmin --api S3v4
              mc alias set dest http://minio:9000 minioadmin minioadmin --api S3v4
              echo "Syncing schemas..."
              mc mirror --overwrite source/shogo-schemas dest/shogo-schemas || echo "No schemas to sync"
              mc mirror --overwrite source/shogo-workspaces dest/shogo-workspaces || echo "No workspaces to sync"
              echo "Schema sync complete"
      restartPolicy: Never
  backoffLimit: 3
EOF
    kubectl wait --for=condition=complete job/schema-sync -n shogo-system --timeout=120s
    echo -e "${GREEN}✓${NC} Schemas synced from Docker MinIO"
  else
    echo -e "${YELLOW}⚠${NC} Could not connect to Docker MinIO - schemas not synced"
  fi
else
  echo -e "${YELLOW}⚠${NC} Docker MinIO not running - schemas need to be uploaded manually"
fi

echo ""

# ---------------------------------------------------------------------------
# Wait for application pods to be ready
# ---------------------------------------------------------------------------
echo -e "${YELLOW}Waiting for application pods...${NC}"

kubectl wait --for=condition=Ready pod -l app.kubernetes.io/name=platform-mcp -n shogo-system --timeout=120s
kubectl wait --for=condition=Ready pod -l app=shogo-api -n shogo-system --timeout=120s
kubectl wait --for=condition=Ready pod -l app=shogo-web -n shogo-system --timeout=120s

echo -e "${GREEN}✓${NC} Application pods ready"
echo ""

# ---------------------------------------------------------------------------
# Check MCP logs for schema initialization
# ---------------------------------------------------------------------------
echo -e "${YELLOW}Checking MCP schema initialization...${NC}"
kubectl logs deployment/platform-mcp -n shogo-system --tail=20 | grep -E "created|loaded|error" || true
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
echo "Services (via port-forward):"
echo "  kubectl -n shogo-system port-forward svc/shogo-web 3000:80 &"
echo "  kubectl -n shogo-system port-forward svc/shogo-api 8002:8002 &"
echo "  kubectl -n shogo-system port-forward svc/platform-mcp 3100:3100 &"
echo ""
echo "Then access:"
echo "  - Web:      http://localhost:3000"
echo "  - API:      http://localhost:8002"
echo "  - MCP:      http://localhost:3100"
echo ""
echo "Set your Anthropic API key:"
echo "  kubectl -n shogo-system patch secret api-secrets -p '{\"stringData\":{\"ANTHROPIC_API_KEY\":\"sk-ant-...\"}}"
echo "  kubectl -n shogo-system rollout restart deployment/shogo-api"
echo ""
echo "Useful commands:"
echo "  kubectl get pods -n shogo-system"
echo "  kubectl logs deployment/platform-mcp -n shogo-system"
echo "  kubectl logs deployment/shogo-api -n shogo-system"
echo ""
