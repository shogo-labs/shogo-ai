#!/usr/bin/env bash
# =============================================================================
# host-bootstrap.sh — idempotent bare-metal host prep for the FC node-agent.
# =============================================================================
# Turns a fresh Ubuntu bare-metal host into one that can run the Firecracker
# microVM substrate: KVM check, Firecracker + guest kernel, bun, persistent IP
# forwarding, and a (stopped) metal-agent systemd unit. Code + rootfs are pushed
# separately on code deploy; this only makes the host "ready to receive".
#
# Safe to run repeatedly and non-destructively on a live host. This is also the
# body of the Terraform cloud-init first-boot bootstrap (templates/cloud-init.yaml.tftpl).
#
# Usage (on host, as root):  bash host-bootstrap.sh
# Env:
#   WORK        artifact dir (default /opt/fc-spike)
#   FC_VERSION  firecracker version (default 1.10.1)
# =============================================================================
set -euo pipefail

WORK="${WORK:-/opt/fc-spike}"
FC_VERSION="${FC_VERSION:-1.10.1}"
log() { echo "[host-bootstrap] $*"; }

[ "$(id -u)" = "0" ] || { echo "must run as root"; exit 1; }

log "checking KVM..."
[ -e /dev/kvm ] || { echo "ERROR: /dev/kvm absent — host does not expose hardware virt."; exit 2; }

log "installing base packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  curl ca-certificates unzip jq \
  iproute2 iptables \
  e2fsprogs \
  dmsetup lvm2 xfsprogs zstd >/dev/null
log "base packages ok"

# --- Persistent IP forwarding (guest DNAT routing depends on it) ------------
log "enabling net.ipv4.ip_forward (persistent)..."
cat > /etc/sysctl.d/99-metal-agent.conf <<'SYSCTL'
net.ipv4.ip_forward=1
net.ipv4.conf.all.rp_filter=0
SYSCTL
sysctl -p /etc/sysctl.d/99-metal-agent.conf >/dev/null

# --- Firecracker + guest kernel ---------------------------------------------
mkdir -p "$WORK/bin" "$WORK/img" "$WORK/run" "$WORK/snapshots" \
         "$WORK/cow" "$WORK/base-cache" "$WORK/durable-snapshots"
ARCH="$(uname -m)"  # x86_64 on Latitude c3-large-x86
if [ ! -x "$WORK/bin/firecracker" ]; then
  log "installing firecracker v${FC_VERSION} ($ARCH)..."
  curl -fsSL "https://github.com/firecracker-microvm/firecracker/releases/download/v${FC_VERSION}/firecracker-v${FC_VERSION}-${ARCH}.tgz" \
    -o /tmp/fc.tgz
  tar -xzf /tmp/fc.tgz -C /tmp
  install -m0755 "/tmp/release-v${FC_VERSION}-${ARCH}/firecracker-v${FC_VERSION}-${ARCH}" "$WORK/bin/firecracker"
  rm -rf /tmp/fc.tgz "/tmp/release-v${FC_VERSION}-${ARCH}"
fi
"$WORK/bin/firecracker" --version | head -1

if [ ! -f "$WORK/img/vmlinux" ]; then
  log "fetching FC guest kernel..."
  CI_BASE="https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.10/${ARCH}"
  curl -fsSL "${KERNEL_URL:-$CI_BASE/vmlinux-6.1.102}" -o "$WORK/img/vmlinux"
fi
log "kernel: $(ls -la "$WORK/img/vmlinux" | awk '{print $5}') bytes"

# --- Rootfs copy-on-write readiness (NVMe density / GC cache) ----------------
# Each VM needs a private writable rootfs off the ~8 GiB golden image. A full
# copy per VM wastes NVMe (only ~360 suspended/host); CoW extracts the true
# per-project delta so the same host caches many more.
#
#   reflink (default) — COPYFILE_FICLONE clones share unchanged blocks. Needs
#     the METAL_WORK filesystem to be XFS (reflink=1, the mkfs.xfs default since
#     util-linux 5) or Btrfs. On ext4 the clone silently falls back to a FULL
#     copy (correct, just not dense) and the agent logs a one-time warning.
#   dm (opt-in) — device-mapper snapshot: one shared read-only base loop-mounted
#     once + a small sparse per-VM CoW store in $WORK/cow, exposed as a single
#     /dev/mapper device. Densest, and the CoW store IS the diff we push to S3.
#     NOTES for operators enabling METAL_ROOTFS_COW=dm:
#       * The dm device path is baked into the Firecracker vmstate, so it is
#         rebuilt at the SAME name (mvm-<vmId>) from base + the persisted CoW
#         store before every restore. Do not rename/relocate $WORK/cow.
#       * A restore requires the golden base present locally — it is guaranteed,
#         because a restore only runs where rootfsIdentity matches this host's
#         base. Cross-host diff snapshots therefore need no base download.
#       * A full CoW store invalidates its snapshot; $WORK/cow is sized sparse
#         (METAL_DM_COW_SIZE, default 2G) and the GC loop's disk accounting
#         alerts before the underlying filesystem fills.
FS_TYPE="$(stat -f -c %T "$WORK" 2>/dev/null || echo unknown)"
log "METAL_WORK ($WORK) filesystem: $FS_TYPE"
if cp --reflink=always "$WORK/img/vmlinux" "$WORK/.reflink-probe" 2>/dev/null; then
  log "reflink supported on $WORK — CoW rootfs clones will be sparse."
  rm -f "$WORK/.reflink-probe"
else
  log "WARN: reflink NOT supported on $WORK ($FS_TYPE). METAL_ROOTFS_COW=reflink"
  log "WARN: will fall back to full ~8 GiB rootfs copies. For density, put $WORK"
  log "WARN: on XFS (mkfs.xfs defaults to reflink=1) or Btrfs, or use METAL_ROOTFS_COW=dm."
  rm -f "$WORK/.reflink-probe" 2>/dev/null || true
fi

# --- bun (for the node-agent) -----------------------------------------------
if [ ! -x /usr/local/bin/bun ]; then
  log "installing bun..."
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash >/dev/null 2>&1
fi
/usr/local/bin/bun --version

# --- metal-agent systemd unit (stopped until code+rootfs deployed) ----------
log "installing metal-agent.service (not started)..."
install -d /opt/metal-agent
# Environment defaults; the code-deploy step overwrites /etc/metal-agent.env.
if [ ! -f /etc/metal-agent.env ]; then
  cat > /etc/metal-agent.env <<ENV
METAL_WORK=$WORK
METAL_ROOTFS=$WORK/img/runtime.ext4
METAL_GUEST_INIT=/usr/local/bin/fc-init
METAL_MEM_MIB=2048
METAL_VCPUS=2
METAL_POOL_SIZE=0
METAL_LISTEN_HOST=0.0.0.0
METAL_LISTEN_PORT=9900
# Phase 3 snapshot lifecycle (env file is overwritten on code deploy): idle
# auto-suspend + durable snapshot store. Off by default; enable per-host once validated.
METAL_IDLE_SUSPEND_MS=0
METAL_SNAP_STORE=none
METAL_SNAP_STORE_DIR=$WORK/durable-snapshots
# Phase 5 NVMe garbage collection / cache. The GC loop runs by default and
# reclaims orphans + evicts LRU suspended snapshots under disk pressure. Eviction
# of live snapshots requires a durable store (METAL_SNAP_STORE=fs|s3); with
# store=none only orphans are reclaimed. reflink CoW is the safe default.
METAL_ROOTFS_COW=reflink
METAL_DM_COW_DIR=$WORK/cow
METAL_BASE_CACHE_DIR=$WORK/base-cache
METAL_GC_INTERVAL_MS=30000
METAL_DISK_HIGH_PCT=85
METAL_DISK_LOW_PCT=70
METAL_CACHE_MAX_BYTES=0
METAL_DURABLE_ACTIVE_WINDOW_MS=1209600000
METAL_SNAP_SLIM=0
METAL_ACTIVITY_POLL=1
ENV
fi
cat > /etc/systemd/system/metal-agent.service <<'UNIT'
[Unit]
Description=Shogo Firecracker node-agent (microVM warm pool)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/metal-agent.env
WorkingDirectory=/opt/metal-agent
ExecStart=/usr/local/bin/bun run src/server.ts
Restart=always
RestartSec=2
# microVMs + KVM need broad privileges; this host is single-tenant.
User=root
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
log "done. push node-agent code + rootfs to the host, then: systemctl enable --now metal-agent"
