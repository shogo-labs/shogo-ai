#!/usr/bin/env bash
# =============================================================================
# harvest-coldstart-timing.sh
# =============================================================================
# Pulls the per-phase cold-start / hydration timing that the runtime ALREADY
# emits (no redeploy needed) and prints it as a compact breakdown so we can
# quantify where a cold start spends its time:
#
#   entrypoint -> server boot -> initializeEssentials
#     -> S3 source hydrate (project-src: s3Response / streamRead / extract)
#     -> S3 deps hydrate    (deps: pointer / s3Response / streamRead / extract)
#     -> gateway / LSP ready -> first agent turn
#
# Sources:
#   * logTiming markers:  "[name] [+Xms total, +Yms server] <message>"
#   * S3Sync breakdown:   "[S3Sync] [downloadLayered|restoreDeps] ..."
#
# Usage:
#   ./scripts/harvest-coldstart-timing.sh                # newest assigned pod
#   ./scripts/harvest-coldstart-timing.sh <pod-name>
#   POD=<pod> ./scripts/harvest-coldstart-timing.sh
#   RAW=true ./scripts/harvest-coldstart-timing.sh       # also dump raw lines
# =============================================================================

set -uo pipefail

CTX="${KUBECONTEXT:-oke-staging}"
NS="${WORKSPACES_NS:-shogo-staging-workspaces}"
POD="${1:-${POD:-}}"
RAW="${RAW:-false}"

kctl() { kubectl --context="$CTX" -n "$NS" "$@"; }

if ! kctl get pods >/dev/null 2>&1; then
  echo "! Cannot reach $CTX / $NS" >&2
  exit 1
fi

# Auto-pick the newest running warm-pool/runtime pod that has actually been
# assigned (i.e. its logs contain an S3Sync hydrate). Fall back to newest pod.
if [ -z "$POD" ]; then
  echo "No pod specified — scanning for the newest assigned runtime pod…"
  CANDIDATES=$(kctl get pods \
      --field-selector=status.phase=Running \
      -l serving.knative.dev/service \
      --sort-by=.metadata.creationTimestamp \
      -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null \
    | tail -20)
  for p in $(echo "$CANDIDATES" | tac 2>/dev/null || echo "$CANDIDATES"); do
    [ -z "$p" ] && continue
    if kctl logs "$p" -c user-container --tail=2000 2>/dev/null | grep -q '\[S3Sync\]'; then
      POD="$p"; break
    fi
  done
  if [ -z "$POD" ]; then
    POD=$(echo "$CANDIDATES" | tail -1)
    echo "  (no pod with S3Sync logs found; using newest: $POD)"
  else
    echo "  Selected: $POD"
  fi
fi

if [ -z "$POD" ]; then
  echo "! No runtime pod found." >&2
  exit 1
fi

# Detect the app container (Knative default is user-container; skip queue-proxy).
CONTAINER=$(kctl get pod "$POD" -o jsonpath='{range .spec.containers[*]}{.name}{"\n"}{end}' 2>/dev/null \
  | grep -v queue-proxy | head -1)
CONTAINER="${CONTAINER:-user-container}"

echo ""
echo "Pod:       $POD"
echo "Container: $CONTAINER"
echo "Started:   $(kctl get pod "$POD" -o jsonpath='{.status.startTime}' 2>/dev/null)"
echo "=================================================================="

LOGS=$(kctl logs "$POD" -c "$CONTAINER" --tail=5000 2>/dev/null)
if [ -z "$LOGS" ]; then
  echo "! No logs for $POD/$CONTAINER" >&2
  exit 1
fi

echo ""
echo "---- BOOT TIMELINE (logTiming: +total ms from entrypoint) ----------"
# Keep the +Nms marker and the message; drop the noisy prefix.
echo "$LOGS" | grep -oE '\[\+[0-9]+ms total, \+[0-9]+ms server\] .*' \
  | sed -E 's/\[\+([0-9]+)ms total, \+([0-9]+)ms server\] /\1ms\tsrv+\2ms\t/' \
  | awk -F'\t' '{ printf "  %-10s %-10s %s\n", $1, $2, $3 }'

echo ""
echo "---- SOURCE HYDRATE (project-src) ----------------------------------"
echo "$LOGS" | grep -E '\[S3Sync\] \[downloadLayered\]' \
  | grep -oE '(Breakdown:.*|Source files ready in [0-9]+ms.*|Project archive downloaded:.*|Project archive extracted in.*|S3 GetObject response received in.*)' \
  | sed 's/^/  /'

echo ""
echo "---- DEPS HYDRATE (node_modules cache) -----------------------------"
echo "$LOGS" | grep -E '\[S3Sync\] \[restoreDeps\]' \
  | grep -oE '(Deps pointer read in.*|node_modules already present.*|Deps cache (hit|miss).*|Downloaded deps archive:.*|Deps extracted in.*|COMPLETE in.*|No deps cache pointer.*)' \
  | sed 's/^/  /'

echo ""
echo "---- KEY MARKERS ---------------------------------------------------"
echo "$LOGS" | grep -oE '\[\+[0-9]+ms total.*\] (Essentials complete|Workspace deps ready|Background deps restore ready|Gateway.*ready|LSP.*ready)' \
  | sed -E 's/\[\+([0-9]+)ms total, \+[0-9]+ms server\] /  +\1ms\t/' || true

if [ "$RAW" = "true" ]; then
  echo ""
  echo "---- RAW S3Sync + timing lines -------------------------------------"
  echo "$LOGS" | grep -E '\[S3Sync\]|\+[0-9]+ms total'
fi
