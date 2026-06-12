#!/usr/bin/env bash
# .github/scripts/wait-runtime-prepulled.sh
#
# Deploy-time gate that closes the cold-pull-mid-rollout failure class
# (run 26865807851, 2026-06-02): the large runtime image was still being
# pulled onto nodes when the api / warm-pool Knative revisions were
# created, so those revisions raced the pull and lost — India's api
# revision never achieved initial scale (ProgressDeadlineExceeded) and
# EU's warm-pool ksvcs sat Ready=Unknown for the full health-gate budget.
#
# The image-prepuller DaemonSet (k8s/base/image-prepuller.yaml) runs one
# `sleep infinity` pod per node whose only job is to pull RUNTIME_IMAGE.
# A prepuller pod can only become Ready once its container image is
# pulled, so `kubectl rollout status daemonset/image-prepuller` is an
# accurate "runtime image is cached on every node" signal. It also
# naturally blocks on any freshly-joined node whose DaemonSet pod has not
# pulled yet (rollout status requires numberReady == desiredNumberScheduled).
#
# Budget (run 27385477476, 2026-06-11): the gate MUST keep blocking on a
# freshly-joined node — that is exactly what stops the api/warm-pool
# revisions from landing on a node where the image is not cached yet. The
# failure mode there was not the guarantee but the budget: the cluster
# autoscaler added a cold node ~7 min into the deploy, and that node needed
# ~1 min for CNI + ~6 min to pull the 8.3 GB runtime image + the postgres
# pull, which together overran the old 900s window. The default below is
# sized to absorb one cold-node-join landing partway through the deploy
# while preserving the "image cached on every node" guarantee. A genuinely
# stuck node still fails the gate (with per-node diagnostics) once the
# budget is exhausted.
#
# This MUST run AFTER "Deploy Image Prepuller" (which applies the new
# RUNTIME_IMAGE tag, triggering a rolling update of the DaemonSet) and
# BEFORE "Deploy Knative services" (which patches the api/warm-pool
# revisions onto that image).
#
# When the runtime image tag is unchanged, the DaemonSet pod template is
# identical, there is no rollout, and `rollout status` returns
# immediately — so this is a cheap no-op on api-only / web-only deploys.
#
# Usage:
#   .github/scripts/wait-runtime-prepulled.sh <system-ns> [timeout-seconds]

set -euo pipefail

NS="${1:?system namespace required}"
TIMEOUT="${2:-1800}"

DS=image-prepuller

if ! kubectl get daemonset "$DS" -n "$NS" >/dev/null 2>&1; then
  echo "::warning::wait-runtime-prepulled: DaemonSet $DS not found in $NS — skipping (prepuller not deployed)"
  exit 0
fi

echo "Waiting up to ${TIMEOUT}s for $DS to finish pulling the runtime image onto every node in $NS..."
if kubectl rollout status "daemonset/$DS" -n "$NS" --timeout="${TIMEOUT}s"; then
  echo "✓ runtime image prepulled on all nodes — safe to roll out Knative revisions"
  exit 0
fi

# Timed out: surface which nodes are still pulling so the failure is
# actionable instead of a 10-minute mystery downstream.
echo "::error::wait-runtime-prepulled: $DS did not finish pulling the runtime image within ${TIMEOUT}s"
echo "::group::image-prepuller pods (not Ready land on nodes still pulling)"
kubectl get pods -n "$NS" -l app.kubernetes.io/name=image-prepuller \
  -o wide --sort-by=.metadata.creationTimestamp 2>&1 || true
echo "::endgroup::"
echo "::group::not-ready image-prepuller pod descriptions"
NOT_READY=$(kubectl get pods -n "$NS" -l app.kubernetes.io/name=image-prepuller \
  -o json 2>/dev/null | jq -r '
  .items[]
  | select(
      ([.status.conditions[]? | select(.type == "Ready" and .status == "True")] | length) == 0
    )
  | .metadata.name
' || true)
if [[ -n "$NOT_READY" ]]; then
  while IFS= read -r pod; do
    [[ -z "$pod" ]] && continue
    kubectl describe pod "$pod" -n "$NS" 2>&1 | tail -25 || true
    echo "---"
  done <<< "$NOT_READY"
fi
echo "::endgroup::"
exit 1
