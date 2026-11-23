#!/usr/bin/env bash
# =============================================================================
# run-density-soak.sh — how many VMs one metal host carries before agent turns
# degrade. Staging only.
# =============================================================================
# Stages the node-agent source + the density harness onto the host, then runs
# apps/metal-agent/load/density-soak.ts as root. The runner itself does the
# safety work (staging guard, cordon, env swap, abort guard, teardown); this
# script only gets the code there and brings the report back.
#
# Usage:
#   SSH_TARGET=root@<staging-host> bash scripts/metal-agent/run-density-soak.sh
#
# Env:
#   SSH_TARGET              (required) user@host
#   SSH_KEY                 identity file
#   HOST_ID                 host id the control plane knows (default: latitude-dal-1)
#   WORK                    host artifact dir (default /opt/fc-spike)
#   STEPS                   comma-separated VM counts (default 40,60,80,100,120,160)
#   HOLD                    hold per step (default 10m)
#   MIX                     role mix (default agent=0.16,app=0.01,idle=0.83)
#   BURST                   set to 1 to run the burst phase
#   ADMIN_TOKEN             super-admin session for the cordon API
#                           (or cordon by hand and pass ASSUME_CORDONED=1)
#   ASSUME_CORDONED         set to 1 if you cordoned the host yourself
#   OUT_DIR                 local results dir (default apps/metal-agent/load/results)
#   DRY_RUN                 set to 1 to stop after preflight
# =============================================================================
set -euo pipefail

: "${SSH_TARGET:?set SSH_TARGET=root@<staging-host>}"
SSH_KEY="${SSH_KEY:-}"
HOST_ID="${HOST_ID:-latitude-dal-1}"
WORK="${WORK:-/opt/fc-spike}"
STEPS="${STEPS:-40,60,80,100,120,160}"
HOLD="${HOLD:-10m}"
MIX="${MIX:-agent=0.16,app=0.01,idle=0.83}"
BURST="${BURST:-0}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
ASSUME_CORDONED="${ASSUME_CORDONED:-0}"
DRY_RUN="${DRY_RUN:-0}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/apps/metal-agent/load/results}"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
[[ -n "$SSH_KEY" ]] && SSH_OPTS+=(-i "$SSH_KEY")
ssh_() { ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "$@"; }
scp_() { scp "${SSH_OPTS[@]}" "$@"; }

echo "== Preflight =="
ssh_ "test -e /dev/kvm && test -x $WORK/bin/firecracker && test -f $WORK/img/vmlinux && test -f $WORK/img/rootfs.ext4" \
  || { echo "! Host missing FC artifacts under $WORK — run scripts/firecracker-spike/run-spike-ssh.sh first."; exit 3; }
ssh_ "test -f /etc/metal-agent.env" \
  || { echo "! /etc/metal-agent.env not found — is the metal-agent installed on this host?"; exit 3; }

echo "== Stage node-agent source + density harness =="
ssh_ "rm -rf ~/metal-agent && mkdir -p ~/metal-agent/src ~/metal-agent/load/density ~/metal-agent/guest"
scp_ "$REPO_ROOT"/apps/metal-agent/src/*.ts "$SSH_TARGET:~/metal-agent/src/"
scp_ -r "$REPO_ROOT"/apps/metal-agent/src/test-harness "$SSH_TARGET:~/metal-agent/src/"
scp_ "$REPO_ROOT"/apps/metal-agent/load/*.ts "$SSH_TARGET:~/metal-agent/load/"
scp_ "$REPO_ROOT"/apps/metal-agent/load/density/*.ts "$SSH_TARGET:~/metal-agent/load/density/"
scp_ "$REPO_ROOT"/apps/metal-agent/guest/*.go "$SSH_TARGET:~/metal-agent/guest/"
scp_ "$REPO_ROOT"/apps/metal-agent/package.json "$REPO_ROOT"/apps/metal-agent/tsconfig.json "$SSH_TARGET:~/metal-agent/"

echo "== Install bun if missing =="
ssh_ 'test -x ~/.bun/bin/bun || curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1; ~/.bun/bin/bun --version'

ARGS=(--host "$HOST_ID" --steps "$STEPS" --hold "$HOLD" --mix "$MIX")
[[ "$BURST" == "1" ]] && ARGS+=(--burst)
[[ "$ASSUME_CORDONED" == "1" ]] && ARGS+=(--assume-cordoned)
[[ "$DRY_RUN" == "1" ]] && ARGS+=(--dry-run)

echo "== Run density soak (host=$HOST_ID steps=$STEPS hold=$HOLD) =="
# Run inside the agent's own environment: the staging control plane's certificate
# is self-signed and the host sets NODE_TLS_REJECT_UNAUTHORIZED=0 for it, and the
# runner reads METAL_PUBLIC_HOST / METAL_REGISTER_TOKEN from the same place.
ssh_ "cd ~/metal-agent && set -a && . /etc/metal-agent.env && set +a && DENSITY_SOAK_ADMIN_TOKEN='$ADMIN_TOKEN' ~/.bun/bin/bun run load/density-soak.ts ${ARGS[*]}"

echo "== Copy results =="
mkdir -p "$OUT_DIR"
latest="$(ssh_ "ls -1dt ~/metal-agent/load/results/density-* 2>/dev/null | head -1" || true)"
if [[ -n "$latest" ]]; then
  scp_ -r "$SSH_TARGET:$latest" "$OUT_DIR/"
  echo "wrote $OUT_DIR/$(basename "$latest")"
else
  echo "! no density results directory found on host"
fi
echo "== Done =="
