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
# Total readiness budget (seconds). The check polls within this window and
# only fails if the pool still reports 0 Ready at the end — see the polling
# loop below. Terminal BackOff/CrashLoop pods still fail fast regardless.
WAIT_BEFORE_CHECK="${3:-600}"

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

# Detect warm-pool pods that are *genuinely* broken — ImagePullBackOff /
# ErrImagePull / CrashLoopBackOff are the canonical "image is broken" /
# "container crashes on boot" failure modes. These are terminal: more
# waiting won't fix them, so finding any one of them fails immediately.
#
# Knative does not propagate the `shogo.io/warm-pool=true` label down to
# pods, but it does propagate `serving.knative.dev/service`. So we list
# all pods in the workspaces ns and filter by that label prefix.
broken_warm_pool_pods() {
  kubectl get pods -n "$WP_NS" -o json | jq -r '
    .items[]
    | select(.metadata.labels["serving.knative.dev/service"] // "" | startswith("warm-pool-"))
    | (
        ((.status.containerStatuses // []) + (.status.initContainerStatuses // []))
        | map(.state.waiting.reason? // "")
        | map(select(. == "ImagePullBackOff" or . == "ErrImagePull" or . == "CrashLoopBackOff"))
      ) as $bad
    | select(($bad | length) > 0)
    | "\(.metadata.name) [\($bad | join(","))]"
  '
}

# Poll for warm-pool readiness instead of sampling once. A single sleep+check
# false-fails the deploy whenever the warm-pool ksvcs are still converging
# (e.g. their revisions are cold-pulling the large runtime image onto freshly
# scaled nodes in a secondary region — observed as Ready=Unknown /
# RevisionMissing for a few minutes). We keep failing FAST on terminal BackOff
# pods, but otherwise give the pool the full window to report ≥1 Ready before
# declaring the deploy unhealthy.
#
# WAIT_BEFORE_CHECK (3rd arg) is the total budget; POLL_INTERVAL controls the
# cadence. Defaults: settle 30s, then poll every 20s up to ~10min total.
POLL_INTERVAL="${POLL_INTERVAL:-20}"
SETTLE="${SETTLE:-30}"

echo "Letting warm-pool controller settle for ${SETTLE}s, then polling up to ${WAIT_BEFORE_CHECK}s for readiness..."
sleep "$SETTLE"

deadline=$(( $(date +%s) + WAIT_BEFORE_CHECK ))
total_count=0
ready_count=0
while :; do
  # Terminal failure: a broken pod will never recover by waiting.
  broken=$(broken_warm_pool_pods)
  if [[ -n "$broken" ]]; then
    echo "::error::check-warm-pool-health: warm-pool pod(s) in BackOff state:"
    echo "$broken" | awk '{print "  " $0}'
    echo "::group::warm-pool pods (most recent 30)"
    kubectl get pods -n "$WP_NS" -o wide --sort-by=.metadata.creationTimestamp 2>&1 | tail -30 || true
    echo "::endgroup::"
    exit 1
  fi

  ksvc_json=$(kubectl get ksvc -n "$WP_NS" -l "shogo.io/warm-pool=true" -o json)
  total_count=$(echo "$ksvc_json" | jq '.items | length')
  ready_count=$(echo "$ksvc_json" | jq '
    [.items[]
      | select(.status.conditions[]? | select(.type == "Ready" and .status == "True"))
    ] | length
  ')
  echo "  warm-pool ksvcs: $ready_count Ready / $total_count total (t-$(( deadline - $(date +%s) ))s)"

  # Healthy as soon as the pool has at least one Ready ksvc and nothing broken.
  if [[ "$ready_count" -ge 1 ]]; then
    echo "✓ warm pool healthy ($ready_count/$total_count ksvcs Ready, no broken pods)"
    exit 0
  fi

  if [[ "$(date +%s)" -ge "$deadline" ]]; then
    break
  fi
  sleep "$POLL_INTERVAL"
done

# Zero warm-pool ksvcs is a warning, not an error: a fresh bootstrap or a
# deploy immediately after `kubectl delete ksvc -l shogo.io/warm-pool=true`
# (incident remediation) legitimately lands here.
if [[ "$total_count" -eq 0 ]]; then
  echo "::warning::no warm-pool ksvcs exist after ${WAIT_BEFORE_CHECK}s — controller may still be reconciling, or pool was just wiped"
  exit 0
fi

echo "::error::check-warm-pool-health: $total_count warm-pool ksvcs exist but 0 are Ready after ${WAIT_BEFORE_CHECK}s"
echo "::group::warm-pool ksvcs"
kubectl get ksvc -n "$WP_NS" -l "shogo.io/warm-pool=true" 2>&1 || true
echo "::endgroup::"
exit 1
