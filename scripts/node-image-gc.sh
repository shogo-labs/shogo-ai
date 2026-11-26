#!/bin/sh
# =============================================================================
# node-image-gc.sh — reclaim superseded Shogo image digests on an OKE node
# =============================================================================
# Every deploy pins a new `shogo-runtime:<env>-<sha>` / `shogo-api` digest and
# nothing ever removes the old ones, so a long-lived node accumulates ~10 GB of
# dead runtime layers per deploy until its boot volume fills. The deploy gate
# (`.github/scripts/check-node-disk-headroom.sh`) fails at 80%, but the kubelet's
# own image GC does not start until 85% (default `imageGCHighThresholdPercent`),
# so a node parked at 80-85% is never reclaimed by anything — that is the
# 2026-10-26 staging incident (SHO-233): node 10.0.24.140 sat at 80.6% with
# 13 `shogo-runtime` + 12 `shogo-api` digests and blocked four `Build, Test, and
# Deploy` runs.
#
# SHO-136 (#1645) tried to close the gap with
# `--image-gc-high-threshold=70 --image-gc-low-threshold=60`, but
# `node_metadata` is in the OKE pool's `lifecycle.ignore_changes`, so those
# flags only apply after a node recycle — and no recycle has happened. This
# script is what reclaims on the nodes we already have, the same way
# `k8s/base/inotify-tuner.yaml` reaches existing nodes for its sysctl.
#
# It ships as a ConfigMap (`k8s/base/node-image-gc.yaml`, created from this file
# by the deploy workflows) and runs inside the node's own root — `chroot /host
# /bin/sh /run/shogo-node-image-gc/node-image-gc.sh` — so it uses the node's
# `crictl`, `df` and `jq` directly instead of carrying a copy of each.
#
# What it removes, on a pass where the worst of nodefs/imagefs is at or above
# RECLAIM_PCT:
#   * only images whose repo matches IMAGE_REPOS — postgres, Knative, OKE
#     system images and everything else are never passed to `crictl rmi`;
#   * only images no container on the node uses (`crictl ps -a`, so exited
#     containers count too) and that cri-o has not pinned;
#   * only images outside the newest KEEP_PER_REPO of their repo, so a rollback
#     stays warm and an image the prepuller is pulling right now is never
#     dropped;
#   * never anything whose age is unknown — without one it cannot be shown to
#     be older than the images we keep.
#
# Usage (the script only exists inside the DaemonSet pod — the ConfigMap is
# mounted into the pod's view of the host root, so a `kubectl debug node/...`
# shell on the host does NOT have it. Exec into the pod instead):
#   POD=$(kubectl -n kube-system get pod -l app.kubernetes.io/name=node-image-gc \
#           --field-selector spec.nodeName=<node> -o name)
#   kubectl -n kube-system exec -it "$POD" -- \
#     chroot /host /usr/bin/env RECLAIM_PCT=0 DRY_RUN=1 ONESHOT=1 \
#     /bin/sh /run/shogo-node-image-gc/node-image-gc.sh
#
# Env:
#   RECLAIM_PCT      default 65   reclaim at/above this used% (gate is 80)
#   KEEP_PER_REPO    default 2    newest digests kept per repo
#   INTERVAL_S       default 600  seconds between successful passes
#   RETRY_S          default 30   seconds before retrying a FAILED pass
#   MAX_FAILED_PASSES default 3   consecutive failures before exiting 1, so the
#                                 container restarts and the restart count /
#                                 CrashLoopBackOff is visible (SHO-592)
#   IMAGE_REPOS      default shogo/(shogo-runtime|agent-runtime|shogo-api|
#                                 shogo-web|shogo-docs)   (ERE)
#   IMAGE_DIR        default /var/lib/containers  filesystem to measure
#   IMAGE_STORE_DIR  default /var/lib/containers/storage/overlay-images
#   CRICTL           default crictl
#   CRI_SOCKET       default /var/run/crio/crio.sock  named in the failure log
#   CRICTL_TIMEOUT   default 10m  crictl's own default is 2s, which a busy
#                                 cri-o (removing a 10 GB image, or listing a
#                                 store it is compacting) blows through — the
#                                 RPC is cancelled, crictl exits non-zero, and
#                                 the removal keeps going server-side anyway.
#   NODE_NAME        default hostname   the node this pass is about
#   STATE_DIR        default /run/shogo-node-image-gc-state
#                                 where a completed pass leaves its marker and
#                                 where the current used% goes for the taint
#                                 sidecar (`disk-status`; the sidecar's own
#                                 TAINT_PCT/UNTAINT_PCT live in
#                                 scripts/node-disk-taint.sh)
#   DRY_RUN          default 0    log candidates, remove nothing
#   ONESHOT          default 0    one pass then exit (tests + manual runs)
#
# Failure semantics (SHO-592)
# ---------------------------
# A pass FAILS (non-zero, no `last-pass` marker) when it could not do its job
# while the node needed it:
#   * cri-o is unreachable — `crictl info` cannot reach CRI_SOCKET, or
#     `crictl images` fails — at/above RECLAIM_PCT. Before this, the 2026-11-26
#     04:19:58 prod pass found CRI-O's socket GONE, logged "skipped", removed
#     0 of 11 candidates, wrote the marker and returned 0, so node .184 filled
#     to 85% and kubelet evicted 36 pods across 21 published apps. A skip that
#     is indistinguishable from success is the bug;
#   * candidates were selected (>=1) and EVERY `crictl rmi` failed.
# A PARTIAL failure (some removed, some in use) stays a success — that is the
# normal "a pod started while we were listing" race, and the existing partial
# test pins it. Below RECLAIM_PCT nothing is attempted and the pass succeeds.
# `jq`/`crictl` missing on the node stays exit 0: those nodes are deliberately
# unsupported.
# =============================================================================

set -eu

RECLAIM_PCT="${RECLAIM_PCT:-65}"
KEEP_PER_REPO="${KEEP_PER_REPO:-2}"
INTERVAL_S="${INTERVAL_S:-600}"
RETRY_S="${RETRY_S:-30}"
MAX_FAILED_PASSES="${MAX_FAILED_PASSES:-3}"
IMAGE_REPOS="${IMAGE_REPOS:-shogo/(shogo-runtime|agent-runtime|shogo-api|shogo-web|shogo-docs)}"
IMAGE_DIR="${IMAGE_DIR:-/var/lib/containers}"
IMAGE_STORE_DIR="${IMAGE_STORE_DIR:-/var/lib/containers/storage/overlay-images}"
CRICTL="${CRICTL:-crictl}"
CRI_SOCKET="${CRI_SOCKET:-/var/run/crio/crio.sock}"
CRICTL_TIMEOUT="${CRICTL_TIMEOUT:-10m}"
DRY_RUN="${DRY_RUN:-0}"
ONESHOT="${ONESHOT:-0}"

# The node this pass is about. Inside the DaemonSet the container's UTS
# hostname is the *pod* name, so the downward API value is authoritative; a
# hand-run on the node falls back to the real hostname.
NODE="${NODE_NAME:-$(hostname 2>/dev/null || echo unknown-node)}"
log() { echo "[node-image-gc] ${NODE} $*"; }

# A completed pass drops this marker. The DaemonSet's startupProbe waits for
# it, so the deploy's `kubectl rollout status` means "the reclaim ran on this
# node", not merely "a pod exists" — otherwise the gate can sample a node the
# first pass has not finished with yet. A FAILED pass must not write it: that
# is what made the 2026-11-26 eviction look supervised.
STATE_DIR="${STATE_DIR:-/run/shogo-node-image-gc-state}"
STATUS_FILE="${STATE_DIR}/disk-status"

# Every cri-o call goes through here so it gets the long timeout (see the
# CRICTL_TIMEOUT note above).
cri() { "$CRICTL" --timeout="$CRICTL_TIMEOUT" "$@"; }

# Used% of the filesystem holding the image store. `df` reports capacity as
# used+available, which is exactly the kubelet's capacityBytes, so this number
# is comparable to the deploy gate's.
disk_pct() {
  df -Pk "$IMAGE_DIR" 2>/dev/null | awk '
    NR > 1 && NF >= 4 && ($3 + $4) > 0 {
      p = int(100 * $3 / ($3 + $4))
      if (p > max) max = p
    }
    END { if (max != "") print max }
  '
}

# "id epoch-seconds" for every image in cri-o's store. `crictl images -o json`
# carries no timestamp and `crictl inspecti` exposes none either (verified on
# cri-o 1.35 / OKE OL8), so the store's own `created` field is the only age
# signal on the node; an entry without one falls back to the mtime of its store
# directory. Fractional seconds are dropped before `fromdateiso8601` because it
# only parses whole seconds.
created_map() {
  store_json="${IMAGE_STORE_DIR}/images.json"
  [ -r "$store_json" ] || return 0
  jq -r '.[]
    | select(.created != null and .id != null)
    | "\(.id) \(.created | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)"' \
    "$store_json" 2>/dev/null || true
  for id in $(jq -r '.[] | select(.created == null and .id != null) | .id' "$store_json" 2>/dev/null || true); do
    mtime=$(stat -c %Y "${IMAGE_STORE_DIR}/${id}" 2>/dev/null || true)
    [ -n "$mtime" ] && echo "${id} ${mtime}"
  done
}

# The whole selection in one place: which Shogo digests on this node are
# superseded. Emits {candidates, summary} as JSON.
select_candidates() {
  jq -c \
    --arg re "$IMAGE_REPOS" \
    --argjson keep "$KEEP_PER_REPO" \
    --argjson inuse "$inuse" \
    --argjson created "$created" \
    '
    def hex: split("@")[1] // "" | sub("^sha256:"; "");
    [ (.images // [])[]
      | select(((.repoDigests // []) | length) > 0)
      | . as $img
      | ($img.repoDigests[0]) as $rd
      | ($rd | split("@")[0]) as $repo
      | select($repo | test($re))
      | {
          id: $img.id,
          repo: $repo,
          digest: ($rd | hex),
          size: (($img.size // "0") | tonumber? // 0),
          pinned: ($img.pinned // false),
          in_use: (($inuse | index($img.id)) != null or ($inuse | index($rd | hex)) != null),
          created: ($created[$img.id] // null)
        }
    ] as $all
    | [ $all[] | select(.pinned) ] as $pinned
    | [ $all[] | select(.in_use) ] as $used
    | [ $all[] | select((.pinned | not) and (.in_use | not) and .created != null) ] as $free
    | [ $free[]
        | . as $c
        | ($free | map(select(.repo == $c.repo)) | sort_by(.created) | reverse | .[0:$keep] | map(.id)) as $newest
        | select(($newest | index($c.id)) == null)
      ] as $candidates
    | {
        candidates: $candidates,
        summary: {
          images: ($all | length),
          pinned: ($pinned | length),
          in_use: ($used | length),
          unknown_age: ([$all[] | select((.pinned | not) and (.in_use | not) and .created == null)] | length),
          kept_newest: (([$all[] | select((.pinned | not) and (.in_use | not) and .created != null)] | length) - ($candidates | length)),
          per_repo: ([$all[].repo] | group_by(.) | map({repo: .[0], images: length}))
        }
      }
    '
}

# The used% this pass measured, published to STATE_DIR for the taint sidecar
# (`scripts/node-disk-taint.sh`). Written BEFORE the RECLAIM_PCT gate returns,
# because the sidecar must also see a node that has recovered below 65% and
# UNtaint it. Atomic: the sidecar polls this file every minute and must never
# read a half-written value.
#
# `epoch` is what the sidecar ages the reading by: if this container stops
# writing (cri-o unreachable, CrashLoopBackOff) the file goes stale and the
# sidecar must stop acting on a number that no longer describes the node. `ts`
# is for humans reading `kubectl exec ... cat`.
write_status() {
  { mkdir -p "$STATE_DIR" \
    && printf 'pct=%s\nepoch=%s\nts=%s\n' "$1" "$(date -u +%s)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      >"${STATUS_FILE}.tmp" \
    && mv "${STATUS_FILE}.tmp" "$STATUS_FILE"; } 2>/dev/null || true
}

pass() {
  reclaim || return 1
  { mkdir -p "$STATE_DIR" && : >"${STATE_DIR}/last-pass"; } 2>/dev/null || true
}

# cri-o could not be used at all. This is a FAILURE of the pass, not a skip:
# the node is at/above RECLAIM_PCT, so something had to be reclaimed and
# nothing was. One line, naming the endpoint, so the SigNoz alert
# (`node-image-gc-failing.yaml`) can match on "cri unreachable".
cri_failure() {
  log "ERROR cri unreachable — ${CRICTL} cannot use the runtime endpoint ${CRI_SOCKET} ($1); disk is ${pct}% (>= ${RECLAIM_PCT}%) and nothing could be reclaimed"
}

cri_reachable() {
  cri info >/dev/null 2>&1
}

reclaim() {
  pct="$(disk_pct)"
  if [ -z "$pct" ]; then
    log "cannot read disk usage of ${IMAGE_DIR} — skipping this pass"
    return 0
  fi
  write_status "$pct"
  if [ "$pct" -lt "$RECLAIM_PCT" ]; then
    log "disk ${pct}% < ${RECLAIM_PCT}% — nothing to reclaim"
    return 0
  fi
  log "disk ${pct}% >= ${RECLAIM_PCT}% — reclaiming superseded Shogo digests (keep newest ${KEEP_PER_REPO} per repo)"

  if ! cri_reachable; then
    cri_failure "crictl info failed / connection refused"
    return 1
  fi
  if ! images_json="$(cri images -o json 2>/dev/null)"; then
    cri_failure "crictl images failed"
    return 1
  fi
  containers_json="$(cri ps -a -o json 2>/dev/null)" || containers_json='{"containers":[]}'

  # Every image any container uses, by config id and by digest. Exited
  # containers count: a crashed pod must still be able to restart on its image.
  inuse="$(echo "$containers_json" | jq -c '
    [ (.containers // [])[]
      | (.imageId // "" | sub("^sha256:"; "")),
        (.imageRef // "" | split("@")[1] // "" | sub("^sha256:"; ""))
    ] | map(select(. != null and . != "")) | unique
  ')"
  created="$(created_map | jq -Rn '[inputs | split(" ") | {(.[0]): ((.[1] | tonumber?))} | with_entries(select(.value != null))] | add // {}')"

  sel="$(echo "$images_json" | select_candidates)"
  candidates="$(echo "$sel" | jq -r '.candidates[] | "\(.id) \(.repo)"')"

  echo "$sel" | jq -r '.summary.per_repo[] | "  \(.repo): \(.images) image(s)"'
  echo "$sel" | jq -r '.summary | "  in use: \(.in_use)  pinned: \(.pinned)  unknown age (kept): \(.unknown_age)  newest kept: \(.kept_newest)"'

  if [ -z "$candidates" ]; then
    log "no superseded digests to remove"
    return 0
  fi

  removed=0
  skipped=0
  while read -r id repo; do
    [ -n "$id" ] || continue
    if [ "$DRY_RUN" = "1" ]; then
      log "would remove ${repo} ${id}"
      removed=$((removed + 1))
      continue
    fi
    if err="$(cri rmi "$id" 2>&1)"; then
      log "removed ${repo} ${id}"
      removed=$((removed + 1))
    else
      # In use after all (a pod started between the two crictl calls), or
      # pinned storage: log it and move on rather than retrying in a loop.
      skipped=$((skipped + 1))
      log "skipped ${repo} ${id}: $(echo "$err" | head -1)"
    fi
  done <<EOF
${candidates}
EOF

  pct_after="$(disk_pct)"
  log "done before=${pct}% after=${pct_after:-?}% removed=${removed} skipped=${skipped} dry_run=${DRY_RUN}"
  # A pass that selected candidates and removed NONE of them did not do its
  # job: cri-o refused every rmi (socket dying mid-pass, storage pinned, the
  # image store read-only). That is the 2026-11-26 shape one step later, so it
  # fails rather than reporting success. A PARTIAL failure stays a success —
  # an image that came into use between the two listings is the normal race.
  if [ "$DRY_RUN" != "1" ] && [ "$removed" -eq 0 ] && [ "$skipped" -gt 0 ]; then
    pct="$pct_after"
    log "ERROR nothing removed — all ${skipped} selected digest(s) failed to remove; see the 'skipped' lines above"
    return 1
  fi
  return 0
}

if ! command -v jq >/dev/null 2>&1; then
  log "jq is not on this node — cannot select digests, refusing to prune (see docs/runbooks/node-image-gc.md)"
  exit 0
fi
if ! command -v "$CRICTL" >/dev/null 2>&1; then
  log "crictl (${CRICTL}) is not on this node — refusing to prune"
  exit 0
fi

if [ "$ONESHOT" = "1" ]; then
  pass || exit 1
  exit 0
fi

# Loop mode. A failed pass retries after RETRY_S, not INTERVAL_S — ten minutes
# is a long time to leave a filling node alone. After MAX_FAILED_PASSES in a
# row, exit 1: the container restarts, so the restart count and (at 3 restarts)
# CrashLoopBackOff are visible in `kubectl get pods` and can be alerted on,
# instead of a pass that keeps failing quietly forever.
failed=0
while :; do
  if pass; then
    failed=0
    sleep "$INTERVAL_S"
    continue
  fi
  failed=$((failed + 1))
  if [ "$failed" -ge "$MAX_FAILED_PASSES" ]; then
    log "ERROR ${failed} failed passes in a row — exiting 1 so the container restarts and the failure is visible (restart count / CrashLoopBackOff)"
    exit 1
  fi
  log "pass failed (${failed}/${MAX_FAILED_PASSES}) — retrying in ${RETRY_S}s"
  sleep "$RETRY_S"
done
