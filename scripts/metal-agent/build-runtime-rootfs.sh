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

log() { echo "[build-rootfs] $*"; }

# Invariants every guest depends on, each of which has taken the fleet down
# when it went missing. Checked against the staged image before it replaces
# the live one; VERIFY_ROOTFS_ONLY=<dir> runs just this against a tree.
verify_rootfs() {
  local root="$1" bad=0
  fail() { log "CONTRACT: $*"; bad=1; }
  [ -x "$root/entrypoint.sh" ] || fail "/entrypoint.sh missing or not executable"
  [ -x "$root/usr/local/bin/bun" ] || fail "/usr/local/bin/bun missing"
  [ -x "$root/usr/bin/git" ] || fail "/usr/bin/git missing"
  [ -x "$root/sbin/blkid" ] || [ -x "$root/usr/sbin/blkid" ] || fail "blkid missing (fc-init finds the workspace drive by label)"
  [ -x "$root/sbin/resize2fs" ] || [ -x "$root/usr/sbin/resize2fs" ] || fail "resize2fs missing (a grown workspace drive would never be grown on disk — e2fsprogs)"
  [ -x "$root/sbin/fsfreeze" ] || [ -x "$root/usr/sbin/fsfreeze" ] || fail "fsfreeze missing (a live drive grow cannot freeze the guest — util-linux)"
  grep -Eq '^[[:space:]]*directory[[:space:]]*=[[:space:]]*\*' "$root/etc/gitconfig" 2>/dev/null ||
    fail "/etc/gitconfig lacks safe.directory = * (git refuses workspaces owned by another uid)"
  local init="$root/usr/local/bin/fc-init"
  if [ -x "$init" ]; then
    check_fc_init "$init" || bad=1
  else
    fail "/usr/local/bin/fc-init missing or not executable"
  fi
  [ -s "$root/etc/shogo-runtime-revision" ] || log "WARNING: /etc/shogo-runtime-revision missing; the release gate cannot pin this image"
  return "$bad"
}

# The guest-init body itself. Takes a path to the file so the same contract can
# be read from a mounted tree or lifted straight out of the shipped image.
check_fc_init() {
  local init="$1" bad=0
  fail() { log "CONTRACT: $*"; bad=1; }
  grep -q 'ulimit -n 1048576' "$init" || fail "fc-init no longer raises RLIMIT_NOFILE (spawns fail with EMFILE)"
  grep -q '127.0.0.1\\tlocalhost' "$init" || fail "fc-init no longer writes /etc/hosts (in-guest localhost is refused)"
  grep -q '> /etc/resolv.conf' "$init" || fail "fc-init no longer writes /etc/resolv.conf"
  grep -q '^exec /entrypoint.sh' "$init" || fail "fc-init does not exec /entrypoint.sh"
  grep -q 'blkid -L shogo-ws' "$init" || fail "fc-init no longer mounts the workspace drive (projects fill the rootfs)"
  grep -q 'resize2fs' "$init" || fail "fc-init no longer grows the workspace filesystem to its drive (SHO-349)"
  return "$bad"
}

# Is the file at $2 inside the ext4 image $1 executable? Read with debugfs, so
# the answer comes from the image that ships and from nothing mounted anywhere.
image_has_exec() {
  local img="$1" path="$2" mode
  # `|| true` keeps `set -e` out of it: a path that is not there is a contract
  # failure to report, not a reason to abort the build mid-gate.
  mode="$( { debugfs -R "stat $path" "$img" 2>/dev/null || true; } |
    sed -n 's/.*Mode:[[:space:]]*\([0-7][0-7]*\).*/\1/p' | head -1)"
  [ -n "$mode" ] || return 1
  [ $(( 0$mode & 0111 )) -ne 0 ]
}


# verify_rootfs reads a mountpoint, and a mountpoint can belong to a different
# filesystem than the file this script is about to ship. That is not
# hypothetical: on staging (2026-11-23) a standard image with no fc-init in it
# passed verify_rootfs, was renamed over the live image, and every cold boot on
# that host died in the kernel with `Requested init /usr/local/bin/fc-init failed
# (error -2)` — the tree the check read was not the tree whose bytes went out.
# This reads $STAGE itself, after the unmount, with nothing mounted anywhere, and
# it is the last gate before the rename that makes the image live.
verify_rootfs_image() {
  local img="$1" bad=0 tmp="$RUN_DIR/image-check"
  fail() { log "CONTRACT: $*"; bad=1; }
  command -v debugfs >/dev/null 2>&1 ||
    { fail "debugfs missing; cannot verify the image that ships (e2fsprogs)"; return 1; }
  mkdir -p "$tmp"
  image_has_exec "$img" /entrypoint.sh || fail "/entrypoint.sh missing or not executable in the staged image"
  image_has_exec "$img" /usr/local/bin/bun || fail "/usr/local/bin/bun missing in the staged image"
  image_has_exec "$img" /usr/bin/git || fail "/usr/bin/git missing in the staged image"
  image_has_exec "$img" /usr/local/bin/fc-init ||
    fail "/usr/local/bin/fc-init missing or not executable in the staged image — every VM built on it panics at boot"
  # Same shape as verify_rootfs above: -x, because a present-but-not-executable
  # tool fails exactly like a missing one at the moment the guest needs it.
  image_has_exec "$img" /sbin/blkid || image_has_exec "$img" /usr/sbin/blkid ||
    fail "blkid missing or not executable in the staged image (fc-init finds the workspace drive by label)"
  image_has_exec "$img" /sbin/resize2fs || image_has_exec "$img" /usr/sbin/resize2fs ||
    fail "resize2fs missing or not executable in the staged image (a grown workspace drive would never be grown on disk)"
  image_has_exec "$img" /sbin/fsfreeze || image_has_exec "$img" /usr/sbin/fsfreeze ||
    fail "fsfreeze missing or not executable in the staged image (a live drive grow cannot freeze the guest)"
  if debugfs -R "cat /etc/gitconfig" "$img" >"$tmp/gitconfig" 2>/dev/null; then
    grep -Eq '^[[:space:]]*directory[[:space:]]*=[[:space:]]*\*' "$tmp/gitconfig" ||
      fail "/etc/gitconfig lacks safe.directory = * in the staged image"
  else
    fail "/etc/gitconfig missing in the staged image"
  fi
  if debugfs -R "cat /usr/local/bin/fc-init" "$img" >"$tmp/fc-init" 2>/dev/null; then
    check_fc_init "$tmp/fc-init" || bad=1
  fi
  return "$bad"
}

if [ -n "${VERIFY_ROOTFS_ONLY:-}" ]; then
  verify_rootfs "$VERIFY_ROOTFS_ONLY"
  exit $?
fi

# VERIFY_ROOTFS_IMAGE_ONLY=<image> runs just the shipped-image gate, against an
# ext4 file with nothing mounted — how the tests exercise it.
if [ -n "${VERIFY_ROOTFS_IMAGE_ONLY:-}" ]; then
  RUN_DIR="$(mktemp -d)"
  trap 'rm -rf "$RUN_DIR"' EXIT
  verify_rootfs_image "$VERIFY_ROOTFS_IMAGE_ONLY"
  exit $?
fi

: "${RUNTIME_IMAGE:?set RUNTIME_IMAGE=<registry>/shogo-runtime:<tag>}"
OUT="${OUT:-/opt/fc-spike/img/runtime.ext4}"
DOCKER_CONFIG="${DOCKER_CONFIG:-/root/.docker}"
export DOCKER_CONFIG
# PULL=false uses an image already present in the local docker store (e.g. one
# built on-host with `docker buildx`) instead of pulling from OCIR.
PULL="${PULL:-true}"
WORKDIR="${WORKDIR:-/opt/fc-spike/build}"
POOL_ENV_EXTRA="${POOL_ENV_EXTRA:-}"   # optional extra KEY=VAL lines for fc-init

mkdir -p "$WORKDIR" "$(dirname "$OUT")"

# One build at a time per host, and nothing shared between runs.
#
# Both images (standard + docker-class) and every retry used to share
# $WORKDIR/rootfs.tar and $WORKDIR/mnt. A second build mounting that same
# mountpoint sat on top of the first, so one build's extract — and its fc-init —
# could land in the other's image while the first still read a clean contract at
# $MNT: the image that shipped had no guest init at all, and every cold boot on
# the host panicked in the kernel (SHO-549, staging, 2026-11-23). The lock
# serialises builders; the per-run directory means a build can only ever see its
# own tar and its own mountpoint.
#
# flock(1) is util-linux, so it exists on the Linux hosts this runs on and not on
# the macOS box the contract tests run it from; without it concurrent builds are
# still safe, they just both pay the disk.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$WORKDIR/.build.lock"
  if ! flock -w 3600 9; then
    log "ERROR: another rootfs build holds $WORKDIR/.build.lock; refusing to build alongside it"
    exit 6
  fi
fi
RUN_DIR="$(mktemp -d "$WORKDIR/build.XXXXXX")"

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

# Hard dependencies: mkfs.ext4 formats the image, debugfs is what proves the
# guest init is inside the file that ships (verify_rootfs_image).
command -v mkfs.ext4 >/dev/null 2>&1 && command -v debugfs >/dev/null 2>&1 ||
  { log "ERROR: e2fsprogs (mkfs.ext4, debugfs) is required"; exit 4; }

# --- 2. Pull + export -------------------------------------------------------
if [ "$PULL" = "true" ]; then
  log "pulling $RUNTIME_IMAGE (DOCKER_CONFIG=$DOCKER_CONFIG)..."
  docker pull "$RUNTIME_IMAGE"
else
  log "using local image $RUNTIME_IMAGE (PULL=false)"
  docker image inspect "$RUNTIME_IMAGE" >/dev/null 2>&1 || { log "ERROR: local image $RUNTIME_IMAGE not found"; exit 4; }
fi

TAR="$RUN_DIR/rootfs.tar"
MNT="$RUN_DIR/mnt"
# The tar is the biggest single artifact here (several GB) and it is only
# removed on the success path below. A failed export or extract used to leave it
# behind, so a host that failed a couple of rebuilds lost its root disk to tars
# nobody would ever look at (dal-2, 2026-10-31). Arm the trap before the export.
STAGE=""
cleanup() {
  umount "$MNT" 2>/dev/null || true
  [ -n "$STAGE" ] && rm -f "$STAGE"
  # Never recurse into a tree that is still mounted: that would delete the
  # staged image's own files.
  if grep -q " $MNT " /proc/self/mountinfo 2>/dev/null; then
    log "WARNING: $MNT still mounted; leaving $RUN_DIR in place"
  else
    rm -rf "$RUN_DIR"
  fi
}
trap cleanup EXIT

CID="$(docker create --label shogo-rootfs-build=1 "$RUNTIME_IMAGE" /bin/true)"
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

# Build into a sibling temp file and rename it over $OUT at the very end.
#
# The image is the dm-snapshot origin for every VM on the host and the base for
# every VM it will boot next, so it must never be observed half-built. Writing
# in place (rm + mkfs + extract) left it absent or empty for the couple of
# minutes the extract takes, and a host that is asked for a VM in that window
# has nothing to boot from. A rename is atomic and, because it only swaps the
# directory entry, VMs already running on the old image keep their inode and
# are unaffected — they migrate at their next boot.
STAGE="$OUT.new.$$"
log "creating ${SIZE_MB} MB ext4 at $STAGE (will replace $OUT atomically) ..."

rm -f "$STAGE"
truncate -s "${SIZE_MB}M" "$STAGE"
mkfs.ext4 -q -F -L runtime "$STAGE"

mkdir -p "$MNT"
umount "$MNT" 2>/dev/null || true
mount -o loop "$STAGE" "$MNT"

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

# A kernel-exec'd init starts with RLIMIT_NOFILE 1024/4096, and the runtime is
# PID 1 here: at 4096 fds every spawn fails with EMFILE (Bun hands back a child
# with no stdio), the runtime throws, init exits and the kernel panics.
# Containers get ~1M from containerd; match that.
ulimit -n 1048576 2>/dev/null || ulimit -n 65536 2>/dev/null || true

mkdir -p /dev/pts
if ! grep -Eq ' /dev/pts .* - devpts ' /proc/self/mountinfo 2>/dev/null; then
  mount -t devpts devpts /dev/pts -o newinstance,ptmxmode=0666,mode=0620,gid=5 2>/dev/null || true
fi
if [ -e /dev/pts/ptmx ]; then
  rm -f /dev/ptmx 2>/dev/null || true
  ln -s pts/ptmx /dev/ptmx 2>/dev/null || true
fi
if ! grep -Eq ' /dev/pts .* - devpts ' /proc/self/mountinfo 2>/dev/null || [ ! -e /dev/pts/ptmx ] || [ ! -e /dev/ptmx ]; then
  echo "[fc-init] WARNING: PTY device setup incomplete; Bun.spawn({ terminal }) may fail" >&2
  mount | grep devpts >&2 || true
  ls -l /dev/ptmx /dev/pts /dev/pts/ptmx >&2 || true
fi

# eth0 is configured by the kernel ip= cmdline; the host tap is the gateway and
# NATs us out (net.ts). The container image's /etc/resolv.conf points at the
# systemd-resolved stub (127.0.0.53) which isn't running here, so DNS fails and
# the boot-time workspace pre-seed can't reach npm. Point at public resolvers.
rm -f /etc/resolv.conf
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > /etc/resolv.conf

# docker export leaves /etc/hosts empty (Docker bind-mounts it at run time), so
# "localhost" falls through to the public resolvers above and never reaches the
# IPv4 listeners here: every in-guest http://localhost:<port> call (the API
# sidecar's /health among them) is refused. Keep localhost on 127.0.0.1 only;
# the sidecars bind IPv4.
rm -f /etc/hosts
printf '127.0.0.1\tlocalhost\n::1\tip6-localhost ip6-loopback\n' > /etc/hosts

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

# Per-VM workspace drive (apps/metal-agent/src/data-drive.ts). The rootfs is
# sized to the image plus a couple of GiB, so a project's workspace and package
# caches get their own disk when the host attaches one. Found by label because
# a docker-class VM carries its docker drive first. Without the drive (or if it
# fails to mount) everything stays on the rootfs, as before.
WS_DEV=\$(blkid -L shogo-ws 2>/dev/null || true)
if [ -n "\$WS_DEV" ]; then
  mkdir -p /data
  if mount -t ext4 -o noatime "\$WS_DEV" /data; then
    # Grow the filesystem to the drive's real size. Online resize is a no-op
    # when they already match, so this is free at every boot; it is what makes a
    # host-side grow (SHO-349) visible after a cold boot instead of leaving the
    # ext4 smaller than its device.
    resize2fs "\$WS_DEV" >/dev/null 2>&1 || echo "[fc-init] WARNING: resize2fs \$WS_DEV failed; workspace stays at its current size" >&2
    mkdir -p /data/workspace
    mount --bind /data/workspace /app/workspace
    # Caches keep the image's prewarmed content (bun's Expo tarballs) as a
    # read-only lower layer and write everything new to the drive.
    for d in .bun/cache .npm .cache; do
      n=\$(echo "\$d" | tr ./ __)
      mkdir -p "/app/\$d" "/data/overlay/\$n/upper" "/data/overlay/\$n/work"
      mount -t overlay overlay -o "lowerdir=/app/\$d,upperdir=/data/overlay/\$n/upper,workdir=/data/overlay/\$n/work" "/app/\$d" \\
        || echo "[fc-init] WARNING: overlay for /app/\$d failed; it stays on the rootfs" >&2
    done
    # Multi-gigabyte export tarballs spool here. Beside the workspace, never
    # inside it, so \`packProjectArchive\` cannot sweep them into the backup — and
    # on this drive rather than /app, because the rootfs is the 16 GiB disk
    # shared with node_modules (SHO-352).
    mkdir -p /data/.shogo-spool
    chown 1001:1001 /data/workspace /data/.shogo-spool /data/overlay/*/upper 2>/dev/null || true
    export SHOGO_SPOOL_DIR=/data/.shogo-spool
    echo "[fc-init] workspace drive \$WS_DEV mounted at /data (spool: \$SHOGO_SPOOL_DIR)"
  else
    echo "[fc-init] WARNING: workspace drive \$WS_DEV failed to mount; workspace stays on the rootfs" >&2
  fi
fi

# Docker-class guests (flag written by this script's DOCKER_CLASS=1 mode).
# start-dockerd mounts the shogo-docker drive, fixes iptables-legacy, and
# opens the socket for uid 1001. A standard rootfs has no flag and skips this.
if [ -f /etc/shogo-docker-class ] && [ -x /usr/local/bin/start-dockerd ]; then
  /usr/local/bin/start-dockerd || echo "[fc-init] WARNING: dockerd did not start" >&2
fi

exec /entrypoint.sh
INIT
chmod 0755 "$MNT/usr/local/bin/fc-init"

# DOCKER_CLASS=1 (set by the host rebuild when METAL_DOCKER_ROOTFS is configured)
# installs the dockerd starter and the flag fc-init looks for. The starter is
# copied from alongside this script so a docker-class rootfs works even when
# the runtime image was built before the script was added to the image.
if [ "${DOCKER_CLASS:-0}" = 1 ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  install -m 0755 "$SCRIPT_DIR/start-dockerd.sh" "$MNT/usr/local/bin/start-dockerd"
  touch "$MNT/etc/shogo-docker-class"
  log "docker-class: start-dockerd installed, shogo-docker drive will mount at /var/lib/docker"
fi

# Some minimal images lack these dirs pre-created; entrypoint/bun expect them.
mkdir -p "$MNT/app/workspace" "$MNT/proc" "$MNT/sys" "$MNT/dev" "$MNT/tmp"

verify_rootfs "$MNT" || { log "ERROR: rootfs contract failed; keeping the current $OUT"; exit 5; }

sync
umount "$MNT"

# The gate that matters reads $STAGE itself, not the mountpoint: nothing is
# mounted any more, and the bytes checked here are the bytes that get renamed
# into place a few lines down.
verify_rootfs_image "$STAGE" || { log "ERROR: staged image failed the rootfs contract; keeping the current $OUT"; exit 5; }

# Fully on disk before it becomes the live image: a rename is atomic with
# respect to readers, but not with respect to losing power midway.
sync "$STAGE" 2>/dev/null || sync
mv -f "$STAGE" "$OUT"
sync

trap - EXIT
rm -rf "$RUN_DIR"

log "done: $OUT ($(stat -c%s "$OUT" | awk '{printf "%.1f GB", $1/1024/1024/1024}'))"
log "boot with: METAL_ROOTFS=$OUT METAL_GUEST_INIT=/usr/local/bin/fc-init"
