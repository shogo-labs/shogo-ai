#!/usr/bin/env bash
# =============================================================================
# build-runtime-rootfs.sh — convert the real agent-runtime container image into
# a bootable Firecracker ext4 rootfs (runs ON the bare-metal host, as root).
# =============================================================================
# The cloud runtime ships as an OCIR image (us-ashburn-1.ocir.io/.../shogo-runtime).
# Firecracker boots a raw kernel + a flat ext4 rootfs (no container runtime), so
# we:
#   1. docker pull the image (auth via a mounted docker config.json),
#   2. docker export the flattened, whiteout-resolved filesystem to a tar,
#   3. lay it into a right-sized ext4 image,
#   4. drop an fc-init that sets the pool-mode env the k8s pod would inject and
#      execs the image's own /entrypoint.sh.
#
# Usage (on host):
#   RUNTIME_IMAGE=us-ashburn-1.ocir.io/idin4oltblww/shogo/shogo-runtime:staging-<sha> \
#   DOCKER_CONFIG=/root/.docker-ocir \
#   OUT=/opt/fc-spike/img/runtime.ext4 \
#   bash build-runtime-rootfs.sh
# =============================================================================
set -euo pipefail

: "${RUNTIME_IMAGE:?set RUNTIME_IMAGE=<registry>/shogo-runtime:<tag>}"
OUT="${OUT:-/opt/fc-spike/img/runtime.ext4}"
DOCKER_CONFIG="${DOCKER_CONFIG:-/root/.docker}"
export DOCKER_CONFIG
# PULL=false uses an image already present in the local docker store (e.g. one
# built on-host by build-runtime-image-amd64.sh) instead of pulling from OCIR.
PULL="${PULL:-true}"
WORKDIR="${WORKDIR:-/opt/fc-spike/build}"
POOL_ENV_EXTRA="${POOL_ENV_EXTRA:-}"   # optional extra KEY=VAL lines for fc-init

log() { echo "[build-rootfs] $*"; }

mkdir -p "$WORKDIR" "$(dirname "$OUT")"

# --- 1. Ensure docker daemon ------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "installing docker.io..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq docker.io e2fsprogs rsync >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1 || service docker start || true
# Wait for the daemon socket.
for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info >/dev/null 2>&1 || { log "ERROR: docker daemon not reachable"; exit 4; }

# --- 2. Pull + export -------------------------------------------------------
if [ "$PULL" = "true" ]; then
  log "pulling $RUNTIME_IMAGE (DOCKER_CONFIG=$DOCKER_CONFIG)..."
  docker pull "$RUNTIME_IMAGE"
else
  log "using local image $RUNTIME_IMAGE (PULL=false)"
  docker image inspect "$RUNTIME_IMAGE" >/dev/null 2>&1 || { log "ERROR: local image $RUNTIME_IMAGE not found"; exit 4; }
fi

TAR="$WORKDIR/rootfs.tar"
CID="$(docker create "$RUNTIME_IMAGE" /bin/true)"
log "exporting flattened rootfs from container $CID ..."
docker export "$CID" -o "$TAR"
docker rm "$CID" >/dev/null

TAR_BYTES="$(stat -c%s "$TAR")"
log "export tar = $((TAR_BYTES / 1024 / 1024)) MB"

# --- 3. Size + format ext4 --------------------------------------------------
# ext4 needs headroom for metadata + a writable /app/workspace at runtime.
# Size = tar * 1.4 + 2 GiB, floored at 8 GiB.
SIZE_BYTES=$(( TAR_BYTES * 14 / 10 + 2 * 1024 * 1024 * 1024 ))
MIN_BYTES=$(( 8 * 1024 * 1024 * 1024 ))
[ "$SIZE_BYTES" -lt "$MIN_BYTES" ] && SIZE_BYTES="$MIN_BYTES"
SIZE_MB=$(( SIZE_BYTES / 1024 / 1024 ))
log "creating ${SIZE_MB} MB ext4 at $OUT ..."

rm -f "$OUT"
truncate -s "${SIZE_MB}M" "$OUT"
mkfs.ext4 -q -F -L runtime "$OUT"

MNT="$WORKDIR/mnt"
mkdir -p "$MNT"
umount "$MNT" 2>/dev/null || true
mount -o loop "$OUT" "$MNT"
trap 'umount "$MNT" 2>/dev/null || true' EXIT

log "extracting rootfs into ext4 ..."
tar -C "$MNT" --numeric-owner -xf "$TAR"

# --- 4. fc-init: inject the pool-mode env the k8s pod would set, then exec the
#        image's own entrypoint. Kernel-exec'd init inherits an EMPTY env, so we
#        must recreate every env the Dockerfile's ENV lines provided. -----------
log "installing /usr/local/bin/fc-init ..."
mkdir -p "$MNT/usr/local/bin"
cat > "$MNT/usr/local/bin/fc-init" <<INIT
#!/bin/bash
# Firecracker PID 1 for the real agent-runtime image. eth0 is already up from
# the kernel ip= cmdline, so we never touch networking. We reproduce the
# container ENV (kernel exec gives init an empty environment) and hand off to
# the image's own /entrypoint.sh in warm-pool mode.
mount -t proc proc /proc 2>/dev/null || true
mount -t sysfs sys /sys 2>/dev/null || true
mount -t tmpfs tmpfs /tmp 2>/dev/null || true
mount -t devtmpfs dev /dev 2>/dev/null || true

# eth0 is configured by the kernel ip= cmdline; the host tap is the gateway and
# NATs us out (net.ts). The container image's /etc/resolv.conf points at the
# systemd-resolved stub (127.0.0.53) which isn't running here, so DNS fails and
# the boot-time workspace pre-seed can't reach npm. Point at public resolvers.
rm -f /etc/resolv.conf
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > /etc/resolv.conf

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/app
export NODE_ENV=production
export PORT=8080
export WORKSPACE_DIR=/app/workspace
export SCHEMAS_PATH=/app/.schemas
export MCP_SERVER_PATH=/app/packages/agent-runtime/src/tools/mcp-server.ts
export SHELL=/bin/bash
export NPM_CONFIG_CACHE=/app/.npm
export BUN_INSTALL_CACHE_DIR=/app/.bun/cache
export XDG_CACHE_HOME=/app/.cache
export XDG_CONFIG_HOME=/app/.config
export XDG_DATA_HOME=/app/.local/share
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# Warm-pool mode: bind :8080 and await /pool/assign, no PROJECT_ID hydration.
export PROJECT_ID=__POOL__
export WARM_POOL_MODE=true
${POOL_ENV_EXTRA}

exec /entrypoint.sh
INIT
chmod 0755 "$MNT/usr/local/bin/fc-init"

# Some minimal images lack these dirs pre-created; entrypoint/bun expect them.
mkdir -p "$MNT/app/workspace" "$MNT/proc" "$MNT/sys" "$MNT/dev" "$MNT/tmp"

sync
umount "$MNT"
trap - EXIT
rm -f "$TAR"

log "done: $OUT ($(stat -c%s "$OUT" | awk '{printf "%.1f GB", $1/1024/1024/1024}'))"
log "boot with: METAL_ROOTFS=$OUT METAL_GUEST_INIT=/usr/local/bin/fc-init"
