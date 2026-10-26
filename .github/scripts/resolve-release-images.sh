#!/usr/bin/env bash
# .github/scripts/resolve-release-images.sh
#
# Decide which image every service should run for this deploy, and write the
# answer to $GITHUB_OUTPUT for the "Apply Kubernetes manifests" and
# apply-release-images.sh steps.
#
# Two modes:
#
#   build   (staging, or a production `force_rebuild_production` dispatch)
#           The *_CHANGED flags come from detect-changes: an image is new
#           exactly when this run built it.
#
#   promote (PROMOTE=true: a production deploy that reuses the staging-built
#           images retagged by the promote-images job)
#           Every service gets the release tag. The runtime image is only
#           treated as changed when its DIGEST differs from what this cluster
#           already pins, so a release that didn't touch the runtime doesn't
#           re-roll the warm pool / prepuller for an identical image.
#
# For an unchanged service the image it already runs (PREV_*_IMAGE, saved
# before "Apply Kubernetes manifests" resets it to the overlay's :<env>-latest)
# is carried forward.
#
# Env:
#   NS_SYSTEM, OCIR_REGISTRY, IMAGE_TAG                     (required)
#   PROMOTE                                                 (true|false)
#   API_CHANGED, WEB_CHANGED, DOCS_CHANGED, RUNTIME_CHANGED (build mode)
#   PREV_API_IMAGE, PREV_WEB_IMAGE, PREV_DOCS_IMAGE
#   REGISTRY_USERNAME, REGISTRY_PASSWORD                    (promote mode)
#
# Outputs: runtime_changed, runtime_tag, runtime_image, api_changed,
#          web_changed, docs_changed, api_image, web_image, docs_image

set -euo pipefail

: "${NS_SYSTEM:?NS_SYSTEM required}"
: "${OCIR_REGISTRY:?OCIR_REGISTRY required}"
: "${IMAGE_TAG:?IMAGE_TAG required}"
PROMOTE="${PROMOTE:-false}"
OUT="${GITHUB_OUTPUT:-/dev/null}"

digest_of() {
  docker buildx imagetools inspect "$1" --format '{{json .Manifest}}' 2>/dev/null | jq -r '.digest // empty'
}

PREV_RUNTIME_TAG=$(kubectl get configmap shogo-runtime-version -n "$NS_SYSTEM" \
  -o jsonpath='{.data.image_tag}' 2>/dev/null || echo "")

if [ "$PROMOTE" = "true" ]; then
  : "${REGISTRY_USERNAME:?REGISTRY_USERNAME required in promote mode}"
  : "${REGISTRY_PASSWORD:?REGISTRY_PASSWORD required in promote mode}"
  echo "$REGISTRY_PASSWORD" | docker login "${OCIR_REGISTRY%%/*}" -u "$REGISTRY_USERNAME" --password-stdin >/dev/null

  API_CHANGED=true
  WEB_CHANGED=true
  DOCS_CHANGED=true
  for repo in shogo-api shogo-web shogo-docs shogo-runtime; do
    if [ -z "$(digest_of "${OCIR_REGISTRY}/shogo/${repo}:${IMAGE_TAG}")" ]; then
      echo "::error::${OCIR_REGISTRY}/shogo/${repo}:${IMAGE_TAG} does not exist; promote-images (and replicate-images for secondary regions) must run first"
      exit 1
    fi
  done

  NEW_RUNTIME_DIGEST=$(digest_of "${OCIR_REGISTRY}/shogo/shogo-runtime:${IMAGE_TAG}")
  CUR_RUNTIME_DIGEST=""
  if [ -n "$PREV_RUNTIME_TAG" ]; then
    CUR_RUNTIME_DIGEST=$(digest_of "${OCIR_REGISTRY}/shogo/shogo-runtime:${PREV_RUNTIME_TAG}" || true)
  fi
  if [ -n "$CUR_RUNTIME_DIGEST" ] && [ "$CUR_RUNTIME_DIGEST" = "$NEW_RUNTIME_DIGEST" ]; then
    RUNTIME_CHANGED=false
    echo "Runtime digest unchanged (${NEW_RUNTIME_DIGEST}); keeping ${PREV_RUNTIME_TAG}"
  else
    RUNTIME_CHANGED=true
    echo "Runtime digest ${CUR_RUNTIME_DIGEST:-<none>} -> ${NEW_RUNTIME_DIGEST}"
  fi
fi

if [ "${RUNTIME_CHANGED:-false}" = "true" ] || [ -z "$PREV_RUNTIME_TAG" ]; then
  RUNTIME_TAG="$IMAGE_TAG"
else
  RUNTIME_TAG="$PREV_RUNTIME_TAG"
fi

image_for() {
  local repo=$1 changed=$2 prev=$3
  if [ "$changed" = "true" ]; then
    echo "${OCIR_REGISTRY}/shogo/${repo}:${IMAGE_TAG}"
  else
    echo "$prev"
  fi
}

{
  echo "runtime_changed=${RUNTIME_CHANGED:-false}"
  echo "runtime_tag=${RUNTIME_TAG}"
  echo "runtime_image=${OCIR_REGISTRY}/shogo/shogo-runtime:${RUNTIME_TAG}"
  echo "api_changed=${API_CHANGED:-false}"
  echo "web_changed=${WEB_CHANGED:-false}"
  echo "docs_changed=${DOCS_CHANGED:-false}"
  echo "api_image=$(image_for shogo-api "${API_CHANGED:-false}" "${PREV_API_IMAGE:-}")"
  echo "web_image=$(image_for shogo-web "${WEB_CHANGED:-false}" "${PREV_WEB_IMAGE:-}")"
  echo "docs_image=$(image_for shogo-docs "${DOCS_CHANGED:-false}" "${PREV_DOCS_IMAGE:-}")"
} | tee -a "$OUT"
