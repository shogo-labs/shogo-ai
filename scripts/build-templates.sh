#!/bin/bash
# =============================================================================
# Build Templates Script
# =============================================================================
# Pre-builds all SDK example templates with:
# - node_modules (installed via bun install)
# - build artifacts (via bun run build)
# - prisma client (via bunx prisma generate)
#
# This allows template.copy to include pre-built artifacts, eliminating
# the need for bun install on project cold start.
#
# Usage:
#   ./scripts/build-templates.sh [template-name]
#
# Examples:
#   ./scripts/build-templates.sh              # Build all templates
#   ./scripts/build-templates.sh todo-app     # Build specific template
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXAMPLES_DIR="$REPO_ROOT/packages/sdk/examples"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
  echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
  echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

# Get list of templates
get_templates() {
  find "$EXAMPLES_DIR" -maxdepth 1 -mindepth 1 -type d -exec basename {} \; | sort
}

# Build a single template
build_template() {
  local template="$1"
  local template_dir="$EXAMPLES_DIR/$template"
  
  if [ ! -d "$template_dir" ]; then
    log_error "Template directory not found: $template_dir"
    return 1
  fi
  
  if [ ! -f "$template_dir/package.json" ]; then
    log_warning "Skipping $template: no package.json"
    return 0
  fi
  
  log_info "Building template: $template"
  cd "$template_dir"
  
  local start_time=$(date +%s)
  
  # Step 1: Install dependencies
  log_info "  Installing dependencies..."
  if ! bun install --frozen-lockfile 2>/dev/null; then
    # If frozen lockfile fails, try without it
    bun install
  fi
  
  # Step 2: Generate Prisma client (if prisma schema exists)
  if [ -f "prisma/schema.prisma" ]; then
    log_info "  Generating Prisma client..."
    bunx prisma generate
  fi
  
  # Step 3: Build (if build script exists)
  if grep -q '"build"' package.json 2>/dev/null; then
    log_info "  Building..."
    bun run build || log_warning "  Build failed (non-fatal)"
  fi
  
  local end_time=$(date +%s)
  local duration=$((end_time - start_time))
  
  # Count files
  local file_count=$(find . -type f | wc -l | tr -d ' ')
  local node_modules_size=$(du -sh node_modules 2>/dev/null | cut -f1 || echo "0")
  
  log_success "  $template built in ${duration}s ($file_count files, node_modules: $node_modules_size)"
  
  return 0
}

# Main
main() {
  local specific_template="$1"
  
  log_info "=================================================="
  log_info "Building Templates"
  log_info "=================================================="
  log_info "Examples directory: $EXAMPLES_DIR"
  
  local total_start=$(date +%s)
  local success_count=0
  local fail_count=0
  
  if [ -n "$specific_template" ]; then
    # Build specific template
    if build_template "$specific_template"; then
      success_count=$((success_count + 1))
    else
      fail_count=$((fail_count + 1))
    fi
  else
    # Build all templates
    for template in $(get_templates); do
      if build_template "$template"; then
        success_count=$((success_count + 1))
      else
        fail_count=$((fail_count + 1))
      fi
    done
  fi
  
  local total_end=$(date +%s)
  local total_duration=$((total_end - total_start))
  
  log_info "=================================================="
  log_info "Build Summary"
  log_info "=================================================="
  log_success "Successful: $success_count"
  if [ $fail_count -gt 0 ]; then
    log_error "Failed: $fail_count"
  fi
  log_info "Total time: ${total_duration}s"
  
  return $fail_count
}

main "$@"
