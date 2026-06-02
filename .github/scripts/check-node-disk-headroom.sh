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
# Fails the deploy if either:
#   * any Ready, schedulable node already reports DiskPressure=True, OR
#   * any such node's root filesystem is at/above THRESHOLD_PCT used.
#
# Usage:
#   .github/scripts/check-node-disk-headroom.sh [threshold_pct]
# Env:
#   THRESHOLD_PCT  default 80  (kubelet's default DiskPressure eviction
#                               soft threshold is imagefs/nodefs available<15%,
#                               i.e. ~85% used; 80% leaves margin to deploy)

set -euo pipefail

THRESHOLD_PCT="${1:-${THRESHOLD_PCT:-80}}"
rc=0

echo "Checking node disk headroom (fail at >=${THRESHOLD_PCT}% used or DiskPressure=True)..."

# 1) DiskPressure condition — the authoritative kubelet signal.
pressured=$(kubectl get nodes -o json | jq -r '
  [.items[]
    | select((.status.conditions // [])[] | select(.type == "DiskPressure" and .status == "True"))
    | .metadata.name
  ] | join(" ")
')
if [[ -n "$pressured" ]]; then
  echo "::error::check-node-disk-headroom: node(s) under DiskPressure: $pressured"
  rc=1
fi

# 2) Root filesystem usage per node via the kubelet stats summary API.
# Skip unschedulable (cordoned) nodes — they're intentionally drained and
# shouldn't gate a deploy.
for node in $(kubectl get nodes -o jsonpath='{range .items[?(@.spec.unschedulable!=true)]}{.metadata.name}{"\n"}{end}'); do
  summary=$(kubectl get --raw "/api/v1/nodes/${node}/proxy/stats/summary" 2>/dev/null || echo "")
  if [[ -z "$summary" ]]; then
    echo "  $node: (stats unavailable, relying on DiskPressure condition)"
    continue
  fi
  pct=$(echo "$summary" | jq -r '
    (.node.fs.usedBytes // 0) as $u
    | (.node.fs.capacityBytes // 0) as $c
    | if $c > 0 then (($u / $c) * 100 | floor) else 0 end
  ')
  echo "  $node: ${pct}% used"
  if [[ "$pct" -ge "$THRESHOLD_PCT" ]]; then
    echo "::error::check-node-disk-headroom: node $node at ${pct}% disk (>=${THRESHOLD_PCT}%)"
    rc=1
  fi
done

if [[ "$rc" -ne 0 ]]; then
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
fi

exit "$rc"
