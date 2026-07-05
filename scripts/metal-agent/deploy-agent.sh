#!/usr/bin/env bash
# =============================================================================
# deploy-agent.sh — push the node-agent code to a bootstrapped host and (re)start
# the metal-agent systemd service.
# =============================================================================
# Requires host-bootstrap.sh to have run first (systemd unit + bun + FC present).
#
# Usage:
#   SSH_TARGET=root@<host> bash scripts/metal-agent/deploy-agent.sh
# Env:
#   SSH_TARGET (required)   user@host
#   SSH_KEY                 identity file
#   ROOTFS                  guest rootfs path on host (default $WORK/img/runtime.ext4)
#   POOL_SIZE               warm pool target (default 0 = wiring test, no VMs)
#   MEM_MIB, VCPUS          microVM sizing (default 2048 / 2)
#   LISTEN_HOST             node-agent bind addr (default 0.0.0.0; use wg0 IP w/ mesh)
#   START                   1 to enable+start the service (default 0 = install only)
#   IDLE_SUSPEND_MS         auto snapshot-on-idle after this many ms (default 0 = off)
#   SNAP_STORE              durable snapshot store: none|fs|s3 (default none)
#   SNAP_STORE_DIR          fs-store path (default $WORK/durable-snapshots)
#   SNAP_BUCKET             s3-store bucket (OCI Object Storage; s3 backend only)
# =============================================================================
set -euo pipefail

: "${SSH_TARGET:?set SSH_TARGET=user@host}"
SSH_KEY="${SSH_KEY:-}"
WORK="${WORK:-/opt/fc-spike}"
ROOTFS="${ROOTFS:-$WORK/img/runtime.ext4}"
POOL_SIZE="${POOL_SIZE:-0}"
MEM_MIB="${MEM_MIB:-2048}"
VCPUS="${VCPUS:-2}"
LISTEN_HOST="${LISTEN_HOST:-0.0.0.0}"
START="${START:-0}"
IDLE_SUSPEND_MS="${IDLE_SUSPEND_MS:-0}"
SNAP_STORE="${SNAP_STORE:-none}"
SNAP_STORE_DIR="${SNAP_STORE_DIR:-$WORK/durable-snapshots}"
SNAP_BUCKET="${SNAP_BUCKET:-}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
[[ -n "$SSH_KEY" ]] && SSH_OPTS+=(-i "$SSH_KEY")
ssh_() { ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "$@"; }
scp_() { scp "${SSH_OPTS[@]}" "$@"; }

echo "== Preflight (bootstrapped host?) =="
ssh_ "test -f /etc/systemd/system/metal-agent.service && test -x /usr/local/bin/bun" \
  || { echo "! host not bootstrapped — run host-bootstrap.sh first."; exit 3; }

echo "== Push node-agent code -> /opt/metal-agent =="
ssh_ "mkdir -p /opt/metal-agent/src /opt/metal-agent/guest"
scp_ "$REPO_ROOT"/apps/metal-agent/src/*.ts "$SSH_TARGET:/opt/metal-agent/src/"
scp_ "$REPO_ROOT"/apps/metal-agent/package.json "$REPO_ROOT"/apps/metal-agent/tsconfig.json "$SSH_TARGET:/opt/metal-agent/"

echo "== Write /etc/metal-agent.env =="
ssh_ "cat > /etc/metal-agent.env" <<ENV
METAL_WORK=$WORK
METAL_ROOTFS=$ROOTFS
METAL_GUEST_INIT=/usr/local/bin/fc-init
METAL_MEM_MIB=$MEM_MIB
METAL_VCPUS=$VCPUS
METAL_POOL_SIZE=$POOL_SIZE
METAL_LISTEN_HOST=$LISTEN_HOST
METAL_LISTEN_PORT=9900
METAL_IDLE_SUSPEND_MS=$IDLE_SUSPEND_MS
METAL_SNAP_STORE=$SNAP_STORE
METAL_SNAP_STORE_DIR=$SNAP_STORE_DIR
METAL_SNAP_BUCKET=$SNAP_BUCKET
ENV

echo "== (re)load service =="
ssh_ "systemctl daemon-reload"
if [[ "$START" == "1" ]]; then
  ssh_ "systemctl enable --now metal-agent && sleep 2 && systemctl is-active metal-agent"
  echo "== /healthz =="
  ssh_ "curl -fsS http://127.0.0.1:9900/healthz && echo && curl -fsS http://127.0.0.1:9900/vms" || echo "! healthz not ready yet"
else
  echo "service installed but not started (START=1 to enable+start)."
fi
echo "== Done =="
