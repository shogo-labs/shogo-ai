#!/usr/bin/env bash
# .github/scripts/check-node-disk-headroom.sh
#
# Deploy-time gate that catches the 2026-06-02 EU incident class: a node
# disk-exhaustion event BEFORE we patch the api ksvc into it.
#
# What happened in EU: the node pool ran 100 GB boot volumes while ~30 GB of
# stacked 8 GB runtime images sat on each node. The busiest nodes crossed the
# kubelet DiskPressure threshold (~85%), so the kubelet started evicting pods
# and garbage-collecting images. The new `api` revision could never reach its
# initial scale (pods stuck ContainerCreating / failing liveness), and the
# warm pool churned. The deploy only discovered this 10 minutes later via
# `ProgressDeadlineExceeded` — by which point the cluster was already in a
# self-sustaining storm.
#
# Running this BEFORE the ksvc patch turns that 10-minute mystery timeout into
# an immediate, actionable failure ("node X is at 88% disk").
#
# Fails the deploy if any Ready, schedulable node's LIVE measured disk usage
# (nodefs OR imagefs) is at/above THRESHOLD_PCT used — re-sampled so a brief
# spike doesn't abort the deploy (see below).
#
# Why live measurement and not the DiskPressure condition (runs 27391129442 /
# this remediation, 2026-06-11): the node.status DiskPressure condition is a
# LAGGING, latched signal — the kubelet only flips it back to False after its
# eviction-pressure-transition-period (default 5m) of sustained good state,
# and ongoing warm-pool churn keeps resetting that timer. We observed node
# 10.0.10.72 pinned DiskPressure=True while it actually had 96 GB / ~52% free.
# Hard-failing the whole multi-region deploy on that stale condition is a
# false abort. The kubelet stats summary (node.fs / node.runtime.imageFs) is
# the real-time truth of what a node can host, so that is authoritative here.
# The DiskPressure condition is consulted ONLY as a fallback when a node's
# live stats are unavailable.
#
# Re-sampling: warm-pool churn (pods Terminating, emptyDirs freeing, a fresh
# 8 GB runtime-image prepull landing) can spike a node's live usage for a few
# seconds and then recover. We re-check up to RETRY_ATTEMPTS times and only
# fail if a node is STILL over threshold on the final sample — a genuinely
# disk-starved node stays over, a transient spike clears. This keeps the
# original "block a starved cluster before the ksvc patch" guarantee while
# eliminating false aborts.
#
# Usage:
#   .github/scripts/check-node-disk-headroom.sh [threshold_pct]
# Env:
#   THRESHOLD_PCT   default 80  (kubelet's default DiskPressure eviction
#                                soft threshold is imagefs/nodefs available<15%,
#                                i.e. ~85% used; 80% leaves margin to deploy)
#   RETRY_ATTEMPTS  default 5   (total samples before giving up)
#   RETRY_INTERVAL  default 30  (seconds between samples)

set -euo pipefail

THRESHOLD_PCT="${1:-${THRESHOLD_PCT:-80}}"
RETRY_ATTEMPTS="${RETRY_ATTEMPTS:-5}"
RETRY_INTERVAL="${RETRY_INTERVAL:-30}"

# Evaluates current node disk headroom. Echoes human-readable per-node usage
# and any warning annotations, and returns 0 when the cluster is healthy or
# non-zero when at least one schedulable node is over-threshold.
#
# Live kubelet stats (node.fs = nodefs, node.runtime.imageFs = imagefs) are
# authoritative. The node.status DiskPressure condition is consulted ONLY for
# nodes whose live stats are unavailable, because that condition is a lagging,
# latched signal that can stay True long after a node has recovered headroom.
check_headroom() {
  local rc=0

  # Pre-fetch the DiskPressure condition once, for the stats-unavailable
  # fallback path only.
  local pressured_json
  pressured_json=$(kubectl get nodes -o json | jq -c '
    [.items[]
      | select((.status.conditions // [])[] | select(.type == "DiskPressure" and .status == "True"))
      | .metadata.name
    ]
  ')

  # Skip unschedulable (cordoned) nodes — they're intentionally drained and
  # shouldn't gate a deploy.
  local node summary pct
  for node in $(kubectl get nodes -o jsonpath='{range .items[?(@.spec.unschedulable!=true)]}{.metadata.name}{"\n"}{end}'); do
    summary=$(kubectl get --raw "/api/v1/nodes/${node}/proxy/stats/summary" 2>/dev/null || echo "")
    if [[ -z "$summary" ]]; then
      # No live truth — fall back to the (lagging) DiskPressure condition.
      if echo "$pressured_json" | jq -e --arg n "$node" 'index($n)' >/dev/null 2>&1; then
        echo "::warning::check-node-disk-headroom: node $node DiskPressure=True (live stats unavailable, using condition)"
        rc=1
      else
        echo "  $node: (stats unavailable, DiskPressure=False)"
      fi
      continue
    fi
    # Worst of nodefs and imagefs used%. imagefs is where the 8 GB runtime
    # image layers + container writable layers live and is usually the first
    # filesystem to fill; on shared-disk nodes it equals nodefs.
    pct=$(echo "$summary" | jq -r '
      def used($fs): ($fs.usedBytes // 0) as $u | ($fs.capacityBytes // 0) as $c
        | if $c > 0 then (($u / $c) * 100) else 0 end;
      [used(.node.fs), used(.node.runtime.imageFs // {})] | max | floor
    ')
    echo "  $node: ${pct}% used (worst of nodefs/imagefs)"
    if [[ "$pct" -ge "$THRESHOLD_PCT" ]]; then
      echo "::warning::check-node-disk-headroom: node $node at ${pct}% disk (>=${THRESHOLD_PCT}%)"
      rc=1
    fi
  done

  return "$rc"
}

echo "Checking node disk headroom (fail at >=${THRESHOLD_PCT}% live nodefs/imagefs used; re-sampling up to ${RETRY_ATTEMPTS}x every ${RETRY_INTERVAL}s to ride out transient flaps)..."

attempt=1
while true; do
  echo "--- sample ${attempt}/${RETRY_ATTEMPTS} ---"
  if check_headroom; then
    echo "✓ all schedulable nodes have disk headroom — safe to roll out"
    exit 0
  fi
  if [[ "$attempt" -ge "$RETRY_ATTEMPTS" ]]; then
    break
  fi
  echo "Node(s) over threshold — re-checking in ${RETRY_INTERVAL}s (transient warm-pool/eviction spikes self-clear; sustained starvation persists)..."
  sleep "$RETRY_INTERVAL"
  attempt=$((attempt + 1))
done

echo "::error::check-node-disk-headroom: node(s) still over disk threshold after ${RETRY_ATTEMPTS} samples over $(( (RETRY_ATTEMPTS - 1) * RETRY_INTERVAL ))s — this is sustained, not a transient flap."
echo "::error::Aborting before ksvc patch: a disk-starved cluster cannot roll out a new revision."
echo "Remediate node disk first (prune stale runtime images / scale or replace nodes / raise boot volume — see terraform/README.md 'Boot volume remediation')."
echo "::group::node images (largest, busiest node)"
kubectl get nodes -o json | jq -r '
  .items
  | max_by([.status.images[]?.sizeBytes] | add // 0)
  | .metadata.name as $n
  | "node \($n): " + (([.status.images[]?.sizeBytes] | add // 0) / 1e9 | tostring) + " GB of images"
' 2>/dev/null || true
echo "::endgroup::"
exit 1
