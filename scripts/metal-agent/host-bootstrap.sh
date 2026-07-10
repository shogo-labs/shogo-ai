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

ARCH="$(uname -m)"  # x86_64 on Latitude s3-large-x86 / c3-large-x86
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
# On SIGTERM the agent releases only warm VMs and exits fast; give it room but
# don't let a hang wedge the deploy.
TimeoutStopSec=30
# microVMs + KVM need broad privileges; this host is single-tenant.
User=root
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload

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
