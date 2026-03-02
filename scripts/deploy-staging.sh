#!/bin/bash
# =============================================================================
# Deploy to Staging Cluster
# =============================================================================
# Build, push, and deploy Docker containers to the staging EKS cluster.
#
# Usage:
#   ./scripts/deploy-staging.sh                    # Build and deploy all containers
#   ./scripts/deploy-staging.sh api web            # Build and deploy specific containers
#   ./scripts/deploy-staging.sh --skip-deploy api  # Only build and push, no deploy
#   ./scripts/deploy-staging.sh --skip-build       # Only deploy (no build/push)
#   ./scripts/deploy-staging.sh --list             # List available containers
#
# Available containers: api, web, project-runtime
# =============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
AWS_PROFILE="${AWS_PROFILE:-shogo}"
AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ACCOUNT_ID="097357356677"
ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
ECR_PREFIX="${ECR_REGISTRY}/shogo"
IMAGE_TAG="${IMAGE_TAG:-staging-latest}"
CLUSTER_NAME="${CLUSTER_NAME:-shogo-staging}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Container definitions: name -> Dockerfile path
declare -A CONTAINERS=(
  ["api"]="apps/api/Dockerfile"
  ["web"]="apps/web/Dockerfile"
  ["project-runtime"]="packages/project-runtime/Dockerfile"
)

# Container -> ECR image name mapping
declare -A IMAGE_NAMES=(
  ["api"]="shogo-api"
  ["web"]="shogo-web"
  ["project-runtime"]="project-runtime"
)

# Build arguments for specific containers
declare -A BUILD_ARGS=(
  ["web"]="--build-arg VITE_API_URL= --build-arg VITE_BETTER_AUTH_URL= --build-arg VITE_WORKSPACE=workspace"
)

# Temp directory for build logs
BUILD_LOG_DIR=$(mktemp -d)
trap "rm -rf ${BUILD_LOG_DIR}" EXIT

# -----------------------------------------------------------------------------
# Helper Functions
# -----------------------------------------------------------------------------

log_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
  echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

print_header() {
  echo ""
  echo -e "${CYAN}=============================================="
  echo "  $1"
  echo -e "==============================================${NC}"
  echo ""
}

list_containers() {
  echo "Available containers:"
  for name in "${!CONTAINERS[@]}"; do
    echo "  - ${name} (${CONTAINERS[$name]})"
  done | sort
}

# Build a single container (called in background)
build_container() {
  local name=$1
  local dockerfile=${CONTAINERS[$name]}
  local image_name=${IMAGE_NAMES[$name]}
  local full_image="${ECR_PREFIX}/${image_name}:${IMAGE_TAG}"
  local log_file="${BUILD_LOG_DIR}/${name}.log"
  local build_args="${BUILD_ARGS[$name]:-}"

  echo "Building ${name}..." > "${log_file}"
  
  cd "${PROJECT_ROOT}"
  
  # Build the image
  if docker build \
    -t "${full_image}" \
    -f "${dockerfile}" \
    ${build_args} \
    . >> "${log_file}" 2>&1; then
    echo "SUCCESS" >> "${log_file}"
    return 0
  else
    echo "FAILED" >> "${log_file}"
    return 1
  fi
}

# Push a single container (called in background)
push_container() {
  local name=$1
  local image_name=${IMAGE_NAMES[$name]}
  local full_image="${ECR_PREFIX}/${image_name}:${IMAGE_TAG}"
  local log_file="${BUILD_LOG_DIR}/${name}-push.log"

  echo "Pushing ${name}..." > "${log_file}"
  
  if docker push "${full_image}" >> "${log_file}" 2>&1; then
    echo "SUCCESS" >> "${log_file}"
    return 0
  else
    echo "FAILED" >> "${log_file}"
    return 1
  fi
}

# Wait for background jobs and report status
wait_for_jobs() {
  local job_type=$1
  shift
  local names=("$@")
  local failed=()
  local succeeded=()

  for job in $(jobs -p); do
    wait $job 2>/dev/null || true
  done

  for name in "${names[@]}"; do
    local log_file="${BUILD_LOG_DIR}/${name}${job_type}.log"
    if [ -f "${log_file}" ] && grep -q "SUCCESS" "${log_file}"; then
      succeeded+=("$name")
    else
      failed+=("$name")
    fi
  done

  if [ ${#succeeded[@]} -gt 0 ]; then
    log_success "${job_type#-} completed: ${succeeded[*]}"
  fi

  if [ ${#failed[@]} -gt 0 ]; then
    log_error "${job_type#-} failed: ${failed[*]}"
    echo ""
    for name in "${failed[@]}"; do
      local log_file="${BUILD_LOG_DIR}/${name}${job_type}.log"
      if [ -f "${log_file}" ]; then
        echo -e "${RED}=== ${name} log ===${NC}"
        tail -50 "${log_file}"
        echo ""
      fi
    done
    return 1
  fi

  return 0
}

# -----------------------------------------------------------------------------
# Parse Arguments
# -----------------------------------------------------------------------------

SKIP_BUILD=false
SKIP_DEPLOY=false
CONTAINERS_TO_BUILD=()

while [[ $# -gt 0 ]]; do
  case $1 in
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    --skip-deploy)
      SKIP_DEPLOY=true
      shift
      ;;
    --list|-l)
      list_containers
      exit 0
      ;;
    --help|-h)
      echo "Usage: $0 [OPTIONS] [CONTAINERS...]"
      echo ""
      echo "Options:"
      echo "  --skip-build    Skip building and pushing containers"
      echo "  --skip-deploy   Skip deploying to Kubernetes"
      echo "  --list, -l      List available containers"
      echo "  --help, -h      Show this help message"
      echo ""
      echo "Containers: api, web, project-runtime"
      echo ""
      echo "Environment variables:"
      echo "  AWS_PROFILE     AWS profile to use (default: shogo)"
      echo "  AWS_REGION      AWS region (default: us-east-1)"
      echo "  IMAGE_TAG       Docker image tag (default: staging-latest)"
      echo "  CLUSTER_NAME    EKS cluster name (default: shogo-staging)"
      exit 0
      ;;
    -*)
      log_error "Unknown option: $1"
      exit 1
      ;;
    *)
      if [[ -v "CONTAINERS[$1]" ]]; then
        CONTAINERS_TO_BUILD+=("$1")
      else
        log_error "Unknown container: $1"
        list_containers
        exit 1
      fi
      shift
      ;;
  esac
done

# Default to all containers if none specified
if [ ${#CONTAINERS_TO_BUILD[@]} -eq 0 ]; then
  CONTAINERS_TO_BUILD=("api" "web" "project-runtime")
fi

# -----------------------------------------------------------------------------
# Main Execution
# -----------------------------------------------------------------------------

print_header "Shogo AI - Staging Deployment"

echo "AWS Profile:  ${AWS_PROFILE}"
echo "AWS Region:   ${AWS_REGION}"
echo "ECR Registry: ${ECR_REGISTRY}"
echo "Image Tag:    ${IMAGE_TAG}"
echo "Cluster:      ${CLUSTER_NAME}"
echo "Containers:   ${CONTAINERS_TO_BUILD[*]}"
echo "Skip Build:   ${SKIP_BUILD}"
echo "Skip Deploy:  ${SKIP_DEPLOY}"
echo ""

# -----------------------------------------------------------------------------
# Check Prerequisites
# -----------------------------------------------------------------------------

log_info "Checking prerequisites..."

command -v aws >/dev/null 2>&1 || { log_error "AWS CLI is required"; exit 1; }
command -v docker >/dev/null 2>&1 || { log_error "Docker is required"; exit 1; }
command -v kubectl >/dev/null 2>&1 || { log_error "kubectl is required"; exit 1; }

# Verify AWS credentials with profile
if ! AWS_PROFILE=${AWS_PROFILE} aws sts get-caller-identity >/dev/null 2>&1; then
  log_error "AWS credentials not valid for profile '${AWS_PROFILE}'"
  exit 1
fi

log_success "Prerequisites check passed"

# -----------------------------------------------------------------------------
# Build and Push
# -----------------------------------------------------------------------------

if [ "$SKIP_BUILD" = false ]; then
  print_header "Building Containers (parallel)"

  # Authenticate to ECR
  log_info "Authenticating to ECR..."
  AWS_PROFILE=${AWS_PROFILE} aws ecr get-login-password --region ${AWS_REGION} | \
    docker login --username AWS --password-stdin ${ECR_REGISTRY}
  log_success "Authenticated to ECR"
  echo ""

  # Build all containers in parallel
  log_info "Starting parallel builds for: ${CONTAINERS_TO_BUILD[*]}"
  
  for name in "${CONTAINERS_TO_BUILD[@]}"; do
    echo -e "  ${YELLOW}▶${NC} Building ${name}..."
    build_container "$name" &
  done

  # Wait for all builds to complete
  log_info "Waiting for builds to complete..."
  if ! wait_for_jobs "" "${CONTAINERS_TO_BUILD[@]}"; then
    log_error "Some builds failed. Aborting."
    exit 1
  fi

  # Push all containers in parallel
  print_header "Pushing Containers (parallel)"
  
  log_info "Starting parallel pushes for: ${CONTAINERS_TO_BUILD[*]}"
  
  for name in "${CONTAINERS_TO_BUILD[@]}"; do
    echo -e "  ${YELLOW}▶${NC} Pushing ${name}..."
    push_container "$name" &
  done

  # Wait for all pushes to complete
  log_info "Waiting for pushes to complete..."
  if ! wait_for_jobs "-push" "${CONTAINERS_TO_BUILD[@]}"; then
    log_error "Some pushes failed. Aborting."
    exit 1
  fi
fi

# -----------------------------------------------------------------------------
# Deploy to Kubernetes
# -----------------------------------------------------------------------------

if [ "$SKIP_DEPLOY" = false ]; then
  print_header "Deploying to Kubernetes"

  # Configure kubectl for EKS
  log_info "Configuring kubectl for ${CLUSTER_NAME}..."
  AWS_PROFILE=${AWS_PROFILE} aws eks update-kubeconfig \
    --region ${AWS_REGION} \
    --name ${CLUSTER_NAME}
  log_success "kubectl configured"

  # Apply kustomize overlay for staging
  log_info "Applying staging kustomize overlay..."
  kubectl apply -k "${PROJECT_ROOT}/k8s/overlays/staging/"
  log_success "Kustomize overlay applied"

  # Force rollout restart to pick up new images
  # (kustomize uses floating tags, so we need to restart deployments)
  log_info "Restarting deployments to pick up new images..."
  
  # Restart relevant services based on what was built
  for name in "${CONTAINERS_TO_BUILD[@]}"; do
    case $name in
      api)
        kubectl rollout restart ksvc/api -n shogo-staging-system 2>/dev/null || \
          log_warn "Could not restart api service"
        ;;
      web)
        kubectl rollout restart ksvc/studio -n shogo-staging-system 2>/dev/null || \
          log_warn "Could not restart studio service"
        ;;
      project-runtime)
        log_info "project-runtime: pods are created on-demand by API"
        ;;
    esac
  done

  # Wait for rollouts to complete
  log_info "Waiting for services to become ready..."
  
  for name in "${CONTAINERS_TO_BUILD[@]}"; do
    case $name in
      api)
        kubectl wait --for=condition=Ready ksvc/api -n shogo-staging-system --timeout=180s 2>/dev/null || \
          log_warn "Timeout waiting for api service"
        ;;
      web)
        kubectl wait --for=condition=Ready ksvc/studio -n shogo-staging-system --timeout=180s 2>/dev/null || \
          log_warn "Timeout waiting for studio service"
        ;;
    esac
  done

  log_success "Deployment complete"
fi

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------

print_header "Deployment Summary"

if [ "$SKIP_BUILD" = false ]; then
  echo "Images pushed:"
  for name in "${CONTAINERS_TO_BUILD[@]}"; do
    image_name=${IMAGE_NAMES[$name]}
    echo "  - ${ECR_PREFIX}/${image_name}:${IMAGE_TAG}"
  done
  echo ""
fi

if [ "$SKIP_DEPLOY" = false ]; then
  echo "Kubernetes services:"
  kubectl get ksvc -n shogo-staging-system 2>/dev/null || true
  echo ""
  kubectl get ksvc -n shogo-staging-workspaces 2>/dev/null || true
  echo ""
  
  echo "Staging URLs:"
  echo "  - Studio: https://studio-staging.shogo.ai"
  echo "  - API:    https://api-staging.shogo.ai"
fi

echo ""
log_success "Done!"
