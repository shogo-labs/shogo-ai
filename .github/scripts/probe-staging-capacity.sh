#!/usr/bin/env bash
# .github/scripts/probe-staging-capacity.sh
#
# Records whether the staging cluster could carry an e2e run (SHO-136).
#
# The critical-path suite's reds were never a spec problem: a node reached
# DiskPressure during a deploy + one suite, and whichever specs landed on the
# saturated node timed out or got a 5xx. This probe is the evidence that lets
# `.github/scripts/e2e-classify.ts` say `environment:` instead of leaving a
# timeout looking like a product bug.
#
# It runs twice per e2e run:
#   before  — the `preflight` job, so a suite that STARTS on a degraded cluster
#             is distinguishable from one that degraded it
#   after   — the `postrun` job (`if: always()`), so the run's own footprint is
#             on the record too
#
# IT NEVER FAILS THE RUN. Its only job is to record. A red suite still reds the
# run; the classification decides whether that red is a platform defect.
#
# Usage:
#   probe-staging-capacity.sh --out .tmp/probe-before.json [--label before]
# Env:
#   API_NS / WP_NS    namespaces to probe (default: shogo-staging-system /
#                     shogo-staging-workspaces)
#   DISK_PCT          fail level for live nodefs/imagefs usage (default 70)
#   DOMAIN            api domain for the health check (default
#                     studio.staging.shogo.ai)
#
# Output: a JSON object on disk (and stdout) with
#   { diskOk, diskReason, warmPoolOk, warmPoolReason,
#     studioRevisionOk, studioRevisionReason, healthOk, healthReason }
# If the cluster is not reachable at all, no file is written: a missing probe
# reads as "unknown" in the classifier, never as "healthy".

set -uo pipefail

OUT=""
LABEL="before"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="${2:?--out needs a path}"; shift 2 ;;
    --label) LABEL="${2:?--label needs a value}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

: "${API_NS:=shogo-staging-system}"
: "${WP_NS:=shogo-staging-workspaces}"
: "${DISK_PCT:=70}"
: "${DOMAIN:=studio.staging.shogo.ai}"

echo "=== capacity probe (${LABEL}) — $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

if ! kubectl get nodes >/dev/null 2>&1; then
  echo "cluster not reachable from this runner — recording no probe (unknown, not healthy)"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo "### Capacity probe (${LABEL})"
      echo
      echo "Cluster not reachable from this runner — classification treats the probe as **unknown**."
    } >> "$GITHUB_STEP_SUMMARY"
  fi
  exit 0
fi

# ---------------------------------------------------------------- disk ------
# Live kubelet stats are authoritative (the DiskPressure condition is latched
# and lags a recovering node by up to eviction-pressure-transition-period).
DISK_REASON=""
DISK_LINES=""
while read -r node; do
  summary=$(kubectl get --raw "/api/v1/nodes/${node}/proxy/stats/summary" 2>/dev/null || true)
  if [[ -z "$summary" ]]; then
    DISK_REASON+="${node} (stats unavailable); "
    continue
  fi
  pct=$(echo "$summary" | jq -r '
    def used($fs): ($fs.usedBytes // 0) as $u | ($fs.capacityBytes // 0) as $c
      | if $c > 0 then (($u / $c) * 100) else 0 end;
    [used(.node.fs), used(.node.runtime.imageFs // {})] | max | floor
  ')
  used_gb=$(echo "$summary" | jq -r '((.node.fs.usedBytes // 0) / 1e9) | floor')
  cap_gb=$(echo "$summary" | jq -r '((.node.fs.capacityBytes // 0) / 1e9) | floor')
  DISK_LINES+="| ${node} | ${pct}% | ${used_gb} / ${cap_gb} GB |"$'\n'
  if [[ "$pct" -ge "$DISK_PCT" ]]; then
    DISK_REASON+="${node} at ${pct}% nodefs (>=${DISK_PCT}%); "
  fi
done < <(kubectl get nodes -o json | jq -r '.items[] | select(.spec.unschedulable != true) | .metadata.name')

PRESSURED=$(kubectl get nodes -o json | jq -r '
  [.items[] | select((.status.conditions // [])[] | select(.type == "DiskPressure" and .status == "True"))
   | .metadata.name] | join(", ")
')
if [[ -n "$PRESSURED" ]]; then
  DISK_REASON+="DiskPressure=True on ${PRESSURED}; "
fi
DISK_REASON="${DISK_REASON%; }"
DISK_OK=true
[[ -n "$DISK_REASON" ]] && DISK_OK=false

# ----------------------------------------------------------- warm pool ------
# Budget 0 + no settle: a single sample. The probe records the pool as it is
# now; it does not wait 10 minutes the way the deploy gate does.
WP_OUT=$(SETTLE=0 POLL_INTERVAL=1 .github/scripts/check-warm-pool-health.sh "$API_NS" "$WP_NS" 0 2>&1)
WP_RC=$?
echo "$WP_OUT" | sed 's/^/  /'
WARM_OK=true
WARM_REASON=""
if [[ "$WP_RC" -ne 0 ]]; then
  WARM_OK=false
  WARM_REASON=$(echo "$WP_OUT" | grep -E '^::error::' | head -1 | sed 's/^::error::[a-z-]*: //')
  WARM_REASON="${WARM_REASON:-warm pool unhealthy (check-warm-pool-health exit ${WP_RC})}"
fi

# check-warm-pool-health treats an EMPTY pool as a warning — right for a deploy
# that lands right after an incident wipe, wrong here. For capacity, an empty
# pool means every hosted test cold-boots a ~10 GB runtime image onto whichever
# node the scheduler picks, which is the load that filled a node in the first
# place. Record it as a breach.
if [[ "$WARM_OK" == true ]]; then
  WP_TOTAL=$(kubectl get ksvc -n "$WP_NS" -l shogo.io/warm-pool=true -o json 2>/dev/null | jq '.items | length' 2>/dev/null || echo 0)
  if [[ "${WP_TOTAL:-0}" -eq 0 ]]; then
    WARM_OK=false
    WARM_REASON="no warm-pool ksvcs in ${WP_NS} — every hosted test would cold-boot the runtime image"
  fi
fi

# ------------------------------------------------- studio single revision ---
# `studio-direct` selects EVERY studio revision; >1 Ready revision serves mixed
# builds. A deploy legitimately holds that state for a few minutes while the old
# revision drains — and the critical suite runs immediately after a deploy — so
# the same 15-minute rollout grace the warm-pool monitor uses applies here.
# Outside that window it is a breach.
GRACE_S=$(( ${ROLLOUT_GRACE_MIN:-15} * 60 ))
STUDIO_REVS=$(kubectl get pods -n "$API_NS" -l serving.knative.dev/service=studio -o json | jq -r '
  [.items[]
    | select((.status.conditions // [])[]? | select(.type == "Ready" and .status == "True"))
    | .metadata.labels["serving.knative.dev/revision"] // empty] | unique | join(", ")
')
STUDIO_COUNT=$(echo "$STUDIO_REVS" | awk -F', ' '{ print ($0 == "" ? 0 : NF) }')
STUDIO_OK=true
STUDIO_REASON=""
if [[ "$STUDIO_COUNT" -ne 1 ]]; then
  NEWEST_AGE_S=0
  if [[ "$STUDIO_COUNT" -gt 1 ]]; then
    REVS_JSON=$(printf '%s\n' "$STUDIO_REVS" | tr ',' '\n' | sed 's/^ *//' | jq -R . | jq -s .)
    NEWEST_AGE_S=$(kubectl get revisions -n "$API_NS" -o json | jq --argjson revs "$REVS_JSON" '
      [.items[] | select(.metadata.name as $n | $revs | index($n))
        | now - (.metadata.creationTimestamp | fromdateiso8601)] | min // 0 | floor
    ')
  fi
  if [[ "$STUDIO_COUNT" -gt 1 && "${NEWEST_AGE_S:-0}" -le "$GRACE_S" ]]; then
    echo "  studio spans ${STUDIO_COUNT} revisions [${STUDIO_REVS}] — newest is ${NEWEST_AGE_S}s old, inside the ${GRACE_S}s rollout grace"
  else
    STUDIO_OK=false
    STUDIO_REASON="studio has ${STUDIO_COUNT} Ready revision(s) [${STUDIO_REVS}] (newest ${NEWEST_AGE_S}s old) — expected exactly 1 outside the rollout grace"
  fi
fi

# ---------------------------------------------------------------- health ----
HEALTH_OKS=0
HEALTH_LAST="000"
for _ in 1 2 3; do
  HEALTH_LAST=$(curl -sf -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 15 "https://${DOMAIN}/api/health" 2>/dev/null) || HEALTH_LAST="000"
  [[ "$HEALTH_LAST" == "200" ]] && HEALTH_OKS=$((HEALTH_OKS + 1))
  sleep 2
done
HEALTH_OK=true
HEALTH_REASON=""
if [[ "$HEALTH_OKS" -ne 3 ]]; then
  HEALTH_OK=false
  HEALTH_REASON="api /api/health returned 200 on ${HEALTH_OKS}/3 attempts (last: ${HEALTH_LAST})"
fi

PROBE=$(jq -n \
  --argjson diskOk "$DISK_OK" --arg diskReason "$DISK_REASON" \
  --argjson warmPoolOk "$WARM_OK" --arg warmPoolReason "$WARM_REASON" \
  --argjson studioRevisionOk "$STUDIO_OK" --arg studioRevisionReason "$STUDIO_REASON" \
  --argjson healthOk "$HEALTH_OK" --arg healthReason "$HEALTH_REASON" \
  '{diskOk: $diskOk, diskReason: $diskReason,
    warmPoolOk: $warmPoolOk, warmPoolReason: $warmPoolReason,
    studioRevisionOk: $studioRevisionOk, studioRevisionReason: $studioRevisionReason,
    healthOk: $healthOk, healthReason: $healthReason}')

echo "$PROBE" | jq .
if [[ -n "$OUT" ]]; then
  mkdir -p "$(dirname "$OUT")"
  echo "$PROBE" > "$OUT"
fi

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### Capacity probe (${LABEL})"
    echo
    echo "| node | worst of nodefs/imagefs | nodefs used / capacity |"
    echo "|---|---|---|"
    printf '%s' "$DISK_LINES"
    echo
    echo "| check | result |"
    echo "|---|---|"
    echo "| node disk < ${DISK_PCT}% and no DiskPressure | $([[ $DISK_OK == true ]] && echo ✅ || echo "❌ ${DISK_REASON}") |"
    echo "| warm pool has a Ready ksvc | $([[ $WARM_OK == true ]] && echo ✅ || echo "❌ ${WARM_REASON}") |"
    echo "| exactly one Ready studio revision | $([[ $STUDIO_OK == true ]] && echo ✅ || echo "❌ ${STUDIO_REASON}") |"
    echo "| api /api/health 3 of 3 | $([[ $HEALTH_OK == true ]] && echo ✅ || echo "❌ ${HEALTH_REASON}") |"
  } >> "$GITHUB_STEP_SUMMARY"
fi

[[ "$DISK_OK" == true && "$WARM_OK" == true && "$STUDIO_OK" == true && "$HEALTH_OK" == true ]] \
  || echo "::warning::capacity probe (${LABEL}) found a degraded cluster — see the probe summary"
exit 0
