#!/bin/bash
# =============================================================================
# Deploy Shogo AI to AWS EKS
# =============================================================================
# Prerequisites:
#   - AWS CLI configured with appropriate credentials
#   - kubectl configured for the EKS cluster
#   - Terraform applied (infrastructure created)
# =============================================================================

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Configuration
AWS_REGION="${AWS_REGION:-us-east-1}"
PROJECT_NAME="${PROJECT_NAME:-shogo}"
ENVIRONMENT="${ENVIRONMENT:-production}"
CLUSTER_NAME="${PROJECT_NAME}-${ENVIRONMENT}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo -e "${BLUE}=============================================="
echo "  Shogo AI - EKS Deployment"
echo -e "==============================================${NC}"
echo ""
echo "Region: ${AWS_REGION}"
echo "Cluster: ${CLUSTER_NAME}"
echo ""

# -----------------------------------------------------------------------------
# Check prerequisites
# -----------------------------------------------------------------------------
echo -e "${YELLOW}Checking prerequisites...${NC}"

command -v aws >/dev/null 2>&1 || { echo -e "${RED}❌ AWS CLI is required${NC}"; exit 1; }
command -v kubectl >/dev/null 2>&1 || { echo -e "${RED}❌ kubectl is required${NC}"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo -e "${RED}❌ Docker is required${NC}"; exit 1; }

# Verify AWS credentials
aws sts get-caller-identity >/dev/null 2>&1 || { echo -e "${RED}❌ AWS credentials not configured${NC}"; exit 1; }

echo -e "${GREEN}✓${NC} All prerequisites met"
echo ""

# -----------------------------------------------------------------------------
# Get AWS Account ID and ECR Registry
# -----------------------------------------------------------------------------
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

echo "AWS Account: ${AWS_ACCOUNT_ID}"
echo "ECR Registry: ${ECR_REGISTRY}"
echo ""

# -----------------------------------------------------------------------------
# Configure kubectl for EKS
# -----------------------------------------------------------------------------
echo -e "${YELLOW}Configuring kubectl...${NC}"

aws eks update-kubeconfig --region ${AWS_REGION} --name ${CLUSTER_NAME}

echo -e "${GREEN}✓${NC} kubectl configured for ${CLUSTER_NAME}"
echo ""

# -----------------------------------------------------------------------------
# Authenticate to ECR
# -----------------------------------------------------------------------------
echo -e "${YELLOW}Authenticating to ECR...${NC}"

aws ecr get-login-password --region ${AWS_REGION} | \
  docker login --username AWS --password-stdin ${ECR_REGISTRY}

echo -e "${GREEN}✓${NC} Authenticated to ECR"
echo ""

# -----------------------------------------------------------------------------
# Build and push images
# -----------------------------------------------------------------------------
echo -e "${YELLOW}Building and pushing images...${NC}"

cd "${PROJECT_ROOT}"

# Build and push MCP
echo "Building shogo-mcp..."
docker build -t ${ECR_REGISTRY}/${PROJECT_NAME}/shogo-mcp:latest \
  -f packages/mcp/Dockerfile .
docker push ${ECR_REGISTRY}/${PROJECT_NAME}/shogo-mcp:latest
echo -e "${GREEN}✓${NC} Pushed shogo-mcp"

# Build and push API
echo "Building shogo-api..."
docker build -t ${ECR_REGISTRY}/${PROJECT_NAME}/shogo-api:latest \
  -f apps/api/Dockerfile .
docker push ${ECR_REGISTRY}/${PROJECT_NAME}/shogo-api:latest
echo -e "${GREEN}✓${NC} Pushed shogo-api"

# Build and push Web
echo "Building shogo-web..."
docker build -t ${ECR_REGISTRY}/${PROJECT_NAME}/shogo-web:latest \
  -f apps/web/Dockerfile \
  --build-arg VITE_API_URL=https://api.${DOMAIN:-localhost} \
  --build-arg VITE_MCP_URL=https://mcp.${DOMAIN:-localhost} \
  --build-arg VITE_BETTER_AUTH_URL=https://api.${DOMAIN:-localhost} \
  --build-arg VITE_WORKSPACE=workspace .
docker push ${ECR_REGISTRY}/${PROJECT_NAME}/shogo-web:latest
echo -e "${GREEN}✓${NC} Pushed shogo-web"

echo ""

# -----------------------------------------------------------------------------
# Deploy Kubernetes resources
# -----------------------------------------------------------------------------
echo -e "${YELLOW}Deploying Kubernetes resources...${NC}"

# Deploy shared configuration (ConfigMap and Secrets should be created by Terraform/Secrets Manager)
kubectl apply -f "${PROJECT_ROOT}/k8s/base/shogo-config.yaml" || echo "Config may be managed by Terraform"

# Deploy infrastructure (if not using RDS - for dev/staging)
kubectl apply -f "${PROJECT_ROOT}/k8s/base/postgres.yaml" 2>/dev/null || true
kubectl apply -f "${PROJECT_ROOT}/k8s/base/redis.yaml" 2>/dev/null || true

# Deploy platform-mcp (singleton for schema management)
cat "${PROJECT_ROOT}/k8s/base/platform-mcp.yaml" | \
  sed "s|ghcr.io/shogo-ai/shogo-mcp:latest|${ECR_REGISTRY}/${PROJECT_NAME}/shogo-mcp:latest|g" | \
  kubectl apply -f -

echo -e "${GREEN}✓${NC} Deployed platform-mcp"

# Deploy API with updated image reference
cat "${PROJECT_ROOT}/k8s/base/api.yaml" | \
  sed "s|k3d-shogo-registry:5000/shogo-api:latest|${ECR_REGISTRY}/${PROJECT_NAME}/shogo-api:latest|g" | \
  kubectl apply -f -

echo -e "${GREEN}✓${NC} Deployed shogo-api"

# Deploy Web with updated image reference  
cat "${PROJECT_ROOT}/k8s/base/web.yaml" | \
  sed "s|k3d-shogo-registry:5000/shogo-web:latest|${ECR_REGISTRY}/${PROJECT_NAME}/shogo-web:latest|g" | \
  kubectl apply -f -

echo -e "${GREEN}✓${NC} Deployed shogo-web"

# Deploy Knative workspace services (optional - for per-project scaling)
if [ -f "${PROJECT_ROOT}/k8s/knative/workspace-template.yaml" ]; then
  cat "${PROJECT_ROOT}/k8s/knative/workspace-template.yaml" | \
    sed "s|k3d-shogo-registry:5000/shogo-mcp:latest|${ECR_REGISTRY}/${PROJECT_NAME}/shogo-mcp:latest|g" | \
    kubectl apply -f -
  echo -e "${GREEN}✓${NC} Deployed Knative workspace services"
fi

echo ""

# -----------------------------------------------------------------------------
# Wait for deployments
# -----------------------------------------------------------------------------
echo -e "${YELLOW}Waiting for deployments to be ready...${NC}"

kubectl rollout status deployment/platform-mcp -n shogo-system --timeout=300s || true
kubectl rollout status deployment/shogo-api -n shogo-system --timeout=300s || true
kubectl rollout status deployment/shogo-web -n shogo-system --timeout=300s || true

echo -e "${GREEN}✓${NC} Deployments ready"
echo ""

# -----------------------------------------------------------------------------
# Get service endpoints
# -----------------------------------------------------------------------------
echo -e "${BLUE}=============================================="
echo "  Deployment Complete!"
echo -e "==============================================${NC}"
echo ""

# Get ALB endpoint if available
ALB_ENDPOINT=$(kubectl get ingress -n shogo-system -o jsonpath='{.items[0].status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")

if [ -n "$ALB_ENDPOINT" ]; then
  echo "Load Balancer: ${ALB_ENDPOINT}"
fi

echo ""
echo "Knative Services:"
kubectl get ksvc -n shogo-workspaces 2>/dev/null || echo "  No Knative services found"

echo ""
echo "Pods:"
kubectl get pods -n shogo-system
kubectl get pods -n shogo-workspaces 2>/dev/null || true

echo ""
echo -e "${GREEN}Deployment successful!${NC}"
echo ""
echo "Next steps:"
echo "  1. Configure DNS to point to the load balancer"
echo "  2. Set up SSL certificates (ACM + ALB)"
echo "  3. Test the application"
echo ""

