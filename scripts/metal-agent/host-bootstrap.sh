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
  e2fsprogs >/dev/null
log "base packages ok"

# --- Persistent IP forwarding (guest DNAT routing depends on it) ------------
log "enabling net.ipv4.ip_forward (persistent)..."
cat > /etc/sysctl.d/99-metal-agent.conf <<'SYSCTL'
net.ipv4.ip_forward=1
net.ipv4.conf.all.rp_filter=0
SYSCTL
sysctl -p /etc/sysctl.d/99-metal-agent.conf >/dev/null

# --- Firecracker + guest kernel ---------------------------------------------
mkdir -p "$WORK/bin" "$WORK/img" "$WORK/run" "$WORK/snapshots"
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
