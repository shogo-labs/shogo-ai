#!/usr/bin/env bash
# .github/scripts/reconcile-published-sites.sh
#
# Find (and, with --apply, remove) published sites whose project is gone.
#
# SHO-138: deleting a project used to leave its site serving. The delete hook
# now tears the site down, so nothing new leaks — this sweep is for what already
# leaked (11 orphan `published-*` ksvcs in prod-EU at the time of the card) and
# for a teardown step that failed silently on a bad day. The decision logic and
# the teardown live in the API (which can see both the substrate inventory and
# the DB); this script just runs it inside the cluster and prints the report.
#
# DRY RUN BY DEFAULT. `--apply` is the destructive mode and the first prod run
# waits for Russell's explicit yes in the card thread (see SHO-138).
#
# Usage:
#   .github/scripts/reconcile-published-sites.sh <api-pod>
#   .github/scripts/reconcile-published-sites.sh <api-pod> --apply
#   .github/scripts/reconcile-published-sites.sh <api-pod> --json
#
# <api-pod> is `kubectl get pod -n <ns> -l serving.knative.dev/service=api -o name | head -1`.
#
# Requirements: the api pod must have PUBLISHED_SITE_SWEEP_SECRET set (the
# endpoint is disabled otherwise), and — for the cross-region guard — the peer
# api URLs in PUBLISHED_SITE_SWEEP_PEERS (comma separated).

set -euo pipefail

POD="${1:?api pod name required (e.g. pod/api-00205-deployment-abc)}"
shift || true

APPLY=0
JSON=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --json) JSON=1 ;;
    *) echo "::error::unknown argument: $arg" >&2; exit 2 ;;
  esac
done

SECRET=$(kubectl exec "$POD" -- printenv PUBLISHED_SITE_SWEEP_SECRET 2>/dev/null || true)
if [[ -z "$SECRET" ]]; then
  echo "::error::PUBLISHED_SITE_SWEEP_SECRET is not set on $POD — the sweep endpoint is disabled"
  exit 1
fi

DRY_RUN=true
[[ "$APPLY" == "1" ]] && DRY_RUN=false

echo "published-site sweep — $( [[ "$DRY_RUN" == "true" ]] && echo 'DRY RUN (nothing deleted)' || echo 'APPLY (deleting)')"

RESPONSE=$(kubectl exec "$POD" -- \
  curl -sS -X POST http://localhost:3000/api/internal/published-sites/sweep \
    -H 'content-type: application/json' \
    -H "x-published-sweep-secret: $SECRET" \
    -d "{\"dryRun\": $DRY_RUN}")

if [[ "$JSON" == "1" ]]; then
  echo "$RESPONSE"
  exit 0
fi

# jq is available in the api image for the ops scripts; fall back to a plain
# dump rather than failing the run on a pod without it.
if ! command -v jq >/dev/null 2>&1; then
  echo "$RESPONSE"
  exit 0
fi

echo "$RESPONSE" | jq -r '
  "region: \(.region // "unknown")  peers: \(.peers // 0)  dryRun: \(.dryRun)",
  (if (.rowCoverageComplete == false) then "row coverage: INCOMPLETE — nothing is selectable until every peer region answers (set PUBLISHED_SITE_SWEEP_PEERS, or PUBLISHED_SITE_SWEEP_SINGLE_REGION=true if there is genuinely no peer)" else empty end),
  (if .blocked then "BLOCKED: \(.blocked) — \(.message // "")" else empty end),
  (if .dryRun then "would remove:" else "removed:" end),
  (if .dryRun then (.selected[] | "  \(.projectId)  \(.subdomain)  (\(.substrate), \(.reason))")
   else (.tornDown[] | "  \(.projectId)  \(.subdomain)") end),
  (if (.failed | length) > 0 then "failed:" else empty end),
  (.failed[] | "  \(.projectId)  \(.subdomain): \(.error)"),
  "kept: \(.skipped | length) (has-subdomain/publishing/too-young/no-subdomain/row-coverage-incomplete)"
'

# An apply that refused is a failure of the run, not a quiet no-op: the peer
# configuration has to be fixed before the sweep may delete anything.
if [[ "$(echo "$RESPONSE" | jq -r '.blocked // empty')" == "row-coverage-incomplete" ]]; then
  echo "::error::sweep apply refused — project rows for every region were not available (peer regions unreachable or unconfigured)"
  exit 1
fi

REMOVED=$(echo "$RESPONSE" | jq '.selected | length')
echo "→ $REMOVED site(s) $( [[ "$DRY_RUN" == "true" ]] && echo 'would be removed' || echo 'removed')"
if [[ "$DRY_RUN" == "true" && "$REMOVED" != "0" ]]; then
  echo "   re-run with --apply after Russell's yes in the card thread"
fi
