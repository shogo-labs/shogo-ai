#!/usr/bin/env bash
# .github/scripts/check-warm-pool-health.sh
#
# Deploy-time gate that catches the 2026-05-27 incident class: api ksvc
# rolled out cleanly but the warm-pool controller can't actually mint
# healthy pods because RUNTIME_IMAGE points at a non-existent tag.
#
# Without this gate, the deploy completed green, the warm pool kept
# serving from the previous revision's pods (still warm in the OS layer),
# and 502s only started flowing into user traffic ~24 hours later when
# those pods scaled to zero or expired the warm-pool TTL.
#
# This script samples warm-pool state in the workspaces namespace AFTER
# the api ksvc is Ready (the warm-pool controller runs inside the api
# pod), and fails the deploy if:
#
#   * any warm-pool pod is in ImagePullBackOff / ErrImagePull /
#     CrashLoopBackOff (the canonical "image is broken" / "container
#     crashes on boot" failure modes for warm-pool minting)
#   * warm-pool ksvcs exist but 0 are Ready (controller is alive but
#     every pod is broken — same incident shape, slightly later state)
#
# Zero warm-pool ksvcs is treated as a warning, not an error: a fresh
# bootstrap or a deploy immediately after a `kubectl delete ksvc -l
# shogo.io/warm-pool=true` (incident remediation) will land here briefly.
#
# Usage:
#   .github/scripts/check-warm-pool-health.sh <api-ns> <workspaces-ns> [wait-seconds]

set -euo pipefail

API_NS="${1:?api namespace required}"
WP_NS="${2:?workspaces namespace required}"
WAIT_BEFORE_CHECK="${3:-90}"

# A second-line guard against the same regression PR #697 fixed in
# sync-api-env.sh: refuse to ship if any api ksvc env value still
# contains the kustomize overlay placeholder. Cheap (~1 kubectl get)
# and catches a regression class even if a future change to the sync
# step accidentally re-introduces silent-skip semantics.
echo "Auditing api ksvc env values in $API_NS for placeholder leaks..."
bad_envs=$(kubectl get ksvc api -n "$API_NS" -o json | jq -r '
  .spec.template.spec.containers[0].env // []
  | map(select((.value? // "") | type == "string" and contains("bootstrap")))
  | map("\(.name)=\(.value)")
  | join("; ")
')
if [[ -n "$bad_envs" ]]; then
  echo "::error::check-warm-pool-health: api ksvc has placeholder env value(s): $bad_envs"
  exit 1
fi

# The warm-pool controller's reconcile interval is 30s by default. A pod
# that fails to pull its image is classified as ImagePullBackOff by the
# kubelet within ~10s of creation. Wait long enough for at least one
# reconcile cycle plus image-pull headroom on a cold node, otherwise we
# risk a false-pass on a controller that simply hasn't started filling
# the pool yet.
echo "Sleeping ${WAIT_BEFORE_CHECK}s to let warm-pool controller reconcile..."
sleep "$WAIT_BEFORE_CHECK"

echo "Checking warm-pool health in $WP_NS"

ksvc_json=$(kubectl get ksvc -n "$WP_NS" -l "shogo.io/warm-pool=true" -o json)
total_count=$(echo "$ksvc_json" | jq '.items | length')
ready_count=$(echo "$ksvc_json" | jq '
  [.items[]
    | select(.status.conditions[]? | select(.type == "Ready" and .status == "True"))
  ] | length
')
echo "  warm-pool ksvcs: $ready_count Ready / $total_count total"

# Knative does not propagate the `shogo.io/warm-pool=true` label down to
# pods, but it does propagate `serving.knative.dev/service`. So we list
# all pods in the workspaces ns and filter by that label prefix.
broken=$(kubectl get pods -n "$WP_NS" -o json | jq -r '
  .items[]
  | select(.metadata.labels["serving.knative.dev/service"] // "" | startswith("warm-pool-"))
  | (
      ((.status.containerStatuses // []) + (.status.initContainerStatuses // []))
      | map(.state.waiting.reason? // "")
      | map(select(. == "ImagePullBackOff" or . == "ErrImagePull" or . == "CrashLoopBackOff"))
    ) as $bad
  | select(($bad | length) > 0)
  | "\(.metadata.name) [\($bad | join(","))]"
')
if [[ -n "$broken" ]]; then
  echo "::error::check-warm-pool-health: warm-pool pod(s) in BackOff state:"
  echo "$broken" | awk '{print "  " $0}'
  echo "::group::warm-pool pods (most recent 30)"
  kubectl get pods -n "$WP_NS" -o wide --sort-by=.metadata.creationTimestamp 2>&1 | tail -30 || true
  echo "::endgroup::"
  exit 1
fi

if [[ "$total_count" -eq 0 ]]; then
  echo "::warning::no warm-pool ksvcs exist yet — controller may still be reconciling, or pool was just wiped"
  exit 0
fi

if [[ "$ready_count" -lt 1 ]]; then
  echo "::error::check-warm-pool-health: $total_count warm-pool ksvcs exist but 0 are Ready"
  echo "::group::warm-pool ksvcs"
  kubectl get ksvc -n "$WP_NS" -l "shogo.io/warm-pool=true" 2>&1 || true
  echo "::endgroup::"
  exit 1
fi

echo "✓ warm pool healthy ($ready_count/$total_count ksvcs Ready, no broken pods)"
