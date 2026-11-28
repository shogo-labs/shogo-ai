#!/usr/bin/env bash
# .github/scripts/gc-old-api-revisions.sh
#
# Knative keeps obsolete revisions around indefinitely under
# config-gc's default retention policy. With `min-scale: 2` on the api
# ksvc, those obsolete revisions also keep pods alive — and each api pod
# runs an independent warm-pool controller. The result is a multi-
# reconciler race where every revision's controller deletes warm-pool
# pods created by the others. This was the US half of the 2026-05-27
# 502 incident: api-00202 (production-bootstrap config) was still
# running pods alongside api-00205 (correct config), each tearing down
# the other's warm-pool work, churning the pool until it ran dry.
#
# Deleting a Revision does not remove the activator's per-revision
# concurrency reporter. The activator keeps ticking that reporter for the
# revision name that no longer exists and logs `Error while getting
# revision` every time, for as long as the pod lives. By 2026-11-28 two
# activator pods were writing ~5.2M severity_text=ERROR rows per 24h —
# 99.8% of the plane's error volume, ~420x the api pods' genuine error
# bucket (12.4k) — and it was still growing ~1.3M rows/day, which drowned
# every severity-filtered error read. That is why this script rolls the
# activator after it deletes something: the reporters die with the pod.
# Do not delete that block as "unnecessary churn" — it is the only
# mechanism for the class (no SigNoz rule and no collector drop was
# added on purpose: with the reporters gone the class is zero, so a rule
# would monitor a void).
#
# At the end of every successful deploy, prune all api revisions except
# the latestReadyRevisionName (currently serving traffic) and the
# latestCreatedRevisionName (in case a roll is mid-flight). Knative's
# revision controller GCs the underlying Deployment + ReplicaSet + pods
# when the Revision object is deleted.
#
# This script is intentionally idempotent and safe to re-run: if there
# are no old revisions, it's a no-op.
#
# Usage:
#   .github/scripts/gc-old-api-revisions.sh <namespace>

set -euo pipefail

NS="${1:?namespace required}"

LATEST_READY=$(kubectl get ksvc api -n "$NS" -o jsonpath='{.status.latestReadyRevisionName}')
LATEST_CREATED=$(kubectl get ksvc api -n "$NS" -o jsonpath='{.status.latestCreatedRevisionName}')

# Refuse to GC if the ksvc has no Ready revision yet — that shape means
# the deploy is broken (Wait for rollout should have caught it). Better
# to leave the cluster alone than to delete the only pods serving
# traffic.
if [[ -z "$LATEST_READY" ]]; then
  echo "::error::gc-old-api-revisions: api ksvc in $NS has no latestReadyRevisionName — refusing to GC"
  exit 1
fi

if [[ -n "$LATEST_CREATED" && "$LATEST_CREATED" != "$LATEST_READY" ]]; then
  echo "Keeping api revisions: $LATEST_READY (Ready), $LATEST_CREATED (latestCreated)"
else
  echo "Keeping api revision: $LATEST_READY (Ready)"
fi

deleted=0
while read -r rev; do
  [[ -z "$rev" ]] && continue
  if [[ "$rev" == "$LATEST_READY" || "$rev" == "$LATEST_CREATED" ]]; then
    continue
  fi
  echo "  deleting obsolete revision $rev"
  kubectl delete revision -n "$NS" "$rev" --wait=false
  deleted=$((deleted + 1))
done < <(kubectl get revision -n "$NS" -l "serving.knative.dev/service=api" \
          -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')

# Only when something was actually deleted: a deploy with nothing to GC must
# not roll the activator (that would be a cold-start blip for nothing).
# --wait=false for the same reason the deletes use it: the Revision object is
# gone either way, and the point is to kill the per-pod reporters, not to block
# the deploy on the activator's rollout. The `||` keeps the deploy green when
# knative-serving is absent or the deploy role cannot touch deployments there —
# the same class of gap that keeps deploy.yml from applying manifests, so a
# permission error here must not fail an otherwise good release.
if (( deleted > 0 )); then
  echo "  restarting the activator so no per-revision reporter outlives its revision"
  kubectl -n knative-serving rollout restart deploy/activator --wait=false \
    || echo "::warning::gc-old-api-revisions: could not restart knative-serving/activator"
fi

echo "✓ api revision GC complete in $NS ($deleted obsolete revision(s) deleted)"
