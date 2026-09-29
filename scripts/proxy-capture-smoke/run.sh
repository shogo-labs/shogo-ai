#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Shogo Technologies, Inc.
#
# Run the proxy-capture e2e smoke test inside a live api pod.
#
#   KUBECONFIG=/tmp/shogo-staging.kubeconfig NAMESPACE=shogo-staging-system \
#     scripts/proxy-capture-smoke/run.sh [phase...]
#
# Phases default to: setup traffic killswitch archive. Add `cleanup` to delete
# the smoke workspaces afterwards. Uses the current kube context, so point
# KUBECONFIG/--context at the target region explicitly.
set -euo pipefail

NAMESPACE="${NAMESPACE:?set NAMESPACE, e.g. shogo-staging-system}"
PHASES=("$@")
[ ${#PHASES[@]} -eq 0 ] && PHASES=(setup traffic killswitch archive)
RUN="${RUN:-$(date +%s)$RANDOM}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "context: $(kubectl config current-context)  namespace: $NAMESPACE  run: $RUN"
REVISION="$(kubectl -n "$NAMESPACE" get ksvc api -o jsonpath='{.status.latestReadyRevisionName}')"
POD="$(kubectl -n "$NAMESPACE" get pod -l "serving.knative.dev/revision=$REVISION" -o jsonpath='{.items[0].metadata.name}')"
echo "pod: $POD"

kubectl -n "$NAMESPACE" exec "$POD" -c api -- sh -c 'test "$PROXY_CAPTURE_ENABLED" = "true"' \
  || { echo "PROXY_CAPTURE_ENABLED is not true on $POD" >&2; exit 1; }
kubectl -n "$NAMESPACE" cp "$HERE/smoke.ts" "$POD:/tmp/proxy-capture-smoke.ts" -c api

for phase in "${PHASES[@]}"; do
  if [ "$phase" = archive ]; then
    echo "waiting 35s for the archive writer's 30s flush interval"
    sleep 35
  fi
  echo "=== $phase ==="
  kubectl -n "$NAMESPACE" exec "$POD" -c api -- env RUN="$RUN" VERBOSE="${VERBOSE:-}" \
    sh -c 'cd /app/apps/api && bun /tmp/proxy-capture-smoke.ts "$0"' "$phase" 2>&1 \
    | grep -v -E 'NODE_TLS_REJECT_UNAUTHORIZED|trace-warnings'
done
