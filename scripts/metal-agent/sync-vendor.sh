#!/usr/bin/env bash
# =============================================================================
# sync-vendor.sh — copy shared-runtime modules the metal agent needs into
# apps/metal-agent/src/vendor/.
# =============================================================================
# The agent ships as a bundle of apps/metal-agent/src only (see
# metal-agent-deploy.yml), extracted to /opt/metal-agent with no workspace
# node_modules. An import that climbs out of src/ resolves to nothing on a host
# and the agent crash-loops on boot (2026-10-16 staging outage). Modules shared
# with the API and runtime are therefore vendored byte-for-byte; the source of
# truth stays in packages/shared-runtime.
#
#   scripts/metal-agent/sync-vendor.sh          # refresh the vendored copies
#   scripts/metal-agent/sync-vendor.sh --check  # exit 1 if any copy has drifted
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
src="$root/packages/shared-runtime/src"
dst="$root/apps/metal-agent/src/vendor"

FILES=(
  repo-bundles.ts
  child-process.ts
)

if [[ "${1:-}" == "--check" ]]; then
  fail=0
  for f in "${FILES[@]}"; do
    if ! cmp -s "$src/$f" "$dst/$f"; then
      echo "::error::apps/metal-agent/src/vendor/$f differs from packages/shared-runtime/src/$f; run scripts/metal-agent/sync-vendor.sh"
      fail=1
    fi
  done
  exit $fail
fi

mkdir -p "$dst"
for f in "${FILES[@]}"; do
  cp "$src/$f" "$dst/$f"
done
echo "vendored ${#FILES[@]} file(s) into apps/metal-agent/src/vendor"
