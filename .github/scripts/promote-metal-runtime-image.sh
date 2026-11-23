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
# The release's own SDK (SHO-522)
# -------------------------------
# A main-push build pins whatever `@shogo-ai/sdk` was `latest` at build time —
# for a release that is the PREVIOUS release's SDK. Only a build of the tag
# itself pins the tag's own SDK. So when SDK_PIN is set (a production release
# on a `vX.Y.Z` tag):
#
#   1. Wait (bounded) for `release-multiarch-<SHA>` +
#      `release-docker-multiarch-<SHA>` — the tags runtime-multiarch.yml adds
#      ONLY on a tag build, so no concurrent main-push build can overwrite
#      them — and promote those.
#   2. Otherwise walk back as before, but skip any candidate whose
#      `org.opencontainers.image.sdk-pin` label names a different version: that
#      image would ship the previous SDK to every app it seeds. Images built
#      before the label existed (no label) are still accepted, exactly as
#      before.
#   3. If nothing qualifies, nothing is retagged and the caller builds
#      `production-multiarch-<SHA>` from scratch instead.
#
# Env:
#   SHA            release commit (required)
#   REGISTRY       <region>.ocir.io/<namespace> (required, already logged in)
#   FORCE_BUILD    true to skip promotion
#   DRY_RUN        true to report the choice without retagging anything
#   MAX_COMMITS    how far back to look (default 200)
#   SDK_PIN        release SDK version (e.g. 2.6.1) to require; empty = no check
#   SDK_PIN_WAIT_SECONDS  how long to wait for this tag's own build (default 2400)
#
# Outputs: source (promoted|build), image, revision

set -euo pipefail

: "${SHA:?SHA required}"
: "${REGISTRY:?REGISTRY required}"
MAX_COMMITS="${MAX_COMMITS:-200}"
SDK_PIN="${SDK_PIN:-}"
SDK_PIN_WAIT_SECONDS="${SDK_PIN_WAIT_SECONDS:-2400}"
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

# The SDK version an image was built with, from the label runtime-multiarch.yml
# stamps on every image ('' when the image predates labels).
sdk_pin_of() {
  local ref="$1" digest
  digest="$(docker buildx imagetools inspect --raw "$ref" 2>/dev/null \
    | jq -r '.manifests[]? | select(.platform.architecture=="arm64") | .digest' 2>/dev/null | head -n1 || true)"
  if [ -z "$digest" ] || [ "$digest" = "null" ]; then
    # Not a manifest list — read the config of the tag itself.
    docker buildx imagetools inspect "$ref" --format '{{json .Image}}' 2>/dev/null \
      | jq -r '.config.Labels["org.opencontainers.image.sdk-pin"] // empty' 2>/dev/null || true
    return 0
  fi
  docker buildx imagetools inspect "${ref%:*}@${digest}" --format '{{json .Image}}' 2>/dev/null \
    | jq -r '.config.Labels["org.opencontainers.image.sdk-pin"] // empty' 2>/dev/null || true
}

# A candidate only ships the SDK we want if its label says so. No label (older
# image) keeps the previous behaviour rather than forcing a 90-minute rebuild.
candidate_ok() {
  local tag="$1" pin
  [ -z "$SDK_PIN" ] && return 0
  pin="$(sdk_pin_of "${REPO}:${tag}")"
  if [ -z "$pin" ]; then
    echo "::notice::${tag} carries no sdk-pin label (built before SHO-522) — accepting it"
    return 0
  fi
  if [ "$pin" = "$SDK_PIN" ]; then
    return 0
  fi
  echo "::notice::${tag} pins @shogo-ai/sdk ${pin}, not the release's ${SDK_PIN} — skipping"
  return 1
}

RUNTIME_PATHS=()
while IFS= read -r p; do RUNTIME_PATHS+=("$p"); done < <(bash "$GATE" paths)

exists() { docker buildx imagetools inspect "$1" >/dev/null 2>&1; }

SOURCE=""
SRC_PREFIX="staging"

# 1. This release's own tag build, if runtime-multiarch.yml has published it.
if [ -n "$SDK_PIN" ] && [ "${DRY_RUN:-false}" != "true" ]; then
  DEADLINE=$(( $(date +%s) + SDK_PIN_WAIT_SECONDS ))
  WAITED=0
  while :; do
    if exists "${REPO}:release-multiarch-${SHA}" && exists "${REPO}:release-docker-multiarch-${SHA}"; then
      SOURCE="$SHA"
      SRC_PREFIX="release"
      echo "::notice::This tag's own build (${SHA:0:12}) is published — it pins @shogo-ai/sdk ${SDK_PIN}"
      break
    fi
    if [ "$(date +%s)" -ge "$DEADLINE" ]; then
      echo "::notice::No release-multiarch-${SHA:0:12} after ${WAITED}s — falling back to the newest matching staging build"
      break
    fi
    sleep 30
    WAITED=$(( WAITED + 30 ))
  done
fi

# 2. Otherwise the newest older commit whose runtime chain matches AND whose
#    SDK pin is the release's.
if [ -z "$SOURCE" ]; then
  while read -r c; do
    if ! git diff --quiet "$c" "$SHA" -- "${RUNTIME_PATHS[@]}"; then
      echo "Runtime chain differs between ${c:0:12} and ${SHA:0:12}; no older image can match"
      break
    fi
    if exists "${REPO}:staging-multiarch-${c}" && exists "${REPO}:staging-docker-multiarch-${c}"; then
      if ! candidate_ok "staging-multiarch-${c}"; then
        continue
      fi
      SOURCE="$c"
      break
    fi
  done < <(git rev-list --max-count="$MAX_COMMITS" "$SHA")
fi

if [ -z "$SOURCE" ]; then
  if [ -n "$SDK_PIN" ]; then
    emit_build "No runtime image pins @shogo-ai/sdk ${SDK_PIN} for this release's runtime chain"
  else
    emit_build "No staging multi-arch image matches this release's runtime chain"
  fi
  exit 0
fi

if ! candidate_ok "${SRC_PREFIX}-multiarch-${SOURCE}"; then
  emit_build "${SRC_PREFIX}-multiarch-${SOURCE} does not pin @shogo-ai/sdk ${SDK_PIN}"
  exit 0
fi

if [ "$SRC_PREFIX" = "release" ]; then
  WHY="this release's own tag build"
else
  WHY="runtime chain identical to ${SHA:0:12}"
fi

if [ "${DRY_RUN:-false}" = "true" ]; then
  echo "::notice::Would promote ${SRC_PREFIX}-multiarch-${SOURCE} (${WHY})"
else
  echo "::notice::Promoting ${SRC_PREFIX}-multiarch-${SOURCE} (${WHY})"
  docker buildx imagetools create --prefer-index=false \
    --tag "${REPO}:production-multiarch-${SOURCE}" \
    --tag "${REPO}:production-multiarch-latest" \
    "${REPO}:${SRC_PREFIX}-multiarch-${SOURCE}"
  docker buildx imagetools create --prefer-index=false \
    --tag "${REPO}:production-docker-multiarch-${SOURCE}" \
    --tag "${REPO}:production-docker-multiarch-latest" \
    "${REPO}:${SRC_PREFIX}-docker-multiarch-${SOURCE}"
fi

{
  echo "source=promoted"
  echo "image=${REPO}:production-multiarch-${SOURCE}"
  echo "revision=${SOURCE}"
} | tee -a "$OUT"
