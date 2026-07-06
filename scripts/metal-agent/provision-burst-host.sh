#!/usr/bin/env bash
# =============================================================================
# provision-burst-host.sh — turn a fresh Latitude box into a running fleet
# member, unattended. Invoked by the burst-host cloud-init (see
# apps/api/src/lib/metal-cloud-init.ts) after it has written /etc/metal-agent.env,
# the OCIR pull creds, and extracted the fleet bundle.
# =============================================================================
# Steps (all idempotent):
#   1. host-bootstrap.sh — KVM/fc/kernel/bun, RAID0+XFS data disk, 256G swap,
#      the (stopped) metal-agent systemd unit.
#   2. build-runtime-rootfs.sh — pull the OCIR runtime image + bake runtime.ext4
#      (this is where the ~11 GB artifact is produced on-box, in lockstep with
#      the fleet image tag — nothing large is shipped over the wire).
#   3. deploy the node-agent source to /opt/metal-agent.
#   4. systemctl enable --now metal-agent → it registers + warms its pool.
#
# Env:
#   WORK          artifact dir (default /opt/fc-spike)
#   DOCKER_CONFIG dir holding the OCIR config.json (default /root/.docker-ocir)
#   BUNDLE_DIR    extracted fleet bundle root (default /opt/metal-provision)
# =============================================================================
set -euo pipefail

WORK="${WORK:-/opt/fc-spike}"
DOCKER_CONFIG="${DOCKER_CONFIG:-/root/.docker-ocir}"
BUNDLE_DIR="${BUNDLE_DIR:-/opt/metal-provision}"
SCRIPTS="$BUNDLE_DIR/scripts/metal-agent"
AGENT_SRC="$BUNDLE_DIR/apps/metal-agent"
log() { echo "[provision-burst] $*"; }

[ "$(id -u)" = "0" ] || { echo "must run as root"; exit 1; }
[ -f "$SCRIPTS/host-bootstrap.sh" ] || { echo "ERROR: bundle missing host-bootstrap.sh at $SCRIPTS"; exit 2; }
[ -f /opt/metal-provision/runtime-image.env ] && . /opt/metal-provision/runtime-image.env
: "${RUNTIME_IMAGE:?RUNTIME_IMAGE not set (expected in runtime-image.env)}"

# --- 1. Host prep ------------------------------------------------------------
log "host-bootstrap..."
WORK="$WORK" bash "$SCRIPTS/host-bootstrap.sh"

# --- 2. Build the runtime rootfs from the OCIR image (if not already built) ---
if [ ! -f "$WORK/img/runtime.ext4" ]; then
  log "building runtime.ext4 from $RUNTIME_IMAGE..."
  RUNTIME_IMAGE="$RUNTIME_IMAGE" DOCKER_CONFIG="$DOCKER_CONFIG" OUT="$WORK/img/runtime.ext4" \
    bash "$SCRIPTS/build-runtime-rootfs.sh"
else
  log "runtime.ext4 already present; skipping build"
fi

# --- 3. Deploy the node-agent source -----------------------------------------
log "deploying node-agent source..."
install -d /opt/metal-agent/src
cp -f "$AGENT_SRC"/src/*.ts /opt/metal-agent/src/
cp -f "$AGENT_SRC"/package.json "$AGENT_SRC"/tsconfig.json /opt/metal-agent/ 2>/dev/null || true
# Bun deps if the agent has any (it is dependency-light; safe no-op otherwise).
if [ -f /opt/metal-agent/package.json ]; then
  (cd /opt/metal-agent && /usr/local/bin/bun install --production >/dev/null 2>&1 || true)
fi

# --- 4. Start the agent ------------------------------------------------------
log "starting metal-agent..."
systemctl daemon-reload
systemctl enable --now metal-agent
sleep 4
systemctl is-active metal-agent && log "metal-agent active" || { log "ERROR: metal-agent failed to start"; journalctl -u metal-agent --no-pager | tail -30; exit 3; }
log "done — host will register with the control plane on its heartbeat"
