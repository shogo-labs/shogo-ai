#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Shogo Technologies, Inc.
#
# Build a Ubuntu 22.04 VM image for Shogo desktop VM isolation.
#
# Usage:
#   ./build.sh [aarch64|x86_64]
#
# Requires: qemu-system, qemu-img, cloud-image-utils (cloud-localds), wget
#
# Produces:
#   output/<arch>/vmlinuz
#   output/<arch>/initrd.img
#   output/<arch>/rootfs.qcow2

set -euo pipefail

ARCH="${1:-$(uname -m)}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="${SCRIPT_DIR}/output/${ARCH}"
WORK_DIR="${SCRIPT_DIR}/.work/${ARCH}"
CLOUD_IMAGE_BASE="https://cloud-images.ubuntu.com/jammy/current"

QEMU_ACCEL=""
if [ -w /dev/kvm ]; then
  QEMU_ACCEL="-accel kvm"
  echo "KVM acceleration available"
fi

case "$ARCH" in
  aarch64|arm64)
    ARCH="aarch64"
    CLOUD_IMAGE="jammy-server-cloudimg-arm64.img"
    QEMU_SYSTEM="qemu-system-aarch64"
    QEMU_MACHINE="-machine virt -cpu cortex-a72"
    QEMU_ACCEL=""  # KVM only works for native arch
    ;;
  x86_64|amd64)
    ARCH="x86_64"
    CLOUD_IMAGE="jammy-server-cloudimg-amd64.img"
    QEMU_SYSTEM="qemu-system-x86_64"
    QEMU_MACHINE="-machine q35 -cpu max"
    ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

mkdir -p "$OUTPUT_DIR" "$WORK_DIR"

echo "=== Building Shogo VM image for ${ARCH} ==="

# Step 1: Download cloud image
if [ ! -f "${WORK_DIR}/${CLOUD_IMAGE}" ]; then
  echo "Downloading Ubuntu 22.04 cloud image..."
  wget -q -O "${WORK_DIR}/${CLOUD_IMAGE}" "${CLOUD_IMAGE_BASE}/${CLOUD_IMAGE}"
fi

# Step 2: Create a working copy with extra space
echo "Creating working disk..."
cp "${WORK_DIR}/${CLOUD_IMAGE}" "${WORK_DIR}/disk.qcow2"
qemu-img resize "${WORK_DIR}/disk.qcow2" 10G

# Step 3: Create cloud-init seed
echo "Creating cloud-init seed..."
cat > "${WORK_DIR}/user-data" << 'USERDATA'
#cloud-config
password: shogo
chpasswd:
  expire: false
ssh_pwauth: true

packages:
  - curl
  - wget
  - git
  - openssh-client
  - build-essential
  - python3
  - python3-pip
  - jq
  - ripgrep
  - ffmpeg
  - imagemagick
  - bubblewrap
  - unzip

runcmd:
  # Install Bun
  - curl -fsSL https://bun.sh/install | bash
  - ln -sf /root/.bun/bin/bun /usr/local/bin/bun
  
  # Install Node.js LTS via NodeSource
  - curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
  - apt-get install -y nodejs
  
  # Install gh CLI
  - curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
  - echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null
  - apt-get update && apt-get install -y gh
  
  # Create shogo user
  - useradd -m -s /bin/bash shogo
  - echo "shogo ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
  
  # Install global Node packages (matches Docker Dockerfile.base)
  - npm install -g typescript-language-server typescript pyright
  
  # Pre-install skill-server template with Linux-native Prisma (matches Docker Dockerfile)
  - |
    mkdir -p /app/templates/skill-server
    printf '{"name":"skill-server","private":true,"dependencies":{"hono":"^4.7.0","prisma":"7.4.1","@prisma/client":"7.4.1","prisma-adapter-bun-sqlite":"^0.6.8"}}' \
      > /app/templates/skill-server/package.json
    cd /app/templates/skill-server && /usr/local/bin/bun install
  
  # Install agent-runtime bundle (same process as K8s pods)
  - mkdir -p /opt/shogo
  
  # Create systemd service for agent-runtime in pool mode
  - |
    cat > /etc/systemd/system/shogo-agent-runtime.service << 'EOF'
    [Unit]
    Description=Shogo Agent Runtime (pool mode)
    After=network.target
    
    [Service]
    Type=simple
    User=shogo
    WorkingDirectory=/workspace
    ExecStart=/usr/local/bin/bun run /opt/shogo/agent-runtime.js
    Restart=always
    RestartSec=2
    Environment=PROJECT_ID=__POOL__
    Environment=PORT=8080
    
    [Install]
    WantedBy=multi-user.target
    EOF
  - systemctl daemon-reload
  - systemctl enable shogo-agent-runtime
  
  # Clean up
  - apt-get clean
  - rm -rf /var/lib/apt/lists/*
  
  # Signal completion
  - touch /var/lib/cloud/instance/shogo-provisioned
  - poweroff
USERDATA

cat > "${WORK_DIR}/meta-data" << METADATA
instance-id: shogo-build-$(date +%s)
local-hostname: shogo-vm
METADATA

# Create seed ISO
cloud-localds "${WORK_DIR}/seed.iso" "${WORK_DIR}/user-data" "${WORK_DIR}/meta-data" 2>/dev/null || \
  genisoimage -output "${WORK_DIR}/seed.iso" -volid cidata -joliet -rock "${WORK_DIR}/user-data" "${WORK_DIR}/meta-data"

# Step 3.5: Bundle agent-runtime.js into the image via a second cloud-init file
# The agent-runtime bundle is built by the monorepo build system and placed at
# packages/agent-runtime/dist/agent-runtime.js (or bundle/agent-runtime.js for production).
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
AGENT_RUNTIME_BUNDLE=""
for candidate in \
  "${REPO_ROOT}/bundle/agent-runtime.js" \
  "${REPO_ROOT}/packages/agent-runtime/dist/agent-runtime.js"; do
  if [ -f "$candidate" ]; then
    AGENT_RUNTIME_BUNDLE="$candidate"
    break
  fi
done

if [ -n "$AGENT_RUNTIME_BUNDLE" ]; then
  echo "Bundling agent-runtime from: ${AGENT_RUNTIME_BUNDLE}"
  mkdir -p "${WORK_DIR}/provision"
  cp "$AGENT_RUNTIME_BUNDLE" "${WORK_DIR}/provision/agent-runtime.js"
else
  echo "WARNING: agent-runtime bundle not found. The VM image will need it copied at boot time."
fi

# Step 4: Boot and provision
TIMEOUT=${QEMU_TIMEOUT:-1200}
echo "Booting VM for provisioning (timeout: ${TIMEOUT}s)..."
timeout "$TIMEOUT" $QEMU_SYSTEM \
  $QEMU_ACCEL \
  $QEMU_MACHINE \
  -m 4096 -smp 4 \
  -drive file="${WORK_DIR}/disk.qcow2",if=virtio \
  -drive file="${WORK_DIR}/seed.iso",if=virtio,format=raw,readonly=on \
  -netdev user,id=net0 \
  -device virtio-net-pci,netdev=net0 \
  -nographic \
  -no-reboot || true

echo "Provisioning complete."

# Step 5: Extract kernel and initrd from the image
echo "Extracting kernel and initrd..."

if command -v virt-ls &>/dev/null && command -v virt-copy-out &>/dev/null; then
  # Preferred: libguestfs works in userspace without kernel modules (CI-friendly)
  echo "Using libguestfs (virt-copy-out) for extraction..."
  VMLINUZ=$(virt-ls -a "${WORK_DIR}/disk.qcow2" /boot/ 2>/dev/null | grep '^vmlinuz-' | sort -V | tail -1)
  INITRD=$(virt-ls -a "${WORK_DIR}/disk.qcow2" /boot/ 2>/dev/null | grep '^initrd.img-' | sort -V | tail -1)

  if [ -n "$VMLINUZ" ] && [ -n "$INITRD" ]; then
    virt-copy-out -a "${WORK_DIR}/disk.qcow2" "/boot/$VMLINUZ" "$OUTPUT_DIR"
    virt-copy-out -a "${WORK_DIR}/disk.qcow2" "/boot/$INITRD" "$OUTPUT_DIR"
    mv "${OUTPUT_DIR}/${VMLINUZ}" "${OUTPUT_DIR}/vmlinuz"
    mv "${OUTPUT_DIR}/${INITRD}" "${OUTPUT_DIR}/initrd.img"
  else
    echo "ERROR: Could not find kernel/initrd in the image via virt-ls"
    exit 1
  fi
elif command -v qemu-nbd &>/dev/null; then
  # Fallback: qemu-nbd requires the nbd kernel module (works on local dev machines)
  echo "Using qemu-nbd for extraction..."
  MOUNT_DIR="${WORK_DIR}/mnt"
  mkdir -p "$MOUNT_DIR"

  sudo modprobe nbd max_part=8 2>/dev/null || true
  sudo qemu-nbd --connect=/dev/nbd0 "${WORK_DIR}/disk.qcow2"
  sleep 1
  sudo mount /dev/nbd0p1 "$MOUNT_DIR" 2>/dev/null || sudo mount /dev/nbd0p2 "$MOUNT_DIR"

  VMLINUZ=$(ls "$MOUNT_DIR"/boot/vmlinuz-* 2>/dev/null | sort -V | tail -1)
  INITRD=$(ls "$MOUNT_DIR"/boot/initrd.img-* 2>/dev/null | sort -V | tail -1)

  if [ -n "$VMLINUZ" ] && [ -n "$INITRD" ]; then
    sudo cp "$VMLINUZ" "${OUTPUT_DIR}/vmlinuz"
    sudo cp "$INITRD" "${OUTPUT_DIR}/initrd.img"
    sudo chown "$(whoami)" "${OUTPUT_DIR}/vmlinuz" "${OUTPUT_DIR}/initrd.img"
  else
    echo "ERROR: Could not find kernel/initrd in the image"
    sudo umount "$MOUNT_DIR"
    sudo qemu-nbd --disconnect /dev/nbd0
    exit 1
  fi

  sudo umount "$MOUNT_DIR"
  sudo qemu-nbd --disconnect /dev/nbd0
else
  echo "ERROR: Neither libguestfs-tools nor qemu-nbd available for kernel extraction."
  echo "Install libguestfs-tools (apt install libguestfs-tools) or qemu-utils."
  exit 1
fi

# Step 6: Decompress kernel for Virtualization.framework (arm64)
if [ "$ARCH" = "aarch64" ] && file "${OUTPUT_DIR}/vmlinuz" | grep -q "gzip"; then
  echo "Decompressing arm64 kernel for Virtualization.framework..."
  mv "${OUTPUT_DIR}/vmlinuz" "${OUTPUT_DIR}/vmlinuz.gz"
  gzip -d "${OUTPUT_DIR}/vmlinuz.gz"
  echo "Kernel decompressed: $(file "${OUTPUT_DIR}/vmlinuz")"
fi

# Step 7: Shrink and copy rootfs
echo "Shrinking rootfs..."
qemu-img convert -O qcow2 -c "${WORK_DIR}/disk.qcow2" "${OUTPUT_DIR}/rootfs.qcow2"

# Also produce a raw image for Virtualization.framework (macOS)
if [ "$ARCH" = "aarch64" ]; then
  echo "Converting rootfs to raw for Virtualization.framework..."
  qemu-img convert -f qcow2 -O raw "${OUTPUT_DIR}/rootfs.qcow2" "${OUTPUT_DIR}/rootfs.raw"
fi

echo ""
echo "=== Build complete ==="
echo "Output:"
ls -lh "${OUTPUT_DIR}/"
echo ""
echo "Files:"
echo "  ${OUTPUT_DIR}/vmlinuz      - Linux kernel (decompressed for VZ on arm64)"
echo "  ${OUTPUT_DIR}/initrd.img   - Initial ramdisk"
echo "  ${OUTPUT_DIR}/rootfs.qcow2 - Root filesystem (qcow2, for Windows/QEMU)"
[ "$ARCH" = "aarch64" ] && echo "  ${OUTPUT_DIR}/rootfs.raw   - Root filesystem (raw, for macOS/VZ)"
