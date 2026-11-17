#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Shogo Technologies, Inc.
#
# CI: boot real Firecracker microVMs on this runner and check that a
# per-project machine size (Settings → Machine) reaches the guest — standard,
# upgrade, downgrade (apps/metal-agent/src/e2e-vm-size.ts).
#
# Uses the production hosts' Firecracker and guest kernel versions
# (scripts/metal-agent/host-bootstrap.sh). The guest is a busybox rootfs whose
# init prints `nproc` and MemTotal to the serial console and powers off, so no
# runtime image is needed. Needs /dev/kvm and sudo.
set -euo pipefail

FC_VERSION="${FC_VERSION:-1.16.1}"
KERNEL_URL="${KERNEL_URL:-https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.10/x86_64/vmlinux-6.1.102}"
WORK="${METAL_WORK:-$RUNNER_TEMP/fc-vm-size}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

[ -e /dev/kvm ] || { echo "::error::/dev/kvm missing on this runner"; exit 2; }
sudo mkdir -p "$WORK/bin" "$WORK/img" "$WORK/run"
sudo chown -R "$(id -u):$(id -g)" "$WORK"

if [ ! -x "$WORK/bin/firecracker" ]; then
  curl -fsSL "https://github.com/firecracker-microvm/firecracker/releases/download/v${FC_VERSION}/firecracker-v${FC_VERSION}-x86_64.tgz" \
    | tar -xz -C "$WORK"
  install -m0755 "$WORK/release-v${FC_VERSION}-x86_64/firecracker-v${FC_VERSION}-x86_64" "$WORK/bin/firecracker"
fi
[ -f "$WORK/img/vmlinux" ] || curl -fsSL "$KERNEL_URL" -o "$WORK/img/vmlinux"

# Guest rootfs: static busybox + an init that reports the size and powers off.
command -v busybox >/dev/null || sudo apt-get install -y -qq busybox-static
BB="$(command -v busybox)"
STAGE="$(mktemp -d)"
mkdir -p "$STAGE"/{bin,sbin,proc,sys,dev}
cp "$BB" "$STAGE/bin/busybox"
for a in sh mount nproc awk cat echo reboot poweroff sync; do ln -sf busybox "$STAGE/bin/$a"; done
cat > "$STAGE/sbin/size-init" <<'INIT'
#!/bin/sh
mount -t proc proc /proc
mount -t sysfs sys /sys
echo "SHOGO_SIZE nproc=$(nproc) memkb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)"
sync
reboot -f
INIT
chmod +x "$STAGE/sbin/size-init"
rm -f "$WORK/img/rootfs.ext4"
truncate -s 32M "$WORK/img/rootfs.ext4"
mkfs.ext4 -q -F -d "$STAGE" "$WORK/img/rootfs.ext4"
rm -rf "$STAGE"

cd "$ROOT/apps/metal-agent"
sudo env "PATH=$PATH" \
  METAL_WORK="$WORK" \
  METAL_FC_BIN="$WORK/bin/firecracker" \
  METAL_KERNEL="$WORK/img/vmlinux" \
  METAL_ROOTFS="$WORK/img/rootfs.ext4" \
  METAL_RUN="$WORK/run" \
  METAL_SNAP="$WORK/snapshots" \
  METAL_GUEST_INIT=/sbin/size-init \
  METAL_ROOTFS_COW=full \
  METAL_WORKSPACE_DRIVE_MIB=0 \
  METAL_SNAP_BALLOON=0 \
  METAL_VCPUS="${METAL_VCPUS:-1}" \
  METAL_MEM_MIB="${METAL_MEM_MIB:-256}" \
  E2E_UP_VCPUS="${E2E_UP_VCPUS:-2}" \
  E2E_UP_MEM_MIB="${E2E_UP_MEM_MIB:-768}" \
  "$(command -v bun)" run src/e2e-vm-size.ts
