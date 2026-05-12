#!/usr/bin/env bash
# =============================================================================
# recover-staging-runtime.sh
# =============================================================================
# One-shot recovery for the staging warm-pool wedged state described in the
# 2026-05-04 incident postmortem:
#   - Many warm-pool ksvc pinned to runtime digests pruned by Sunday's
#     cleanup-ocir.yml run → ImagePullBackOff "manifest unknown".
#   - cluster-autoscaler bound to a stale node pool OCID → cannot scale up.
#   - Both nodes at 95–99% memory request → no scheduling room.
#
# This script does NOT push a new runtime image — that's the responsibility
# of the deploy pipeline (`gh workflow run deploy.yml`), which after the
# follow-up changes will pin the warm-pool to the just-built immutable SHA
# tag. Run that first, THEN run this script to clear the broken state.
#
# Steps:
#   1. Confirm we're talking to the staging cluster.
#   2. List broken warm-pool ksvc (ksvc whose latest revision is failing OR
#      whose pods are in ImagePullBackOff/ErrImagePull).
#   3. Delete them. The warm-pool controller will recreate fresh ones using
#      the new RUNTIME_IMAGE env var (set by the api ksvc) — which the deploy
#      step pinned to the immutable :staging-<sha> tag.
#   4. Print whether CA is back to "node pool found" state.
#
# Usage:
#   ./scripts/recover-staging-runtime.sh           # dry-run by default
#   APPLY=true ./scripts/recover-staging-runtime.sh
# =============================================================================

set -uo pipefail

CTX="${KUBECONTEXT:-oke-staging}"
NS="${WORKSPACES_NS:-shogo-staging-workspaces}"
SYSTEM_NS="${SYSTEM_NS:-shogo-staging-system}"
APPLY="${APPLY:-false}"

echo "Context: $CTX"
echo "Workspaces namespace: $NS"
echo "System namespace: $SYSTEM_NS"
echo "Apply mode: $APPLY (set APPLY=true to actually delete)"
echo ""

if ! kubectl --context="$CTX" get nodes >/dev/null 2>&1; then
  echo "! Cannot reach cluster $CTX" >&2
  exit 1
fi

# 1. Sanity check
NODE_COUNT=$(kubectl --context="$CTX" get nodes -o name | wc -l | tr -d ' ')
echo "Cluster reachable. $NODE_COUNT node(s)."

# 2. Identify broken ksvc
echo ""
echo "Identifying broken warm-pool ksvc…"
BROKEN_FILE=$(mktemp)
trap 'rm -f "$BROKEN_FILE"' EXIT

# (a) ksvc whose latest revision is False/Unknown
kubectl --context="$CTX" -n "$NS" get ksvc -o json 2>/dev/null \
  | jq -r '.items[]
      | select(((.status.conditions // []) | map(select(.type=="Ready"))[0].status) != "True")
      | .metadata.name' >> "$BROKEN_FILE" || true

# (b) ksvc whose pods are in ImagePullBackOff/ErrImagePull (the latched-True trap)
kubectl --context="$CTX" -n "$NS" get pods -o json 2>/dev/null \
  | jq -r '.items[]
      | select(.metadata.labels["serving.knative.dev/service"])
      | . as $p
      | (((.status.containerStatuses // []) + (.status.initContainerStatuses // []))
          | map(select(.state.waiting.reason | tostring | test("ImagePullBackOff|ErrImagePull|InvalidImageName|CreateContainerError")))
          | length) as $bad
      | select($bad > 0)
      | $p.metadata.labels["serving.knative.dev/service"]' >> "$BROKEN_FILE" || true

sort -u -o "$BROKEN_FILE" "$BROKEN_FILE"

BROKEN_COUNT=$(wc -l < "$BROKEN_FILE" | tr -d ' ')
echo "  $BROKEN_COUNT broken ksvc found:"
sed 's/^/    /' "$BROKEN_FILE"

if [ "$BROKEN_COUNT" -eq 0 ]; then
  echo "  Nothing to delete."
else
  echo ""
  if [ "$APPLY" = "true" ]; then
    echo "Deleting broken ksvc…"
    while IFS= read -r name; do
      [ -z "$name" ] && continue
      kubectl --context="$CTX" -n "$NS" delete ksvc "$name" --wait=false || true
    done < "$BROKEN_FILE"
    echo "  Deletion requested. Warm-pool controller will replace them on next reconcile."
  else
    echo "DRY RUN — would delete the ksvc above. Re-run with APPLY=true."
  fi
fi

# 3. Check that the api ksvc has a SHA-pinned RUNTIME_IMAGE
echo ""
echo "Checking api ksvc RUNTIME_IMAGE…"
RT_IMG=$(kubectl --context="$CTX" -n "$SYSTEM_NS" get ksvc api -o json 2>/dev/null \
  | jq -r '.spec.template.spec.containers[0].env[] | select(.name=="RUNTIME_IMAGE") | .value // empty')
if [ -z "$RT_IMG" ]; then
  echo "  ! RUNTIME_IMAGE env var not set on api ksvc"
elif [[ "$RT_IMG" == *":staging-latest"* ]] || [[ "$RT_IMG" == *":production-latest"* ]]; then
  echo "  ! RUNTIME_IMAGE is using mutable tag: $RT_IMG"
  echo "    Re-run a deploy first; otherwise the new warm pods will recreate the same trap."
else
  echo "  OK: $RT_IMG"
fi

# 4. cluster-autoscaler binding sanity
echo ""
echo "Checking cluster-autoscaler binding…"
CA_LOG=$(kubectl --context="$CTX" -n kube-system logs deploy/cluster-autoscaler --tail=200 2>/dev/null || true)
if echo "$CA_LOG" | grep -q "node pool not found for instance"; then
  echo "  ! CA still cannot find node pool for current nodes."
  echo "    Update GitHub Actions environment variable NODE_POOL_OCID for"
  echo "    'staging' to the OCID of the running node pool, then re-deploy"
  echo "    (the deploy will rollout-restart the CA)."
else
  echo "  OK: CA logs show no 'node pool not found' errors in the last 200 lines."
fi

echo ""
echo "Memory pressure (top 3 nodes by request %):"
# Portable awk (no gawk-specific 3-arg match). `kubectl describe node` lists
# memory three times: Capacity, Allocatable, and Allocated resources. Only
# the third has parens — and within that line, the FIRST percentage is the
# request %, the second is the limit %. Pluck just the first.
kubectl --context="$CTX" describe nodes 2>/dev/null \
  | awk '
      /^Name:/ { node=$2 }
      /^  memory +.*\([0-9]+%\)/ {
        line=$0
        sub(/^[^(]*\(/, "", line)   # strip up to first "("
        sub(/%\).*/, "", line)       # strip after first "%)"
        print line "%\t" node
      }' | sort -nr | head -3 || true
