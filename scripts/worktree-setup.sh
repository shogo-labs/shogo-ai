#!/usr/bin/env bash
# =============================================================================
# Worktree Setup Script
# =============================================================================
# Called by GTR postCreate hook to generate .env.local with unique ports
# for Docker Compose isolation across git worktrees.
#
# Environment variables provided by GTR:
#   WORKTREE_PATH - Full path to the created worktree
#   BRANCH        - Branch name
#   REPO_ROOT     - Repository root path
#
# Port offset calculation:
#   - Main/master branch: offset 0 (base ports)
#   - Feature branches: hash(branch) % 9 + 1 → 1-9 → ×10 → 10,20,30...90
#
# Usage:
#   ./scripts/worktree-setup.sh                    # Use GTR env vars
#   BRANCH=feat/foo WORKTREE_PATH=/path ./scripts/worktree-setup.sh  # Manual
# =============================================================================

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# =============================================================================
# Configuration
# =============================================================================

# Base ports (offset 0)
BASE_POSTGRES_PORT=5432
BASE_REDIS_PORT=6379
BASE_MINIO_API_PORT=9000
BASE_MINIO_CONSOLE_PORT=9001
BASE_API_PORT=8002
BASE_WEB_PORT=3000
BASE_VITE_RUNTIME_PORT=5200

# Secrets to preserve from existing .env.local
SECRETS_PATTERN='^(ANTHROPIC_API_KEY|GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|STRIPE_PRICE_.*)='

# =============================================================================
# Functions
# =============================================================================

log_info() {
    echo -e "${GREEN}[worktree-setup]${NC} $1" >&2
}

log_warn() {
    echo -e "${YELLOW}[worktree-setup]${NC} $1" >&2
}

log_error() {
    echo -e "${RED}[worktree-setup]${NC} $1" >&2
}

# Calculate port offset from branch name
# Returns: 0 for main/master, 10-90 for feature branches
calculate_offset() {
    local branch="$1"

    # Main/master branch uses offset 0
    if [[ "$branch" == "main" || "$branch" == "master" ]]; then
        echo 0
        return
    fi

    # Hash branch name to get a number, then map to 1-9 range
    local hash
    hash=$(echo -n "$branch" | cksum | cut -d' ' -f1)
    local index=$(( (hash % 9) + 1 ))  # 1-9
    echo $(( index * 10 ))              # 10, 20, 30...90
}

# Check if a port is available
check_port_available() {
    local port="$1"
    if command -v lsof &>/dev/null; then
        ! lsof -i ":$port" &>/dev/null
    elif command -v netstat &>/dev/null; then
        ! netstat -an | grep -q ":$port.*LISTEN"
    else
        # Can't check, assume available
        return 0
    fi
}

# Find an available offset, starting from the calculated one
find_available_offset() {
    local start_offset="$1"
    local offset="$start_offset"
    local attempts=0

    while [ $attempts -lt 9 ]; do
        # Test with web port (most likely to conflict)
        local test_port=$((BASE_WEB_PORT + offset))

        if check_port_available "$test_port"; then
            echo "$offset"
            return 0
        fi

        log_warn "Port $test_port in use, trying next offset..."

        # Move to next offset (wrap around)
        offset=$(( ((offset / 10) % 9 + 1) * 10 ))
        ((attempts++))
    done

    # Fallback to original offset
    log_warn "Could not find available ports, using original offset"
    echo "$start_offset"
}

# Sanitize branch name for use in COMPOSE_PROJECT_NAME
sanitize_branch_name() {
    local branch="$1"
    # Replace slashes and underscores with hyphens, lowercase
    echo "$branch" | tr '/' '-' | tr '_' '-' | tr '[:upper:]' '[:lower:]' | sed 's/--*/-/g'
}

# Extract secrets from a .env.local file
extract_secrets() {
    local env_file="$1"

    if [ -f "$env_file" ]; then
        grep -E "$SECRETS_PATTERN" "$env_file" 2>/dev/null || true
    fi
}

# Find the repo root (handles both worktrees and main repo)
find_repo_root() {
    # GTR provides REPO_ROOT, use it if available
    if [ -n "${REPO_ROOT:-}" ]; then
        echo "$REPO_ROOT"
        return
    fi

    # git-common-dir points to the main .git directory
    # For worktrees: /path/to/repo/.git
    # For main repo: .git (relative)
    local git_common_dir
    git_common_dir=$(git rev-parse --git-common-dir 2>/dev/null)

    # If it's an absolute path, the repo root is its parent
    if [[ "$git_common_dir" == /* ]]; then
        dirname "$git_common_dir"
    else
        # Relative path means we're in the main repo
        git rev-parse --show-toplevel 2>/dev/null
    fi
}

# Generate .env.local with calculated ports
generate_env_local() {
    local worktree_path="$1"
    local branch="$2"
    local offset="$3"

    local env_file="$worktree_path/.env.local"
    local sanitized_branch
    sanitized_branch=$(sanitize_branch_name "$branch")
    local compose_project="shogo-${sanitized_branch}"

    # Find repo root to get secrets from the source of truth
    local repo_root
    repo_root=$(find_repo_root)
    local repo_root_env="$repo_root/.env.local"

    # Extract secrets: prefer repo root, fall back to current worktree's file
    local secrets=""
    if [ -f "$repo_root_env" ] && [ "$repo_root_env" != "$env_file" ]; then
        log_info "Copying secrets from repo root: $repo_root_env"
        secrets=$(extract_secrets "$repo_root_env")
    elif [ -f "$env_file" ]; then
        secrets=$(extract_secrets "$env_file")
    fi

    # Calculate ports
    local postgres_port=$((BASE_POSTGRES_PORT + offset))
    local redis_port=$((BASE_REDIS_PORT + offset))
    local minio_api_port=$((BASE_MINIO_API_PORT + offset))
    local minio_console_port=$((BASE_MINIO_CONSOLE_PORT + offset))
    local api_port=$((BASE_API_PORT + offset))
    local web_port=$((BASE_WEB_PORT + offset))
    local vite_runtime_base=$((BASE_VITE_RUNTIME_PORT + offset))
    local vite_runtime_end=$((vite_runtime_base + 9))
    local vite_dev_port=$((5173 + offset))

    # Write new .env.local
    cat > "$env_file" << EOF
# =============================================================================
# Shogo AI - Worktree Environment Configuration
# =============================================================================
# Auto-generated by worktree-setup.sh
# Branch: $branch
# Port Offset: $offset
# Generated: $(date -Iseconds)
# =============================================================================

# =============================================================================
# DOCKER COMPOSE ISOLATION
# =============================================================================
COMPOSE_PROJECT_NAME=$compose_project
PORT_OFFSET=$offset

# =============================================================================
# PORT CONFIGURATION
# =============================================================================
POSTGRES_PORT=$postgres_port
REDIS_PORT=$redis_port
MINIO_API_PORT=$minio_api_port
MINIO_CONSOLE_PORT=$minio_console_port
API_PORT=$api_port
WEB_PORT=$web_port
VITE_RUNTIME_BASE=$vite_runtime_base
VITE_RUNTIME_END=$vite_runtime_end
VITE_DEV_PORT=$vite_dev_port

# =============================================================================
# SERVICE URLs (for local development outside Docker)
# =============================================================================
VITE_API_URL=http://localhost:$api_port
VITE_BETTER_AUTH_URL=http://localhost:$api_port

# =============================================================================
# DATABASE CONFIGURATION (Docker PostgreSQL)
# =============================================================================
# External connection (from host to Docker)
DATABASE_URL=postgres://shogo:shogo_dev@localhost:$postgres_port/shogo

# =============================================================================
# REDIS CONFIGURATION (Docker Redis)
# =============================================================================
REDIS_URL=redis://localhost:$redis_port

# =============================================================================
# AUTHENTICATION CONFIGURATION
# =============================================================================
BETTER_AUTH_SECRET=shogo-local-dev-secret-32-chars-minimum-ok
BETTER_AUTH_URL=http://localhost:$web_port

# =============================================================================
# CORS CONFIGURATION
# =============================================================================
ALLOWED_ORIGINS=http://localhost:$web_port,http://localhost:$((5173 + offset))

# =============================================================================
# SECRETS (preserved from previous config)
# =============================================================================
EOF

    # Append preserved secrets
    if [ -n "$secrets" ]; then
        echo "$secrets" >> "$env_file"
    else
        # Add placeholder for required secrets
        cat >> "$env_file" << 'EOF'
# Add your API keys below:
ANTHROPIC_API_KEY=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
EOF
    fi

    log_info "Generated $env_file"

    # Create .env symlink for Docker Compose variable substitution
    # Docker Compose reads .env by default, not .env.local
    local dot_env="$worktree_path/.env"
    if [ -L "$dot_env" ]; then
        rm "$dot_env"
    elif [ -f "$dot_env" ]; then
        log_warn ".env exists as a regular file, backing up to .env.backup"
        mv "$dot_env" "$worktree_path/.env.backup"
    fi
    ln -s .env.local "$dot_env"
    log_info "Created .env symlink -> .env.local"
}

# =============================================================================
# Main
# =============================================================================

main() {
    # Get worktree path and branch from GTR env vars or current directory
    local worktree_path="${WORKTREE_PATH:-$(pwd)}"
    local branch="${BRANCH:-}"

    # If no branch provided, try to detect from git
    if [ -z "$branch" ]; then
        branch=$(git -C "$worktree_path" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
    fi

    log_info "Setting up worktree environment"
    log_info "  Branch: $branch"
    log_info "  Path: $worktree_path"

    # Calculate port offset
    local initial_offset
    initial_offset=$(calculate_offset "$branch")

    local offset
    offset=$(find_available_offset "$initial_offset")

    if [ "$offset" != "$initial_offset" ]; then
        log_warn "Original offset $initial_offset had port conflicts, using $offset"
    fi

    log_info "  Port offset: $offset"

    # Generate .env.local
    generate_env_local "$worktree_path" "$branch" "$offset"

    # Print summary
    echo ""
    log_info "Configuration complete!"
    echo ""
    echo "  COMPOSE_PROJECT_NAME: shogo-$(sanitize_branch_name "$branch")"
    echo "  Web:    http://localhost:$((BASE_WEB_PORT + offset))"
    echo "  API:    http://localhost:$((BASE_API_PORT + offset))"
    echo "  MinIO:  http://localhost:$((BASE_MINIO_CONSOLE_PORT + offset))"
    echo ""
    echo "  To start Docker: docker compose up --build"
    echo ""
}

main "$@"
