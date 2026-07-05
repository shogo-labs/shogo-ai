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
#   --- control-plane registration (Phase 4) ---
#   CONTROL_PLANE_URL       apps/api base URL to register with (default '' = standalone)
#   REGISTER_TOKEN          shared bearer token (must match api METAL_REGISTER_TOKEN)
#   MESH_IP                 addr the control plane dials for /assign (default LISTEN_HOST)
#   REGION, HOST_ID         host metadata for routing/liveness
#   --- public per-VM DNAT (pre-mesh data path) ---
#   PUBLIC_HOST             host public IP; set to return http://PUBLIC_HOST:port URLs
#   FWD_ALLOW_CIDR          source CIDR allowed to reach forwarded ports (control-plane egress)
#   INSECURE_TLS            set to 1 to skip TLS verify on register (e.g. control plane
#                           behind a Cloudflare Origin cert reached directly by IP)
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
CONTROL_PLANE_URL="${CONTROL_PLANE_URL:-}"
REGISTER_TOKEN="${REGISTER_TOKEN:-}"
MESH_IP="${MESH_IP:-$LISTEN_HOST}"
REGION="${REGION:-us}"
HOST_ID="${HOST_ID:-$(echo "$SSH_TARGET" | sed 's/.*@//')}"
PUBLIC_HOST="${PUBLIC_HOST:-}"
FWD_ALLOW_CIDR="${FWD_ALLOW_CIDR:-}"
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
METAL_CONTROL_PLANE_URL=$CONTROL_PLANE_URL
METAL_REGISTER_TOKEN=$REGISTER_TOKEN
METAL_MESH_IP=$MESH_IP
METAL_REGION=$REGION
METAL_HOST_ID=$HOST_ID
METAL_PUBLIC_HOST=$PUBLIC_HOST
METAL_FWD_ALLOW_CIDR=$FWD_ALLOW_CIDR
${INSECURE_TLS:+NODE_TLS_REJECT_UNAUTHORIZED=0}
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
