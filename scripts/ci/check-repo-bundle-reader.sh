#!/usr/bin/env bash
# Refuse to publish a metal agent or runtime image that cannot read the
# incremental repo format (manifest + git bundles).
#
# Once a project has a manifest, a host or guest that only knows the legacy
# `repo.git.tar.gz` would restore a stale repo and could write it over the
# bundle lineage. The same guard also stops an older commit being published
# over a newer one (the staging rollback race).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fail=0

require() {
  local file="$1" needle="$2" what="$3"
  if ! grep -Fq -- "$needle" "$root/$file"; then
    echo "::error::$file does not contain $what; this build cannot read incremental repo manifests."
    fail=1
  fi
}

require packages/agent-runtime/src/server.ts "app.post('/pool/repo-bundles-hydrate'" "the /pool/repo-bundles-hydrate endpoint"
require packages/agent-runtime/src/server.ts "bundles: true" "the bundles capability on the /pool/repo-hydrated probe"
require apps/metal-agent/src/pool.ts "prepareRepoStageFromBundles" "the manifest-first hydrate"
require apps/api/src/services/git-repo-store.ts "hydrateFromManifest" "the manifest-first API reader"

if [[ $fail -ne 0 ]]; then
  exit 1
fi
echo "repo bundle reader present"
