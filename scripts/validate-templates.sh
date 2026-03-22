#!/bin/bash
# =============================================================================
# Validate Templates Script
# =============================================================================
# Quick validation that all SDK example templates are correctly configured.
# Checks:
#   1. Prisma schema uses sqlite provider (not postgresql)
#   2. prisma.config.ts does not use strict env() that fails without DATABASE_URL
#   3. package.json uses @prisma/adapter-libsql (not adapter-pg)
#   4. src/lib/db.ts uses PrismaLibSql (not PrismaPg), if present
#   5. template.json has "database": "sqlite", if present
#   6. bunx prisma generate succeeds without DATABASE_URL set
#
# Usage:
#   ./scripts/validate-templates.sh              # Validate all
#   ./scripts/validate-templates.sh todo-app     # Validate one
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXAMPLES_DIR="$REPO_ROOT/packages/sdk/examples"
RUNTIME_TEMPLATE_DIR="$REPO_ROOT/templates/runtime-template"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

pass_count=0
fail_count=0
warn_count=0

pass() { echo -e "  ${GREEN}✓${NC} $1"; pass_count=$((pass_count + 1)); }
fail() { echo -e "  ${RED}✗${NC} $1"; fail_count=$((fail_count + 1)); }
warn() { echo -e "  ${YELLOW}!${NC} $1"; warn_count=$((warn_count + 1)); }

validate_template() {
  local dir="$1"
  local name
  name="$(basename "$dir")"

  echo ""
  echo "=== $name ==="

  if [ ! -f "$dir/package.json" ]; then
    warn "No package.json — skipping"
    return
  fi

  # 1. Prisma schema: sqlite provider, no @db.* annotations
  if [ -f "$dir/prisma/schema.prisma" ]; then
    if grep -q 'provider\s*=\s*"sqlite"' "$dir/prisma/schema.prisma"; then
      pass "Schema uses sqlite provider"
    else
      fail "Schema does NOT use sqlite provider"
    fi

    if grep -qE '@db\.\w+' "$dir/prisma/schema.prisma"; then
      fail "Schema has @db.* annotations (not compatible with sqlite)"
    else
      pass "No @db.* annotations"
    fi
  fi

  # 2. prisma.config.ts: no strict env() import
  if [ -f "$dir/prisma.config.ts" ]; then
    if grep -q "env('DATABASE_URL')" "$dir/prisma.config.ts"; then
      fail "prisma.config.ts uses strict env('DATABASE_URL') — will fail without env var"
    else
      pass "prisma.config.ts uses safe fallback for DATABASE_URL"
    fi
  fi

  # 3. package.json: libsql not pg
  if grep -q '"@prisma/adapter-pg"' "$dir/package.json"; then
    fail "package.json still has @prisma/adapter-pg"
  elif grep -q '"@prisma/adapter-libsql"' "$dir/package.json"; then
    pass "package.json uses @prisma/adapter-libsql"
  fi

  if grep -q '"pg"' "$dir/package.json"; then
    # Ignore if it's part of a longer package name
    if grep -qE '"pg"\s*:' "$dir/package.json"; then
      fail "package.json still has pg dependency"
    fi
  fi

  # 4. db.ts: PrismaLibSql not PrismaPg
  if [ -f "$dir/src/lib/db.ts" ]; then
    if grep -q 'PrismaPg' "$dir/src/lib/db.ts"; then
      fail "db.ts still uses PrismaPg"
    elif grep -q 'PrismaLibSql' "$dir/src/lib/db.ts"; then
      pass "db.ts uses PrismaLibSql"
    fi
  fi

  # 5. template.json: database = sqlite
  if [ -f "$dir/template.json" ]; then
    if grep -q '"database"' "$dir/template.json"; then
      if grep -qi '"database":\s*"sqlite"' "$dir/template.json"; then
        pass "template.json database = sqlite"
      else
        fail "template.json database is not sqlite"
      fi
    fi
  fi

  # 6. prisma generate succeeds without DATABASE_URL
  if [ -f "$dir/prisma/schema.prisma" ] && [ -d "$dir/node_modules" ]; then
    if (unset DATABASE_URL; cd "$dir" && bunx --bun prisma generate 2>&1) > /dev/null 2>&1; then
      pass "prisma generate succeeds (no DATABASE_URL)"
    else
      fail "prisma generate FAILS without DATABASE_URL"
    fi
  fi
}

# Collect template dirs
dirs=()
if [ $# -gt 0 ]; then
  for arg in "$@"; do
    if [ -d "$EXAMPLES_DIR/$arg" ]; then
      dirs+=("$EXAMPLES_DIR/$arg")
    elif [ -d "$REPO_ROOT/$arg" ]; then
      dirs+=("$REPO_ROOT/$arg")
    else
      echo "Template not found: $arg"
      exit 1
    fi
  done
else
  for d in "$EXAMPLES_DIR"/*/; do
    [ -d "$d" ] && dirs+=("${d%/}")
  done
  [ -d "$RUNTIME_TEMPLATE_DIR" ] && dirs+=("$RUNTIME_TEMPLATE_DIR")
fi

echo "Validating ${#dirs[@]} template(s)..."

for dir in "${dirs[@]}"; do
  validate_template "$dir"
done

echo ""
echo "=================================================="
echo -e "Results: ${GREEN}${pass_count} passed${NC}, ${RED}${fail_count} failed${NC}, ${YELLOW}${warn_count} warnings${NC}"
echo "=================================================="

exit $fail_count
