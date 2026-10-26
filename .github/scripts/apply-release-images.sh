#!/usr/bin/env bash
# .github/scripts/apply-release-images.sh
#
# Point a cluster at a set of already-built images. Shared by the staging and
# production deploy jobs (deploy.yml) and by rollback-production.yml, so a
# rollback runs exactly the rollout path every deploy exercises.
#
# In order:
#   1. pin the runtime image in the shogo-runtime-version configmap (read by
#      the warm-pool controller and the next deploy)
#   2. roll the image-prepuller onto it and block until every node has it
#      cached (wait-runtime-prepulled.sh — the 2026-06-02 cold-pull gate)
#   3. patch the studio / api / docs Knative services onto their images
#   4. retire stale studio revisions once the new one is Ready (2026-07-18
#      CSS-404 incident: studio-direct round-robins across every revision)
#   5. re-pin RUNTIME_IMAGE on the api ksvc via sync-api-env.sh (verified)
#
# Waiting for rollout / health checks stays with the caller: they differ per
# region.
#
# Env:
#   NS_SYSTEM, RUNTIME_TAG, RUNTIME_IMAGE        (required)
#   API_IMAGE, WEB_IMAGE, DOCS_IMAGE             (empty = leave that ksvc alone)
#   APP_VERSION        (optional) re-pin the studio's SHOGO_APP_VERSION and the
#                      api's APP_VERSION in the same patch as the image, so a
#                      rollback also reports the release it rolled back to
#   RETIRE_STALE_STUDIO  true to run step 4 (default: true when WEB_IMAGE set)

set -euo pipefail

: "${NS_SYSTEM:?NS_SYSTEM required}"
: "${RUNTIME_TAG:?RUNTIME_TAG required}"
: "${RUNTIME_IMAGE:?RUNTIME_IMAGE required}"
API_IMAGE="${API_IMAGE:-}"
WEB_IMAGE="${WEB_IMAGE:-}"
DOCS_IMAGE="${DOCS_IMAGE:-}"
APP_VERSION="${APP_VERSION:-}"
RETIRE_STALE_STUDIO="${RETIRE_STALE_STUDIO:-$([ -n "$WEB_IMAGE" ] && echo true || echo false)}"

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPTS/../.." && pwd)"

echo "::group::Pin runtime image ${RUNTIME_IMAGE}"
kubectl create configmap shogo-runtime-version \
  --namespace="$NS_SYSTEM" \
  --from-literal=image_tag="$RUNTIME_TAG" \
  --from-literal=image="$RUNTIME_IMAGE" \
  --dry-run=client -o yaml | kubectl apply -f -
sed -e "s|RUNTIME_IMAGE_PLACEHOLDER|${RUNTIME_IMAGE}|g" \
    -e "s|namespace: shogo-staging-system|namespace: ${NS_SYSTEM}|g" \
    "$REPO_ROOT/k8s/base/image-prepuller.yaml" | kubectl apply -f -
echo "::endgroup::"

"$SCRIPTS/wait-runtime-prepulled.sh" "$NS_SYSTEM"

patch_ksvc() {
  local name=$1 image=$2 version=${3:-} env_name=${4:-SHOGO_APP_VERSION}
  if [ -z "$image" ]; then
    echo "$name: no image given; leaving as is"
    return
  fi
  local spec
  if ! spec=$(kubectl get ksvc "$name" -n "$NS_SYSTEM" -o json 2>/dev/null); then
    echo "::warning::ksvc/$name not found in $NS_SYSTEM; skipping"
    return
  fi
  local ops
  ops=$(jq -n --arg image "$image" \
    '[{op: "replace", path: "/spec/template/spec/containers/0/image", value: $image}]')
  if [ -n "$version" ]; then
    local idx
    idx=$(jq -r --arg name "$env_name" '(.spec.template.spec.containers[0].env // []) | map(.name) | index($name) // -1' <<<"$spec")
    if [ "$idx" = "-1" ]; then
      ops=$(jq --arg n "$env_name" --arg v "$version" '. + [{op: "add", path: "/spec/template/spec/containers/0/env/-", value: {name: $n, value: $v}}]' <<<"$ops")
    else
      ops=$(jq --arg v "$version" --argjson i "$idx" '. + [{op: "replace", path: "/spec/template/spec/containers/0/env/\($i)/value", value: $v}]' <<<"$ops")
    fi
  fi
  echo "$name -> $image${version:+ ($env_name=$version)}"
  kubectl patch ksvc "$name" -n "$NS_SYSTEM" --type=json -p="$ops"
}

patch_ksvc studio "$WEB_IMAGE" "$APP_VERSION" SHOGO_APP_VERSION
patch_ksvc api "$API_IMAGE" "$APP_VERSION" APP_VERSION
patch_ksvc docs "$DOCS_IMAGE"

if [ "$RETIRE_STALE_STUDIO" = "true" ]; then
  echo "Waiting for studio ksvc to be Ready..."
  kubectl wait --for=condition=Ready ksvc/studio -n "$NS_SYSTEM" --timeout=300s
  LATEST=$(kubectl get ksvc studio -n "$NS_SYSTEM" -o jsonpath='{.status.latestReadyRevisionName}')
  if [ -z "$LATEST" ]; then
    echo "::error::studio has no latestReadyRevisionName; refusing to GC revisions."
    exit 1
  fi
  echo "Keeping latest-ready studio revision: $LATEST"
  STALE=$(kubectl get revisions -n "$NS_SYSTEM" -l serving.knative.dev/service=studio \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | grep -v "^${LATEST}$" || true)
  if [ -z "$STALE" ]; then
    echo "No stale studio revisions to delete."
  else
    echo "Deleting stale studio revisions:"; echo "$STALE"
    echo "$STALE" | xargs -r -n1 kubectl delete revision -n "$NS_SYSTEM" --ignore-not-found
  fi
fi

"$SCRIPTS/sync-api-env.sh" "$NS_SYSTEM" RUNTIME_IMAGE "$RUNTIME_IMAGE"
# Verify the release tag actually landed on ksvc/api (same post-patch check the
# RUNTIME_IMAGE pin gets). /health and /api/version report it, and admin
# analytics compares installs against it — a pod that reads 0.0.0 is invisible.
if [ -n "$APP_VERSION" ]; then
  "$SCRIPTS/sync-api-env.sh" "$NS_SYSTEM" APP_VERSION "$APP_VERSION"
fi
