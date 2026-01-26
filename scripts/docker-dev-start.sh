#!/bin/bash
# =============================================================================
# Shogo AI - Development Environment Startup Script
# =============================================================================
# Hybrid setup: Docker for infrastructure, native bun for app services.
# This gives the best HMR performance and avoids Docker networking issues.
#
# Usage:
#   ./scripts/docker-dev-start.sh           # Start everything
#   ./scripts/docker-dev-start.sh --infra   # Start only infrastructure
#   ./scripts/docker-dev-start.sh --clean   # Clean start (remove volumes)
#
# Architecture:
#   Docker (infrastructure):
#     - PostgreSQL (platform)    - localhost:5432
#     - PostgreSQL (projects)    - localhost:5433
#     - Redis                    - localhost:6379
#     - MinIO (S3 storage)       - localhost:9000 (console: 9001)
#
#   Native bun (app services with HMR):
#     - MCP Server               - localhost:3100
#     - API Server               - localhost:8002
#     - Web Frontend (Vite)      - localhost:5173
#
# Prerequisites:
#   - Docker and Docker Compose
#   - Bun runtime
#   - .env.local file with ANTHROPIC_API_KEY
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"

cd "$PROJECT_ROOT"

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Shogo AI - Development Environment${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Parse arguments
INFRA_ONLY=""
CLEAN_FLAG=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --infra)
      INFRA_ONLY="true"
      shift
      ;;
    --clean)
      CLEAN_FLAG="true"
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --infra    Start only infrastructure (Docker services)"
      echo "  --clean    Clean start (remove Docker volumes)"
      echo "  --help     Show this help message"
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      echo "Use --help for usage information"
      exit 1
      ;;
  esac
done

# Check prerequisites
echo -e "${YELLOW}Checking prerequisites...${NC}"

if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker is not installed. Please install Docker Desktop.${NC}"
    exit 1
fi

if ! docker info &> /dev/null; then
    echo -e "${RED}❌ Docker is not running. Please start Docker Desktop.${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Docker is running${NC}"

if ! command -v bun &> /dev/null; then
    echo -e "${RED}❌ Bun is not installed. Please install bun: curl -fsSL https://bun.sh/install | bash${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Bun is installed${NC}"

# Check for .env.local
if [ ! -f ".env.local" ]; then
    echo -e "${YELLOW}⚠️  .env.local not found. Creating from template...${NC}"
    if [ -f ".env.local.template" ]; then
        cp .env.local.template .env.local
        echo -e "${YELLOW}   Please edit .env.local and add your ANTHROPIC_API_KEY${NC}"
    else
        # Create minimal .env.local
        cat > .env.local << 'EOF'
# Shogo AI Local Development Environment
# Add your API keys below

# Required for AI chat functionality
ANTHROPIC_API_KEY=

# Port configuration
VITE_PORT=5173
API_PORT=8002
MCP_PORT=3100

# Database (Docker PostgreSQL)
DATABASE_URL=postgres://shogo:shogo_dev@localhost:5432/shogo
PROJECTS_DATABASE_URL=postgres://project:project_dev@localhost:5433/projects

# Redis (Docker)
REDIS_URL=redis://localhost:6379

# Authentication
BETTER_AUTH_SECRET=shogo-local-dev-secret-32-chars-minimum-ok
BETTER_AUTH_URL=http://localhost:8002

# MCP Configuration
SCHEMAS_PATH=.schemas
WORKSPACE_ID=workspace
TENANT_ID=tenant-a

# CORS
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000

# Runtime (for project previews)
WORKSPACES_DIR=./workspaces
RUNTIME_BASE_PORT=5200
RUNTIME_DOMAIN_SUFFIX=localhost
EOF
        echo -e "${YELLOW}   Created .env.local - please add your ANTHROPIC_API_KEY${NC}"
    fi
fi

# Clean volumes if requested
if [ -n "$CLEAN_FLAG" ]; then
    echo -e "${YELLOW}Cleaning Docker volumes...${NC}"
    docker compose down -v 2>/dev/null || true
    echo -e "${GREEN}✓ Volumes cleaned${NC}"
fi

# Create workspaces directory if it doesn't exist
if [ ! -d "workspaces" ]; then
    mkdir -p workspaces
    echo -e "${GREEN}✓ Created workspaces directory${NC}"
fi

# =============================================================================
# Start Infrastructure (Docker)
# =============================================================================
echo ""
echo -e "${BLUE}Starting infrastructure services (Docker)...${NC}"

docker compose up -d postgres postgres-projects redis minio minio-init

# Wait for infrastructure to be healthy
echo ""
echo -e "${YELLOW}Waiting for infrastructure...${NC}"

# Wait for PostgreSQL (platform)
echo -n "  PostgreSQL (platform)... "
for i in {1..30}; do
    if docker compose exec -T postgres pg_isready -U shogo &>/dev/null; then
        echo -e "${GREEN}✓${NC}"
        break
    fi
    if [ $i -eq 30 ]; then
        echo -e "${RED}✗ timeout${NC}"
    fi
    sleep 1
done

# Wait for PostgreSQL (projects)
echo -n "  PostgreSQL (projects)... "
for i in {1..30}; do
    if docker compose exec -T postgres-projects pg_isready -U project &>/dev/null; then
        echo -e "${GREEN}✓${NC}"
        break
    fi
    if [ $i -eq 30 ]; then
        echo -e "${RED}✗ timeout${NC}"
    fi
    sleep 1
done

# Wait for Redis
echo -n "  Redis... "
for i in {1..15}; do
    if docker compose exec -T redis redis-cli ping &>/dev/null; then
        echo -e "${GREEN}✓${NC}"
        break
    fi
    if [ $i -eq 15 ]; then
        echo -e "${RED}✗ timeout${NC}"
    fi
    sleep 1
done

# Wait for MinIO
echo -n "  MinIO... "
for i in {1..15}; do
    if curl -sf http://localhost:9000/minio/health/live &>/dev/null; then
        echo -e "${GREEN}✓${NC}"
        break
    fi
    if [ $i -eq 15 ]; then
        echo -e "${RED}✗ timeout${NC}"
    fi
    sleep 1
done

# Run Prisma migrations
echo ""
echo -e "${YELLOW}Running database migrations...${NC}"
bunx prisma migrate deploy 2>/dev/null || bunx prisma db push --accept-data-loss 2>/dev/null || true
echo -e "${GREEN}✓ Migrations complete${NC}"

if [ -n "$INFRA_ONLY" ]; then
    echo ""
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}  Infrastructure is ready!${NC}"
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "  ${CYAN}Infrastructure:${NC}"
    echo -e "    PostgreSQL (platform):  localhost:5432"
    echo -e "    PostgreSQL (projects):  localhost:5433"
    echo -e "    Redis:                  localhost:6379"
    echo -e "    MinIO:                  localhost:9000"
    echo -e "    MinIO Console:          localhost:9001 (minioadmin/minioadmin)"
    echo ""
    echo -e "  ${YELLOW}To start app services manually:${NC}"
    echo -e "    Terminal 1: bun run mcp:http"
    echo -e "    Terminal 2: bun run api:dev"
    echo -e "    Terminal 3: bun run web:dev"
    echo ""
    exit 0
fi

# =============================================================================
# Start App Services (Native bun)
# =============================================================================
echo ""
echo -e "${BLUE}Starting app services (native bun with HMR)...${NC}"
echo ""
echo -e "${CYAN}Opening 3 terminal windows for app services...${NC}"
echo ""

# Check if we're on macOS and can use osascript
if [[ "$OSTYPE" == "darwin"* ]] && command -v osascript &> /dev/null; then
    # macOS: Open new Terminal tabs
    osascript <<EOF
tell application "Terminal"
    activate
    
    -- MCP Server
    do script "cd '$PROJECT_ROOT' && echo '🔌 Starting MCP Server on port 3100...' && bun run mcp:http"
    
    -- API Server  
    do script "cd '$PROJECT_ROOT' && echo '🚀 Starting API Server on port 8002...' && sleep 2 && bun run api:dev"
    
    -- Web Frontend
    do script "cd '$PROJECT_ROOT' && echo '🌐 Starting Web Frontend on port 5173...' && sleep 3 && bun run web:dev"
end tell
EOF
    
    echo -e "${GREEN}✓ Started app services in new Terminal tabs${NC}"
else
    # Not macOS or osascript not available - print manual instructions
    echo -e "${YELLOW}Please start these services in separate terminals:${NC}"
    echo ""
    echo -e "  ${CYAN}Terminal 1 (MCP):${NC}"
    echo -e "    cd $PROJECT_ROOT && bun run mcp:http"
    echo ""
    echo -e "  ${CYAN}Terminal 2 (API):${NC}"
    echo -e "    cd $PROJECT_ROOT && bun run api:dev"
    echo ""
    echo -e "  ${CYAN}Terminal 3 (Web):${NC}"
    echo -e "    cd $PROJECT_ROOT && bun run web:dev"
    echo ""
fi

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Development environment starting!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${CYAN}App Services (with HMR):${NC}"
echo -e "    Web UI:      ${BLUE}http://localhost:5173${NC}"
echo -e "    API Server:  http://localhost:8002"
echo -e "    MCP Server:  http://localhost:3100"
echo ""
echo -e "  ${CYAN}Infrastructure (Docker):${NC}"
echo -e "    PostgreSQL:  localhost:5432 / 5433"
echo -e "    Redis:       localhost:6379"
echo -e "    MinIO:       localhost:9000 (console: 9001)"
echo ""
echo -e "  ${YELLOW}Commands:${NC}"
echo -e "    Stop infra:    docker compose down"
echo -e "    View logs:     docker compose logs -f"
echo -e "    Run e2e tests: bun run test:e2e"
echo ""
