#!/usr/bin/env bash
# .github/scripts/promote-metal-runtime-image.sh
#
# Give a production release a metal runtime image (the multi-arch guest image
# the Firecracker fleet bakes into its rootfs) without rebuilding it.
#
# runtime-multiarch.yml publishes `staging-multiarch-<C>` and
# `staging-docker-multiarch-<C>` on pushes to main that touch the runtime chain,
# and a newer push cancels an older build, so most commits have no image of
# their own. Walk back from the release commit to the newest commit C whose
# runtime chain is identical (no diff in `metal-rootfs-gate.sh paths`) and that
# has both staging images, then retag them as `production-[docker-]multiarch-<C>`
# and `-latest`. The tag keeps C's sha: hosts check the revision stamped inside
# the image against the sha in the tag, and report it back to the rootfs gate.
#
# If no such C exists, or FORCE_BUILD=true, nothing is retagged and the caller
# builds `production-multiarch-<SHA>` from scratch instead.
#
# Env:
#   SHA            release commit (required)
#   REGISTRY       <region>.ocir.io/<namespace> (required, already logged in)
#   FORCE_BUILD    true to skip promotion
#   DRY_RUN        true to report the choice without retagging anything
#   MAX_COMMITS    how far back to look (default 200)
#
# Outputs: source (promoted|build), image, revision

set -euo pipefail

: "${SHA:?SHA required}"
: "${REGISTRY:?REGISTRY required}"
MAX_COMMITS="${MAX_COMMITS:-200}"
OUT="${GITHUB_OUTPUT:-/dev/null}"
REPO="${REGISTRY%/}/shogo/shogo-runtime"
GATE="$(dirname "$0")/../../scripts/ci/metal-rootfs-gate.sh"

emit_build() {
  echo "::notice::$1 — building ${REPO}:production-multiarch-${SHA}"
  {
    echo "source=build"
    echo "image=${REPO}:production-multiarch-${SHA}"
    echo "revision=${SHA}"
  } | tee -a "$OUT"
}

if [ "${FORCE_BUILD:-false}" = "true" ]; then
  emit_build "force_rebuild_production is set"
  exit 0
fi

RUNTIME_PATHS=()
while IFS= read -r p; do RUNTIME_PATHS+=("$p"); done < <(bash "$GATE" paths)

exists() { docker buildx imagetools inspect "$1" >/dev/null 2>&1; }

SOURCE=""
while read -r c; do
  if ! git diff --quiet "$c" "$SHA" -- "${RUNTIME_PATHS[@]}"; then
    echo "Runtime chain differs between ${c:0:12} and ${SHA:0:12}; no older image can match"
    break
  fi
  if exists "${REPO}:staging-multiarch-${c}" && exists "${REPO}:staging-docker-multiarch-${c}"; then
    SOURCE="$c"
    break
  fi
done < <(git rev-list --max-count="$MAX_COMMITS" "$SHA")

if [ -z "$SOURCE" ]; then
  emit_build "No staging multi-arch image matches this release's runtime chain"
  exit 0
fi

if [ "${DRY_RUN:-false}" = "true" ]; then
  echo "::notice::Would promote staging-multiarch-${SOURCE} (runtime chain identical to ${SHA:0:12})"
else
  echo "::notice::Promoting staging-multiarch-${SOURCE} (runtime chain identical to ${SHA:0:12})"
  docker buildx imagetools create --prefer-index=false \
    --tag "${REPO}:production-multiarch-${SOURCE}" \
    --tag "${REPO}:production-multiarch-latest" \
    "${REPO}:staging-multiarch-${SOURCE}"
  docker buildx imagetools create --prefer-index=false \
    --tag "${REPO}:production-docker-multiarch-${SOURCE}" \
    --tag "${REPO}:production-docker-multiarch-latest" \
    "${REPO}:staging-docker-multiarch-${SOURCE}"
fi

{
  echo "source=promoted"
  echo "image=${REPO}:production-multiarch-${SOURCE}"
  echo "revision=${SOURCE}"
} | tee -a "$OUT"
