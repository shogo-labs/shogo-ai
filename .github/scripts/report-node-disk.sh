#!/usr/bin/env bash
# .github/scripts/report-node-disk.sh
#
# Puts node disk on the record for every deploy (SHO-136).
#
# Why: the staging node that sat under DiskPressure on 2026-10-21 held 7
# `shogo-runtime` (9.95 GB each) and 13 `shogo-api` (5.11 GB) digests, and
# nothing in the pipeline showed that until a `kubectl` session. The only thing
# that ever reclaimed disk there was the eviction event itself. This prints the
# per-node numbers — and a WARNING at 70%, which is the level the kubelet now
# starts reclaiming at — so the approach is visible in the run summary before
# it becomes an incident.
#
# Never fails: it is telemetry. `.github/scripts/check-node-disk-headroom.sh`
# is the gate, and the warm-pool monitor is the 5-minute page.
#
# Usage:
#   report-node-disk.sh [warn_pct]           # default 70
# Env:
#   GITHUB_STEP_SUMMARY  the markdown table is appended here when set

set -uo pipefail

WARN_PCT="${1:-${WARN_PCT:-70}}"

if ! kubectl get nodes >/dev/null 2>&1; then
  echo "::warning::report-node-disk: cluster not reachable — no disk telemetry this run"
  exit 0
fi

ROWS=""
OVER=""
NA_IMAGEFS=""
while read -r node; do
  summary=$(kubectl get --raw "/api/v1/nodes/${node}/proxy/stats/summary" 2>/dev/null || true)
  if [[ -z "$summary" ]]; then
    ROWS+="| ${node} | ? | ? | ? | ? | ? |"$'\n'
    continue
  fi
  # `n/a` when the runtime exposes no separate imageFs: cri-o shares nodefs, so
  # reporting `0%` there was a fabricated measurement (SHO-136 QA round 1).
  read -r nodefs imagefs used cap <<<"$(echo "$summary" | jq -r '
    def used($fs): ($fs.usedBytes // 0) as $u | ($fs.capacityBytes // 0) as $c
      | if $c > 0 then (($u / $c) * 100 | floor | tostring) else "n/a" end;
    "\(used(.node.fs)) \(used(.node.runtime.imageFs)) \((.node.fs.usedBytes // 0) / 1e9 | floor) \((.node.fs.capacityBytes // 0) / 1e9 | floor)"
  ')"
  read -r img_gb img_count rt_digests api_digests <<<"$(kubectl get node "$node" -o json | jq -r '
    [.status.images[]? | select((.names // []) | length > 0)] as $i
    | "\(($i | map(.sizeBytes // 0) | add // 0) / 1e9 | floor) \($i | length) \([$i[] | select((.names | join(" ")) | test("/shogo-runtime|/agent-runtime"))] | length) \([$i[] | select((.names | join(" ")) | test("/shogo-api"))] | length)"
  ')"
  if [[ "$imagefs" =~ ^[0-9]+$ ]]; then
    imagefs_display="${imagefs}%"
  else
    imagefs_display="n/a"
    NA_IMAGEFS=1
  fi
  ROWS+="| ${node} | ${nodefs}% | ${imagefs_display} | ${used} / ${cap} GB | ${img_gb} GB (${img_count}) | ${rt_digests} / ${api_digests} |"$'\n'
  over=0
  [[ "$nodefs" =~ ^[0-9]+$ ]] && [[ "$nodefs" -ge "$WARN_PCT" ]] && over=1
  [[ "$imagefs" =~ ^[0-9]+$ ]] && [[ "$imagefs" -ge "$WARN_PCT" ]] && over=1
  if [[ "$over" -eq 1 ]]; then
    OVER+="${node} (nodefs ${nodefs}%, imagefs ${imagefs_display}); "
  fi
done < <(kubectl get nodes -o json | jq -r '.items[] | select(.spec.unschedulable != true) | .metadata.name')

PRESSURED=$(kubectl get nodes -o json | jq -r '
  [.items[] | select((.status.conditions // [])[] | select(.type == "DiskPressure" and .status == "True"))
   | .metadata.name] | join(", ")
')

TABLE=$(
  echo "### Node disk"
  echo
  echo "| node | nodefs used | imagefs used | nodefs used / capacity | images (total, count) | runtime / api digests |"
  echo "|---|---|---|---|---|---|"
  printf '%s' "$ROWS"
  if [[ -n "$NA_IMAGEFS" ]]; then
    echo
    echo "_imagefs \`n/a\`: the runtime exposes no separate image filesystem (cri-o shares nodefs), so image layers are counted in nodefs._"
  fi
)

echo "$TABLE"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  echo "$TABLE" >> "$GITHUB_STEP_SUMMARY"
fi

if [[ -n "$PRESSURED" ]]; then
  echo "::error::node(s) under DiskPressure: ${PRESSURED}"
fi
if [[ -n "$OVER" ]]; then
  echo "::warning::node(s) at or above ${WARN_PCT}% disk (kubelet image GC starts here): ${OVER%; }"
fi
exit 0
