#!/usr/bin/env bash
# =============================================================================
# Worktree Cleanup Script
# =============================================================================
# Called by GTR preRemove hook to clean up Docker resources before
# deleting a worktree.
#
# This script:
#   1. Reads COMPOSE_PROJECT_NAME from the worktree's .env.local
#   2. Stops all containers for that project
#   3. Removes volumes associated with the project
#   4. Removes the project's network
#
# Environment variables provided by GTR:
#   WORKTREE_PATH - Full path to the worktree being removed
#   BRANCH        - Branch name
#
# Usage:
#   ./scripts/worktree-cleanup.sh                    # Use GTR env vars
#   WORKTREE_PATH=/path ./scripts/worktree-cleanup.sh  # Manual
# =============================================================================

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# =============================================================================
# Functions
# =============================================================================

log_info() {
    echo -e "${GREEN}[worktree-cleanup]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[worktree-cleanup]${NC} $1"
}

log_error() {
    echo -e "${RED}[worktree-cleanup]${NC} $1" >&2
}

# Extract COMPOSE_PROJECT_NAME from .env.local
get_compose_project_name() {
    local env_file="$1"

    if [ -f "$env_file" ]; then
        grep -E '^COMPOSE_PROJECT_NAME=' "$env_file" 2>/dev/null | cut -d'=' -f2 || true
    fi
}

# Check if Docker is available
check_docker() {
    if ! command -v docker &>/dev/null; then
        log_error "Docker is not installed or not in PATH"
        return 1
    fi

    if ! docker info &>/dev/null; then
        log_warn "Docker daemon is not running, skipping cleanup"
        return 1
    fi

    return 0
}

# Stop and remove containers for a project
cleanup_containers() {
    local project_name="$1"
    local worktree_path="$2"

    log_info "Stopping containers for project: $project_name"

    # Change to worktree directory to use its docker-compose.yml
    if [ -f "$worktree_path/docker-compose.yml" ]; then
        (
            cd "$worktree_path"
            # Stop and remove containers, networks, and volumes
            docker compose -p "$project_name" down -v --remove-orphans 2>/dev/null || true
        )
        log_info "Containers stopped and volumes removed"
    else
        # Fallback: use docker directly if no docker-compose.yml
        log_warn "No docker-compose.yml found, using docker directly"

        # Stop containers with matching project label
        local containers
        containers=$(docker ps -aq --filter "label=com.docker.compose.project=$project_name" 2>/dev/null || true)

        if [ -n "$containers" ]; then
            echo "$containers" | xargs docker stop 2>/dev/null || true
            echo "$containers" | xargs docker rm 2>/dev/null || true
            log_info "Stopped and removed containers"
        fi

        # Remove volumes with matching project prefix
        local volumes
        volumes=$(docker volume ls -q --filter "name=${project_name}_" 2>/dev/null || true)

        if [ -n "$volumes" ]; then
            echo "$volumes" | xargs docker volume rm 2>/dev/null || true
            log_info "Removed volumes"
        fi

        # Remove network
        docker network rm "${project_name}_default" 2>/dev/null || true
        docker network rm "${project_name}-network" 2>/dev/null || true
    fi
}

# =============================================================================
# Main
# =============================================================================

main() {
    # Get worktree path from GTR env vars or argument
    local worktree_path="${WORKTREE_PATH:-${1:-$(pwd)}}"
    local branch="${BRANCH:-unknown}"

    log_info "Cleaning up Docker resources for worktree"
    log_info "  Branch: $branch"
    log_info "  Path: $worktree_path"

    # Check if Docker is available
    if ! check_docker; then
        log_warn "Skipping Docker cleanup (Docker not available)"
        exit 0
    fi

    # Get compose project name from .env.local
    local env_file="$worktree_path/.env.local"
    local project_name
    project_name=$(get_compose_project_name "$env_file")

    if [ -z "$project_name" ]; then
        log_warn "No COMPOSE_PROJECT_NAME found in .env.local"
        log_warn "Skipping Docker cleanup (no project to clean)"
        exit 0
    fi

    log_info "  Project: $project_name"

    # Perform cleanup
    cleanup_containers "$project_name" "$worktree_path"

    echo ""
    log_info "Cleanup complete!"
    echo ""
}

main "$@"
