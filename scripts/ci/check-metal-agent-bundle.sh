#!/usr/bin/env bash
# Refuse a metal agent bundle whose imports do not resolve on a host.
#
# Hosts extract the bundle alone into /opt/metal-agent: no monorepo, no
# workspace packages. An import that reaches outside apps/metal-agent/src
# resolves to nothing there and the agent crash-loops on boot (2026-10-16
# staging outage). Shared modules are vendored instead; see
# scripts/metal-agent/sync-vendor.sh.
#
#   scripts/ci/check-metal-agent-bundle.sh [agent-<version>.tgz]
#
# With no argument, packs the current tree the way metal-agent-deploy.yml does.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bash "$root/scripts/metal-agent/sync-vendor.sh" --check

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bundle"

if [[ $# -ge 1 ]]; then
  tar -xzf "$1" -C "$work/bundle"
else
  cp -a "$root/apps/metal-agent/src" "$work/bundle/src"
  cp -a "$root/apps/metal-agent/package.json" "$root/apps/metal-agent/tsconfig.json" "$work/bundle/"
fi

(cd "$work/bundle" && bun build --target=bun --outdir "$work/out" src/server.ts >/dev/null)
echo "metal agent bundle imports resolve"
