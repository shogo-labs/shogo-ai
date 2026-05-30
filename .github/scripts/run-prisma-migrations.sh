#!/usr/bin/env bash
# .github/scripts/run-prisma-migrations.sh
#
# Run `prisma migrate deploy` against a region's local Postgres as a
# Kubernetes Job, then wait for the Job to *complete* (or fail) with a
# budget generous enough to absorb a cold image pull.
#
# Why a Job instead of `kubectl run -i`:
#
# The previous inline implementation was:
#
#   kubectl run prisma-migrate-<region> --rm -i --restart=Never \
#     --image=<api-image> --command -- sh -c "... migrate deploy" \
#     --timeout=600s
#
# `kubectl run -i` attaches to the pod and only waits
# `--pod-running-timeout` (default 60s) for it to reach Running before
# giving up with "timed out waiting for the condition". `--timeout` does
# NOT extend that window. On 2026-05-30 the EU and India v1.9.1 deploys
# both failed here: the multi-hundred-MB shogo-api image had to cold-pull
# onto a freshly-scaled secondary-region node, the pull ran past 60s, and
# kubectl aborted the *deploy* even though the migration would have run
# fine. Because this step sits between "Apply Kubernetes manifests" and
# "Sync API environment variables", the abort also left the api ksvc
# without its RUNTIME_IMAGE — the trigger for the warm-pool outage.
#
# This script removes the attach entirely: it submits a Job (Kubernetes
# happily waits out the image pull) and polls the Job's Complete/Failed
# conditions up to a 15-minute deadline. DDL is NOT propagated by Postgres
# logical replication, so every region must apply migrations against its
# own platform-pg cluster — this is not redundant with the US run.
#
# Failure is fatal (see the 2026-05-26 P3009 incident: a swallowed
# migration error let the api crashloop on a stale revision while the
# deploy reported success). DATABASE_URL is mounted from the existing
# postgres-credentials secret rather than decoded into the manifest.
#
# Usage:
#   .github/scripts/run-prisma-migrations.sh <namespace> <api-image>

set -euo pipefail

NS="${1:?namespace required}"
IMAGE="${2:?api image required}"

JOB="prisma-migrate-$(date +%s)"
DEADLINE_SECONDS=900

cleanup() {
  kubectl delete job "$JOB" -n "$NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Submitting migration Job $JOB in namespace $NS"
echo "  image: $IMAGE"

kubectl apply -f - <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: ${JOB}
  namespace: ${NS}
spec:
  # One shot. A genuine migration failure (e.g. P3009) must fail the
  # deploy immediately, not silently retry. A slow image pull keeps the
  # pod Pending (not Failed), so backoffLimit: 0 does not punish it.
  backoffLimit: 0
  activeDeadlineSeconds: ${DEADLINE_SECONDS}
  ttlSecondsAfterFinished: 120
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: ${IMAGE}
          command: ["sh", "-c", "cd /app && bunx prisma migrate deploy"]
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: postgres-credentials
                  key: DATABASE_URL
            - name: SKIP_MIGRATIONS
              value: "false"
EOF

echo "Waiting up to ${DEADLINE_SECONDS}s for Job $JOB (allows cold image pull)..."
deadline=$(( $(date +%s) + DEADLINE_SECONDS ))

while true; do
  complete=$(kubectl get job "$JOB" -n "$NS" \
    -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}' 2>/dev/null || true)
  failed=$(kubectl get job "$JOB" -n "$NS" \
    -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' 2>/dev/null || true)

  if [[ "$complete" == "True" ]]; then
    echo "✓ Migrations applied in $NS"
    kubectl logs "job/$JOB" -n "$NS" --tail=40 2>/dev/null || true
    exit 0
  fi

  if [[ "$failed" == "True" ]]; then
    echo "::error::prisma migrate deploy failed in $NS"
    kubectl logs "job/$JOB" -n "$NS" --tail=120 2>/dev/null || true
    kubectl describe "job/$JOB" -n "$NS" 2>/dev/null | tail -n 30 || true
    exit 1
  fi

  if [[ "$(date +%s)" -ge "$deadline" ]]; then
    echo "::error::migration Job $JOB did not finish within ${DEADLINE_SECONDS}s in $NS"
    kubectl describe "job/$JOB" -n "$NS" 2>/dev/null | tail -n 30 || true
    kubectl logs "job/$JOB" -n "$NS" --tail=120 2>/dev/null || true
    exit 1
  fi

  sleep 5
done
