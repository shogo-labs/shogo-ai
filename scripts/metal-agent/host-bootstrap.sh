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
#   FC_VERSION  firecracker version (default 1.16.1; >=1.16 supports the
#               clock_realtime restore flag we rely on to fix resume clock-skew)
#   METAL_KSM   0|1 — provision host KSM (same-page merging) via tmpfiles.d and
#               MemoryKSM= on the unit. Default 0: it is a cross-tenant security
#               decision as much as a memory one (see docs/runbooks/metal-idle-memory.md)
# =============================================================================
set -euo pipefail

WORK="${WORK:-/opt/fc-spike}"
FC_VERSION="${FC_VERSION:-1.16.1}"
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
  e2fsprogs mdadm \
  dmsetup lvm2 xfsprogs zstd pigz >/dev/null
log "base packages ok"

# --- Data disk: put $WORK on the big local NVMe, not the OS drive ------------
# The 512 GB hosts (s3-large-x86) boot on a small ~480 GB drive with the two
# large NVMes unformatted. The rootfs cache + snapshots + CoW + swap need the
# big, fast storage. Idempotent and SAFE: only acts when $WORK is not already a
# mountpoint and only ever touches whole NVMe disks that are unpartitioned and
# unmounted (never the root disk or anything holding data). Two big disks →
# RAID0 (throughput + capacity); one → used directly. XFS (reflink=1 default)
# so reflink CoW works too.
setup_data_disk() {
  local mnt="$1"
  mountpoint -q "$mnt" && { log "data-disk: $mnt already mounted ($(findmnt -no SOURCE "$mnt")); skipping"; return; }
  local root_src root_disk
  root_src="$(findmnt -no SOURCE / 2>/dev/null || true)"
  root_disk="$(lsblk -no PKNAME "$root_src" 2>/dev/null | head -1 || true)"
  local cands=()
  local d sz mnts
  for d in $(lsblk -dn -o NAME,TYPE 2>/dev/null | awk '$2=="disk"{print $1}'); do
    case "$d" in nvme*) ;; *) continue ;; esac
    [ "$d" = "$root_disk" ] && continue
    mnts="$(lsblk -rno MOUNTPOINT "/dev/$d" 2>/dev/null | tr -d ' ')"
    [ -n "$mnts" ] && continue            # something on this disk is mounted → skip
    sz="$(blockdev --getsize64 "/dev/$d" 2>/dev/null || echo 0)"
    [ "$sz" -ge 1000000000000 ] && cands+=("/dev/$d")   # >= ~1 TB
  done
  if [ "${#cands[@]}" -eq 0 ]; then
    log "data-disk: no spare NVMe found; leaving $WORK on the OS drive"
    mkdir -p "$mnt"
    return
  fi
  local dev
  if [ "${#cands[@]}" -ge 2 ]; then
    log "data-disk: RAID0 over ${cands[*]} -> /dev/md0"
    mdadm --create --verbose /dev/md0 --level=0 --raid-devices="${#cands[@]}" "${cands[@]}" --run
    dev=/dev/md0
    mkdir -p /etc/mdadm
    grep -q '/dev/md0' /etc/mdadm/mdadm.conf 2>/dev/null || \
      mdadm --detail --scan >> /etc/mdadm/mdadm.conf
    update-initramfs -u >/dev/null 2>&1 || true
  else
    dev="${cands[0]}"
    log "data-disk: using single $dev"
  fi
  log "data-disk: mkfs.xfs $dev"
  mkfs.xfs -f "$dev" >/dev/null
  mkdir -p "$mnt"
  mount "$dev" "$mnt"
  local uuid; uuid="$(blkid -s UUID -o value "$dev")"
  grep -q "$uuid" /etc/fstab 2>/dev/null || echo "UUID=$uuid $mnt xfs defaults,noatime 0 0" >> /etc/fstab
  log "data-disk: mounted $dev at $mnt ($(df -h "$mnt" | awk 'NR==2{print $2}'))"
}
setup_data_disk "$WORK"

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

# --- Swap on NVMe (OOM safety net for dense VM packing) ---------------------
# Firecracker only keeps *resident* guest pages, but a burst of concurrently
# active projects can push total RSS past physical RAM. With no swap the OOM
# killer takes a Firecracker process — i.e. a live project dies. A large NVMe
# swapfile is cheap insurance: swappiness=10 keeps it idle until real pressure,
# turning a hard kill into graceful slowdown. Sized for the 512 GB hosts so the
# worst-case guest-RAM ceiling (many 4 GiB VMs) always has somewhere to spill.
SWAP_GB="${SWAP_GB:-256}"
SWAPFILE="$WORK/swapfile"
if ! swapon --show=NAME --noheadings 2>/dev/null | grep -qx "$SWAPFILE"; then
  log "provisioning ${SWAP_GB}G swap at $SWAPFILE..."
  rm -f "$SWAPFILE" 2>/dev/null || true
  fallocate -l "${SWAP_GB}G" "$SWAPFILE" 2>/dev/null || \
    dd if=/dev/zero of="$SWAPFILE" bs=1M count=$((SWAP_GB * 1024)) status=none
  chmod 600 "$SWAPFILE"
  mkswap "$SWAPFILE" >/dev/null 2>&1 || true
  if ! swapon "$SWAPFILE" 2>/dev/null; then
    # A fallocate'd file can carry holes on some filesystems (XFS/Btrfs) which
    # swapon rejects ("swapfile has holes"); rewrite it fully with dd.
    log "swapon rejected sparse file; rewriting ${SWAP_GB}G with dd..."
    rm -f "$SWAPFILE"
    dd if=/dev/zero of="$SWAPFILE" bs=1M count=$((SWAP_GB * 1024)) status=none
    chmod 600 "$SWAPFILE"
    mkswap "$SWAPFILE" >/dev/null 2>&1 || true
    swapon "$SWAPFILE" 2>/dev/null || log "WARN: swapon failed; continuing without swap"
  fi
  log "swap active: $(free -h | awk '/Swap/{print $2}') total"
fi
# Persist across reboots + keep swappiness low (swap is a safety net, not a
# first resort — never page out hot guest RAM proactively).
grep -qF "$SWAPFILE" /etc/fstab || echo "$SWAPFILE none swap sw 0 0" >> /etc/fstab
printf 'vm.swappiness=10\n' > /etc/sysctl.d/99-metal-swap.conf
sysctl -w vm.swappiness=10 >/dev/null

# >>> ksm-setup (SHO-534) — extracted verbatim by
# apps/metal-agent/src/host-bootstrap-ksm.test.ts, so keep the markers.
# --- KSM (same-page merging), opt-in per host -------------------------------
# KSM is the only way to shrink the part of an idle VM that neither the balloon
# nor free page reporting can reach: pages the guest still holds but that are
# byte-identical across VMs (the same libc, the same node_modules, the same
# kernel-adjacent runtime image). ksmd merges them into one host page.
#
# It only works on memory that has been marked MADV_MERGEABLE, and Firecracker
# does not do that itself. `MemoryKSM=yes` (systemd >= 254) sets
# PR_SET_MEMORY_MERGE on the metal-agent service, and the FC children — which are
# its children — inherit the flag across fork+exec, so their guest mappings become
# mergeable without patching Firecracker.
#
# Default OFF, and not just because it is unmeasured: merging pages BETWEEN
# TENANTS opens dedup timing side channels (a guest can infer whether another VM
# holds a given page, leaking low-entropy secrets and library fingerprints) and
# makes Rowhammer flips across shared pages practical (Flip Feng Shui class).
# Staging turns it on to measure the gain; prod only if Russell signs off on
# those numbers (docs/runbooks/metal-idle-memory.md).
METAL_KSM="${METAL_KSM:-0}"
KSM_TMPFILES="${KSM_TMPFILES:-/etc/tmpfiles.d/metal-ksm.conf}"
if [ "$METAL_KSM" = "1" ]; then
  log "KSM: enabling (pages_to_scan=1000 sleep_millisecs=50 use_zero_pages=1)..."
  mkdir -p "$(dirname "$KSM_TMPFILES")"
  cat > "$KSM_TMPFILES" <<'KSM'
# Managed by scripts/metal-agent/host-bootstrap.sh (METAL_KSM=1).
# Re-running the bootstrap rewrites this file; deleting it (METAL_KSM=0) turns
# KSM back off on the next boot. Values are the staging starting point: scan
# 1000 pages every 50ms, and merge zero pages (cheap, and a large win on idle
# guests). Tune from the measured ksmd CPU against the 10%-of-one-thread budget.
w /sys/kernel/mm/ksm/run              - - - - 1
w /sys/kernel/mm/ksm/pages_to_scan    - - - - 1000
w /sys/kernel/mm/ksm/sleep_millisecs  - - - - 50
w /sys/kernel/mm/ksm/use_zero_pages   - - - - 1
KSM
  # tmpfiles runs at boot; apply it now too, so re-running the bootstrap on a
  # live host converges without a reboot.
  systemd-tmpfiles --create "$KSM_TMPFILES" >/dev/null 2>&1 || \
    log "WARN: systemd-tmpfiles --create failed; KSM applies on next boot"
else
  # A host that never had KSM writes and logs nothing: prod's bootstrap output
  # must stay byte-identical with the default env. One that DID have it is turned
  # back off, live as well as at boot.
  if [ -f "$KSM_TMPFILES" ]; then
    rm -f "$KSM_TMPFILES"
    log "KSM: disabling (removed $KSM_TMPFILES)"
    [ -w /sys/kernel/mm/ksm/run ] && echo 0 > /sys/kernel/mm/ksm/run 2>/dev/null || true
  fi
fi
# <<< ksm-setup

ARCH="$(uname -m)"  # x86_64 on Latitude s3-large-x86 / c3-large-x86
# Install OR upgrade firecracker. The binary is host infrastructure (not shipped
# via the pull-based agent release), so re-running this script must converge an
# already-provisioned host onto FC_VERSION — the old `[ ! -x ]` guard skipped
# any host that already had *a* firecracker, which is how the fleet stayed on
# 1.10.1. We compare the running binary's version and only (re)install on a
# mismatch. After an upgrade, restart metal-agent so the warm pool re-warms on
# the new FC.
#
# NOTE: Firecracker snapshots are NOT compatible across versions. After an
# upgrade, existing suspended guests fail to resume and cold-boot instead
# (pool.open catches the load failure and falls through) — a one-time,
# self-healing cost, and cold boots come up with a correct wall-clock anyway.
if ! { [ -x "$WORK/bin/firecracker" ] && "$WORK/bin/firecracker" --version 2>/dev/null | grep -qF "v${FC_VERSION}"; }; then
  log "installing firecracker v${FC_VERSION} ($ARCH)..."
  # Preserve the current binary so a bad upgrade can be rolled back by hand.
  [ -x "$WORK/bin/firecracker" ] && cp -a "$WORK/bin/firecracker" "$WORK/bin/firecracker.prev" || true
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
# Control-plane auth. The listener above is on a public IP, so the API on :9900
# is internet-reachable; `observe` counts uncredentialed calls without refusing
# them, and a host is flipped to `enforce` only once that count is zero (see
# docs/runbooks/metal-fleet.md). METAL_CTRL_ALLOW_CIDR adds a packet filter
# under the bearer — the control plane's egress IPs, comma-separated; loopback
# and the guest TAP supernet are always allowed. Empty = no filter.
METAL_AUTH_MODE=observe
METAL_CTRL_ALLOW_CIDR=
# Phase 3 snapshot lifecycle (env file is overwritten on code deploy): idle
# auto-suspend + durable snapshot store. 15m matches DEFAULT_IDLE_SUSPEND_MS in
# apps/api/src/lib/metal-cloud-init.ts, so a bootstrapped baseline host and a
# reconciler-provisioned burst host reclaim idle VMs on the same window.
METAL_IDLE_SUSPEND_MS=900000
METAL_SNAP_STORE=none
METAL_SNAP_STORE_DIR=$WORK/durable-snapshots
# Phase 5 NVMe garbage collection / cache. The GC loop runs by default and
# reclaims orphans + evicts LRU suspended snapshots. There are two disk
# watermarks: METAL_GC_HEADROOM_PCT reclaims a trim just BELOW the alert line
# (MetalHostDiskPressure pages at METAL_DISK_HIGH_PCT, 85) and the high watermark
# reclaims down to METAL_DISK_LOW_PCT once the line is crossed. With
# METAL_SNAP_STORE=none the local snapshot is the only snapshot, so only orphans
# are reclaimed unless METAL_GC_EVICT_WITHOUT_STORE=1 is set deliberately — the
# cost of evicting there is one cold boot from the project's durable git/S3
# workspace. reflink CoW is the safe default.
METAL_ROOTFS_COW=reflink
METAL_DM_COW_DIR=$WORK/cow
METAL_BASE_CACHE_DIR=$WORK/base-cache
# Each VM's workspace + package caches live on their own sparse ext4 drive of
# this size (MiB) instead of the rootfs's ~2 GiB of headroom. 0 = off.
METAL_WORKSPACE_DRIVE_MIB=20480
METAL_GC_INTERVAL_MS=30000
METAL_DISK_HIGH_PCT=85
METAL_DISK_LOW_PCT=70
# Reclaim at this used% before the alert line. Ignored unless it sits between
# METAL_DISK_LOW_PCT and METAL_DISK_HIGH_PCT; 0 disables it.
METAL_GC_HEADROOM_PCT=80
# Most bytes one headroom trim may reclaim; 0 = no limit.
METAL_GC_HEADROOM_BUDGET_BYTES=5368709120
# 1 = let the GC evict a suspended snapshot on a host with no durable store.
METAL_GC_EVICT_WITHOUT_STORE=
METAL_CACHE_MAX_BYTES=0
METAL_DURABLE_ACTIVE_WINDOW_MS=1209600000
METAL_SNAP_SLIM=0
METAL_ACTIVITY_POLL=1
# Host log shipper (otelcol-metal.service): ship metal-agent's journald output
# to SigNoz. Empty by default — a burst-host cloud-init / code deploy that holds
# the SigNoz creds fills these in (apps/api/src/lib/metal-cloud-init.ts), and the
# collector below is only installed+started when OTEL_EXPORTER_OTLP_ENDPOINT is
# non-empty, so an unconfigured host provisions cleanly.
OTEL_EXPORTER_OTLP_ENDPOINT=
SIGNOZ_INGESTION_KEY=
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
# ROLLING DEPLOY: kill ONLY the agent process on stop/restart, never its
# cgroup. The firecracker microVM children are reparented to init and keep
# running; the next agent instance re-adopts them (pool.adopt) so a code deploy
# never cold-restarts live projects. Without this, systemd's default
# KillMode=control-group would SIGTERM the whole cgroup and take the VMs down.
KillMode=process
# On SIGTERM the agent drains in-flight calls before it exits: 10 s for short
# requests, and up to 180 s for an /assign or /resume that is still cold-opening
# a workspace (a 812 MB hydrate takes about a minute). TimeoutStopSec must be
# LONGER than that drain, or systemd SIGKILLs the agent mid-open and cuts off the
# very call the drain exists to finish — that is how SHO-584's half-open VM was
# created. 210 s = the 180 s open deadline + 30 s of headroom.
TimeoutStopSec=210
# microVMs + KVM need broad privileges; this host is single-tenant.
User=root
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
UNIT
# KSM (SHO-534). `MemoryKSM=yes` makes systemd call PR_SET_MEMORY_MERGE on the
# service, and the firecracker children inherit it across fork+exec — that is what
# marks guest memory MADV_MERGEABLE for ksmd, without patching Firecracker. Only
# added when the host opted in, so a default host's unit file is unchanged.
# Needs systemd >= 254 (the hosts run 255 on Ubuntu 24.04); an older systemd
# ignores the unknown key with a warning, so gate it rather than risk that.
if [ "$METAL_KSM" = "1" ]; then
  if [ "$(systemctl --version 2>/dev/null | head -1 | awk '{print $2}')" -ge 254 ] 2>/dev/null; then
    sed -i '/^\[Service\]$/a MemoryKSM=yes' /etc/systemd/system/metal-agent.service
    log "KSM: MemoryKSM=yes on metal-agent.service"
  else
    log "WARN: systemd < 254 — no MemoryKSM=; KSM would sit idle (see runbook fallback)"
  fi
fi
systemctl daemon-reload

# --- Agent memory guard (SHO-593) --------------------------------------------
# On 2026-11-26 the node-agent's own RSS reached 63 GiB and the kernel OOM-killed
# it mid-suspend. A systemd MemoryMax cannot guard this: the firecracker guests
# are children of the agent, so they share its cgroup (148 processes and 335 GB
# of guest memory on staging), and any MemoryMax tight enough to catch the agent
# would start OOM-killing live projects' VMs. OOMScoreAdjust= has the mirror
# problem — children inherit it at fork, so every guest would become the
# preferred victim.
#
# VmRSS of the agent PROCESS is per-process, so it excludes the guests, and it is
# the number that ran away. This timer watches it and restarts the agent when it
# crosses METAL_AGENT_RSS_GUARD_MIB (default 12 GiB, 0 disables). That restart is
# the routine rolling-deploy path — KillMode=process kills only the agent and the
# next instance re-adopts every guest — so a runaway costs one drain, not a host.
# >>> memguard-setup
install -m0755 /dev/stdin /usr/local/bin/metal-agent-memguard <<'MEMGUARD_SCRIPT'
#!/usr/bin/env bash
# =============================================================================
# metal-agent-memguard — restart the node-agent before its own memory takes the
# host down with it.
# =============================================================================
# Why a watchdog and not a systemd memory limit (SHO-593):
#
#   `memory.max` on metal-agent.service would cap the WRONG processes. The
#   firecracker guests are children of the agent, so they sit in the agent's own
#   cgroup: on staging that cgroup holds 148 processes and 335 GB of guest
#   memory. Any MemoryMax small enough to catch the agent's runaway (tens of
#   GiB) would start OOM-killing live projects' VMs instead. `OOMScoreAdjust=`
#   has the same problem in reverse — children inherit it at fork, so every
#   guest would become the preferred victim.
#
#   The number that actually ran away is the agent PROCESS's own RSS (63 GiB
#   before the kernel OOM-killed it on 2026-11-26), and VmRSS is per-process, so
#   it excludes the guests. When it crosses the cap, a restart is safe and is
#   already the routine path: KillMode=process kills only the agent, the guests
#   are reparented and the next agent re-adopts them (pool.adopt). That is what
#   every code deploy does, with live projects staying up.
#
# So: watch, log, restart, cool down. Never touch the guests.
#
# Usage:
#   metal-agent-memguard              # check once (what the timer runs)
#   metal-agent-memguard --decide RSS_KB CAP_MIB LAST_EPOCH NOW_EPOCH
#                                     # pure decision, printed as `ok <why>` or
#                                     # `restart <why>`; unit-tested
#
# Env (from /etc/metal-agent.env):
#   METAL_AGENT_RSS_GUARD_MIB        restart threshold, MiB; 0 disables (49152)
#   METAL_AGENT_RSS_GUARD_WARN_MIB   log-only threshold, MiB (32768)
#   METAL_AGENT_RSS_GUARD_COOLDOWN_S minimum seconds between restarts (1800)
#
# Two thresholds, not one: a busy host legitimately holds a lot of agent heap.
# dal-2 sat at 26-29 GiB RSS for 14 days with no OOM, so a cap near that number
# would restart a healthy host every cooldown. The measured runaways are 63 GiB
# (the OOM) and 94 GiB (one snapshot burst), so the cap sits above the healthy
# plateau and the warn line records the climb before anything is restarted.
# =============================================================================
set -euo pipefail

ENV_FILE=/etc/metal-agent.env
STATE_FILE=/run/metal-agent-memguard.last
UNIT=metal-agent.service

# --- pure decision, so a test can drive it without a host --------------------
decide() {
  local rss_kb="$1" cap_mib="$2" last_epoch="$3" now_epoch="$4" warn_mib="${5:-0}"
  local cooldown_s="${METAL_AGENT_RSS_GUARD_COOLDOWN_S:-1800}"
  local cap_kb=$(( cap_mib * 1024 ))
  local warn_kb=$(( warn_mib * 1024 ))

  if [ "$cap_mib" -le 0 ]; then
    echo "ok disabled"
    return
  fi
  if [ "$rss_kb" -le 0 ]; then
    echo "ok no-rss"
    return
  fi
  if [ "$rss_kb" -le "$cap_kb" ]; then
    if [ "$warn_kb" -gt 0 ] && [ "$rss_kb" -gt "$warn_kb" ]; then
      echo "warn over-warn=$(( rss_kb / 1024 ))MiB warn=$(( warn_kb / 1024 ))MiB cap=$(( cap_kb / 1024 ))MiB"
      return
    fi
    echo "ok below-cap $(( rss_kb / 1024 ))MiB/$(( cap_kb / 1024 ))MiB"
    return
  fi
  # Over the cap: still respect the cooldown, or a restart loop would hammer a
  # host that is only over because it is still adopting its VMs back.
  if [ "$(( now_epoch - last_epoch ))" -lt "$cooldown_s" ]; then
    echo "ok cooling-down $(( now_epoch - last_epoch ))s/${cooldown_s}s over=$(( rss_kb / 1024 ))MiB"
    return
  fi
  echo "restart over=$(( rss_kb / 1024 ))MiB cap=$(( cap_kb / 1024 ))MiB"
}

if [ "${1:-}" = "--decide" ]; then
  [ $# -ge 5 ] || { echo "usage: $0 --decide RSS_KB CAP_MIB LAST_EPOCH NOW_EPOCH [WARN_MIB]" >&2; exit 2; }
  decide "$2" "$3" "$4" "$5" "${6:-0}"
  exit 0
fi

# --- the timer path ----------------------------------------------------------
if [ -r "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi
CAP_MIB="${METAL_AGENT_RSS_GUARD_MIB:-49152}"
WARN_MIB="${METAL_AGENT_RSS_GUARD_WARN_MIB:-32768}"
COOLDOWN_S="${METAL_AGENT_RSS_GUARD_COOLDOWN_S:-1800}"

if [ "$CAP_MIB" -le 0 ]; then
  exit 0
fi

pid="$(systemctl show "$UNIT" -p MainPID --value 2>/dev/null || echo 0)"
if [ -z "$pid" ] || [ "$pid" = "0" ] || [ ! -r "/proc/$pid/status" ]; then
  exit 0
fi
rss_kb="$(awk '/^VmRSS:/{print $2}' "/proc/$pid/status" 2>/dev/null || echo 0)"
last=0
[ -r "$STATE_FILE" ] && last="$(cat "$STATE_FILE" 2>/dev/null || echo 0)"
now="$(date +%s)"

verdict="$(decide "$rss_kb" "$CAP_MIB" "$last" "$now" "$WARN_MIB")"
case "$verdict" in
  warn\ *)
    logger -t metal-agent-memguard "WARN ${verdict#warn } (pid $pid)" || true
    ;;
  restart\ *)
    # Restart BEFORE the kernel OOM-kills us: a restart is graceful (drain, VMs
    # re-adopted), an OOM kill is not, and the host keeps its guests either way.
    echo "$now" > "$STATE_FILE"
    logger -t metal-agent-memguard "RESTARTING $UNIT: ${verdict#restart } (pid $pid) — guests survive via KillMode=process + pool.adopt" || true
    systemctl restart "$UNIT"
    logger -t metal-agent-memguard "restart issued; new MainPID $(systemctl show "$UNIT" -p MainPID --value)" || true
    ;;
  *over=*)
    # Over the cap but cooling down: say so every tick, so the journal shows the
    # climb rather than just the restart.
    logger -t metal-agent-memguard "over cap, waiting out cooldown: ${verdict#ok }" || true
    ;;
esac
MEMGUARD_SCRIPT

cat > /etc/systemd/system/metal-agent-memguard.service <<'MEMGUARD_UNIT'
[Unit]
Description=Shogo metal-agent memory guard (restart the agent before its own RSS takes the host down)
After=metal-agent.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/metal-agent-memguard
MEMGUARD_UNIT

cat > /etc/systemd/system/metal-agent-memguard.timer <<'MEMGUARD_TIMER'
[Unit]
Description=Check the metal-agent's own RSS every 30 s

[Timer]
OnBootSec=2min
OnUnitActiveSec=30s
AccuracySec=5s
Persistent=false

[Install]
WantedBy=timers.target
MEMGUARD_TIMER

systemctl daemon-reload
systemctl enable --now metal-agent-memguard.timer || log "WARN: metal-agent-memguard.timer failed to start (check: systemctl status metal-agent-memguard.timer)"
# <<< memguard-setup

# --- Host log shipper: otelcol-contrib (journald -> SigNoz) ------------------
# The metal-agent is a dependency-free `bun run` and deliberately carries no OTel
# SDK; it logs to stdout, which systemd captures in journald. To get those logs
# into SigNoz WITHOUT an in-agent SDK (and without the Bun OTLP-export fragility
# we hit in the API), a tiny sidecar collector tails the metal-agent journal and
# ships it over OTLP/HTTP. This is the bare-metal analogue of the k8s-infra
# otelAgent DaemonSet that scrapes pod stdout in-cluster.
#
# Gated on OTEL_EXPORTER_OTLP_ENDPOINT being set in /etc/metal-agent.env: an
# unconfigured host skips the (large) collector download entirely and never
# crash-loops. Burst hosts get the endpoint+key from cloud-init, so they install
# and start it automatically. Re-run this script on an existing host after
# populating the endpoint to add the shipper.
if grep -qE "^OTEL_EXPORTER_OTLP_ENDPOINT=['\"]?[^'\"[:space:]]" /etc/metal-agent.env 2>/dev/null; then
  OTELCOL_VERSION="${OTELCOL_VERSION:-0.139.0}"
  case "$ARCH" in
    x86_64) OTELCOL_ARCH=amd64 ;;
    aarch64|arm64) OTELCOL_ARCH=arm64 ;;
    *) OTELCOL_ARCH="$ARCH" ;;
  esac

  if [ ! -x /usr/local/bin/otelcol-contrib ]; then
    log "installing otelcol-contrib v${OTELCOL_VERSION} (${OTELCOL_ARCH}) for host log shipping..."
    curl -fsSL \
      "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${OTELCOL_VERSION}/otelcol-contrib_${OTELCOL_VERSION}_linux_${OTELCOL_ARCH}.tar.gz" \
      -o /tmp/otelcol-contrib.tgz
    tar -xzf /tmp/otelcol-contrib.tgz -C /tmp otelcol-contrib
    install -m0755 /tmp/otelcol-contrib /usr/local/bin/otelcol-contrib
    rm -f /tmp/otelcol-contrib.tgz /tmp/otelcol-contrib
  fi
  /usr/local/bin/otelcol-contrib --version | head -1 || true

  install -d /etc/otelcol-metal /var/lib/otelcol-metal

  # Config uses ${env:...} substitution resolved by the collector at start from
  # the systemd EnvironmentFile (/etc/metal-agent.env). Quoted heredoc so the
  # shell does NOT expand these — the collector must see them literally.
  cat > /etc/otelcol-metal/config.yaml <<'OTELCOL_CFG'
# Managed by scripts/metal-agent/host-bootstrap.sh — host-local log shipper for
# the bare-metal Firecracker fleet. Tails the metal-agent journald unit and
# exports to SigNoz over OTLP/HTTP. See terraform/modules/signoz/README.md.
extensions:
  # Persist the journald read cursor + export queue across restarts so a code
  # deploy / collector restart neither replays the whole journal nor drops logs.
  file_storage/state:
    directory: /var/lib/otelcol-metal

receivers:
  journald:
    units:
      - metal-agent.service
    # First start (no cursor yet) begins at the journal tail; subsequent starts
    # resume from the persisted cursor.
    start_at: end
    storage: file_storage/state
    operators:
      # journald PRIORITY (syslog severity) -> OTel severity.
      - type: severity_parser
        parse_from: body.PRIORITY
        mapping:
          fatal: ["0", "1", "2"]
          error: "3"
          warn: "4"
          info: ["5", "6"]
          debug: "7"
      # Surface the human message as the log body (instead of the raw journal map).
      - type: move
        from: body.MESSAGE
        to: body

processors:
  memory_limiter:
    check_interval: 5s
    limit_mib: 128
  resourcedetection/system:
    detectors: [env, system]
    system:
      hostname_sources: [os]
  resource:
    attributes:
      - { key: service.name, value: metal-agent, action: upsert }
      - { key: service.namespace, value: metal-fleet, action: upsert }
      - { key: metal.host.id, value: "${env:METAL_HOST_ID}", action: upsert }
      - { key: metal.region, value: "${env:METAL_REGION}", action: upsert }
  batch:
    timeout: 5s
    send_batch_size: 512

exporters:
  otlphttp/signoz:
    # SigNoz Cloud ingest; otlphttp appends /v1/logs. Same endpoint + key the
    # API pod uses.
    endpoint: "${env:OTEL_EXPORTER_OTLP_ENDPOINT}"
    headers:
      signoz-ingestion-key: "${env:SIGNOZ_INGESTION_KEY}"
    retry_on_failure:
      enabled: true
    sending_queue:
      enabled: true
      storage: file_storage/state

service:
  telemetry:
    logs:
      level: warn
  extensions: [file_storage/state]
  pipelines:
    logs:
      receivers: [journald]
      processors: [memory_limiter, resourcedetection/system, resource, batch]
      exporters: [otlphttp/signoz]
OTELCOL_CFG

  cat > /etc/systemd/system/otelcol-metal.service <<'OTELCOL_UNIT'
[Unit]
Description=Shogo metal host log shipper (metal-agent journald -> SigNoz)
After=network-online.target metal-agent.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/metal-agent.env
# Do nothing (cleanly) when no SigNoz endpoint is configured — never crash-loop.
ExecStartPre=/bin/sh -c 'test -n "$OTEL_EXPORTER_OTLP_ENDPOINT" || { echo "otelcol-metal: OTEL_EXPORTER_OTLP_ENDPOINT unset; nothing to ship"; exit 1; }'
ExecStart=/usr/local/bin/otelcol-contrib --config /etc/otelcol-metal/config.yaml
Restart=on-failure
RestartSec=5
# Reading the systemd journal needs privilege; the host is single-tenant.
User=root
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
OTELCOL_UNIT

  systemctl daemon-reload
  log "starting host log shipper (otelcol-metal -> SigNoz)..."
  systemctl enable --now otelcol-metal || log "WARN: otelcol-metal failed to start (check: journalctl -u otelcol-metal)"
else
  log "host log shipper skipped (OTEL_EXPORTER_OTLP_ENDPOINT not set in /etc/metal-agent.env)"
fi

log "done. push node-agent code + rootfs to the host, then: systemctl enable --now metal-agent"
