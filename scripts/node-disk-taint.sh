#!/bin/sh
# =============================================================================
# node-disk-taint.sh — keep a nearly-full node out of the scheduler's reach
# =============================================================================
# Runs as the `disk-taint` sidecar of the node-image-gc DaemonSet
# (k8s/base/node-image-gc.yaml). It reads the used% that the GC pass measured
# (`$STATE_DIR/disk-status`, written by scripts/node-image-gc.sh) and reconciles
# exactly one taint on its own node:
#
#   used% >= TAINT_PCT   (default 80) -> shogo.ai/disk-high=true:NoSchedule
#   used% <  UNTAINT_PCT (default 75) -> no taint
#   in between                        -> unchanged (whatever it was)
#
# Why this exists (SHO-592, 2026-11-26)
# -------------------------------------
# The kubelet taints `node.kubernetes.io/disk-pressure:NoSchedule` only once it
# is at the eviction threshold (85% by default). The deploy gate
# (`.github/scripts/check-node-disk-headroom.sh`) refuses to ROLL OUT above 80%,
# but the scheduler kept placing pods in the 80-85% band: pods evicted from
# 10.0.10.5 were rescheduled onto 10.0.10.184 at 75%, pushing it to 84% and then
# over the line, which evicted 36 pods across 21 published apps. The gap between
# "we stop deploying here" and "the scheduler stops using it" is what this
# closes.
#
# Why a taint and not a cordon
# ----------------------------
# `check-node-disk-headroom.sh` and warm-pool-monitor both treat a cordoned node
# as "being drained on purpose" and deliberately stop looking at it. Cordoning a
# full node would therefore HIDE it from the two checks whose job is to page
# about it. A NoSchedule taint blocks new pods and changes nothing else: both
# checks keep sampling the node and keep paging at 78%.
#
# DaemonSets keep running on a tainted node — every workload in this repo that
# must survive it tolerates everything (`image-prepuller`, `node-image-gc`,
# `inotify-tuner`, the log agents all set `operator: Exists`), which the tests
# assert alongside this script's behaviour.
#
# Env:
#   NODE_NAME     (required in a pod)  this node, from the downward API
#   STATE_DIR     default /run/shogo-node-image-gc-state
#   TAINT_PCT     default 80   taint at/above this used%
#   UNTAINT_PCT   default 75   remove the taint below this used%
#   INTERVAL_S    default 60   seconds between reconciles
#   KUBECTL       default kubectl
#   DRY_RUN       default 0    log what it would change, call nothing that
#                              mutates the node
#   ONESHOT       default 0    reconcile once then exit (tests + manual runs)
#
# The taint is only ever added/removed on a TRANSITION, and each reconcile
# reads the node first, so a steady node produces no API writes at all.
# =============================================================================

set -eu

NODE="${NODE_NAME:-$(hostname 2>/dev/null || echo unknown-node)}"
STATE_DIR="${STATE_DIR:-/run/shogo-node-image-gc-state}"
STATUS_FILE="${STATE_DIR}/disk-status"
TAINT_PCT="${TAINT_PCT:-80}"
UNTAINT_PCT="${UNTAINT_PCT:-75}"
INTERVAL_S="${INTERVAL_S:-60}"
KUBECTL="${KUBECTL:-kubectl}"
DRY_RUN="${DRY_RUN:-0}"
ONESHOT="${ONESHOT:-0}"

TAINT_NAME="shogo.ai/disk-high"

log() { echo "[node-disk-taint] ${NODE} $*"; }

# The used% the GC pass measured, or empty when there is no fresh reading yet.
# A pod that has just started has none: the first GC pass may still be running,
# and guessing here would taint a healthy node.
read_pct() {
  [ -r "$STATUS_FILE" ] || return 0
  sed -n 's/^pct=//p' "$STATUS_FILE" 2>/dev/null | head -1
}

# Does this node carry the taint right now? Read from the API every tick rather
# than from a local variable, so an out-of-band `kubectl taint` (or a node that
# was tainted by a previous pod) converges instead of being ignored.
current_tainted() {
  "$KUBECTL" get node "$NODE" \
    -o jsonpath='{range .spec.taints[*]}{.key}={.value}:{.effect}{"\n"}{end}' 2>/dev/null \
    | grep -q "^${TAINT_NAME}="
}

add_taint() {
  if [ "$DRY_RUN" = "1" ]; then
    log "would taint ${TAINT_NAME}=true:NoSchedule (disk ${pct}% >= ${TAINT_PCT}%)"
    return 0
  fi
  if "$KUBECTL" taint nodes "$NODE" "${TAINT_NAME}=true:NoSchedule" --overwrite 2>&1; then
    log "tainted ${TAINT_NAME}=true:NoSchedule (disk ${pct}% >= ${TAINT_PCT}%) — scheduler will not place new pods here"
    return 0
  fi
  # A transient API error must not kill the sidecar: the next tick retries.
  log "warning: could not taint ${NODE} (will retry in ${INTERVAL_S}s)"
  return 0
}

remove_taint() {
  if [ "$DRY_RUN" = "1" ]; then
    log "would remove ${TAINT_NAME} (disk ${pct}% < ${UNTAINT_PCT}%)"
    return 0
  fi
  if "$KUBECTL" taint nodes "$NODE" "${TAINT_NAME}:NoSchedule-" 2>&1; then
    log "removed ${TAINT_NAME} (disk ${pct}% < ${UNTAINT_PCT}%) — scheduler may place pods here again"
    return 0
  fi
  log "warning: could not remove ${TAINT_NAME} from ${NODE} (will retry in ${INTERVAL_S}s)"
  return 0
}

reconcile() {
  pct="$(read_pct)"
  if [ -z "$pct" ]; then
    log "no disk reading yet in ${STATUS_FILE} — leaving the node as it is"
    return 0
  fi
  case "$pct" in
    '' | *[!0-9]*)
      log "unreadable disk reading '${pct}' in ${STATUS_FILE} — leaving the node as it is"
      return 0
      ;;
  esac

  if [ "$pct" -ge "$TAINT_PCT" ]; then
    if current_tainted; then
      log "disk ${pct}% >= ${TAINT_PCT}% — already tainted"
    else
      add_taint
    fi
    return 0
  fi

  if [ "$pct" -lt "$UNTAINT_PCT" ]; then
    if current_tainted; then
      remove_taint
    else
      log "disk ${pct}% < ${UNTAINT_PCT}% — no taint to remove"
    fi
    return 0
  fi

  # The hysteresis band. Not a no-op by accident: leaving the taint exactly as
  # it is here is what stops a node hovering on one number from thrashing.
  if current_tainted; then
    log "disk ${pct}% between ${UNTAINT_PCT}% and ${TAINT_PCT}% — keeping the taint"
  else
    log "disk ${pct}% between ${UNTAINT_PCT}% and ${TAINT_PCT}% — staying untainted"
  fi
  return 0
}

if [ "$ONESHOT" = "1" ]; then
  reconcile
  exit 0
fi

while :; do
  reconcile || log "reconcile failed — continuing"
  sleep "$INTERVAL_S"
done
