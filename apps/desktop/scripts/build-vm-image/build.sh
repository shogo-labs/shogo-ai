#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Shogo Technologies, Inc.
#
# Build a Ubuntu 24.04 VM image for Shogo desktop VM isolation.
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
CLOUD_IMAGE_BASE="https://cloud-images.ubuntu.com/noble/current"

QEMU_ACCEL=""
if [ -w /dev/kvm ]; then
  QEMU_ACCEL="-accel kvm"
  echo "KVM acceleration available"
fi

case "$ARCH" in
  aarch64|arm64)
    ARCH="aarch64"
    CLOUD_IMAGE="noble-server-cloudimg-arm64.img"
    QEMU_SYSTEM="qemu-system-aarch64"
    QEMU_MACHINE="-machine virt -cpu cortex-a72"
    QEMU_ACCEL=""  # KVM only works for native arch
    ;;
  x86_64|amd64)
    ARCH="x86_64"
    CLOUD_IMAGE="noble-server-cloudimg-amd64.img"
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
  echo "Downloading Ubuntu 24.04 cloud image..."
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
  - python3
  - python3-pip
  - jq
  - ripgrep
  - bubblewrap
  - unzip

runcmd:
  # Install Bun as a regular file (not symlink) for the guest architecture
  - |
    ARCH=$(uname -m)
    if [ "$ARCH" = "aarch64" ]; then
      BUN_PKG="bun-linux-aarch64"
    else
      BUN_PKG="bun-linux-x64-baseline"
    fi
    BUN_VER="1.3.11"
    cd /tmp
    curl -fsSL -o bun-dl.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VER}/${BUN_PKG}.zip"
    unzip -o bun-dl.zip -d bun-extract
    cp bun-extract/${BUN_PKG}/bun /usr/local/bin/bun
    chmod 755 /usr/local/bin/bun
    rm -rf bun-dl.zip bun-extract
    for alias in node npx npm; do
      ln -sf /usr/local/bin/bun /usr/local/bin/$alias
    done
    echo "bun ready: $(/usr/local/bin/bun --version)"
  
  # Install gh CLI
  - curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
  - echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null
  - apt-get update && apt-get install -y gh
  
  # Create shogo user
  - useradd -m -s /bin/bash shogo
  - echo "shogo ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
  
  # Install global Node packages (matches Docker Dockerfile.base)
  - /usr/local/bin/bun add -g typescript-language-server typescript pyright
  
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
  
  # Disable unnecessary services to reduce idle memory
  - systemctl disable --now snapd snapd.socket snapd.seeded 2>/dev/null || true
  - systemctl disable --now ModemManager packagekit 2>/dev/null || true
  - systemctl mask apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
  
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

EXTRACTED=false

# Method 1: losetup on raw conversion (reliable on any Linux, no kernel module needed)
echo "Trying losetup (raw conversion) for extraction..."
if (
  set +e
  MOUNT_DIR="${WORK_DIR}/mnt"
  mkdir -p "$MOUNT_DIR"

  echo "  Converting qcow2 to raw for loop mount..."
  qemu-img convert -O raw "${WORK_DIR}/disk.qcow2" "${WORK_DIR}/disk.raw" || exit 1

  LOOP_DEV=$(sudo losetup --find --show --partscan "${WORK_DIR}/disk.raw" 2>/dev/null) || exit 1
  echo "  Loop device: $LOOP_DEV"
  sleep 2

  echo "  Partition table:"
  sudo fdisk -l "${WORK_DIR}/disk.raw" 2>/dev/null || true

  # Scan ALL partitions for vmlinuz.
  # On Ubuntu 24.04, /boot is a DEDICATED partition. When mounted at $MOUNT_DIR,
  # kernel files are at $MOUNT_DIR/vmlinuz-* (top of the /boot partition),
  # NOT at $MOUNT_DIR/boot/vmlinuz-*. Also check the latter for older layouts.
  FOUND_VMLINUZ=""
  FOUND_INITRD=""
  FOUND_PART=""
  FOUND_PREFIX=""
  for part in $(sudo ls "${LOOP_DEV}p"* 2>/dev/null | sort -V); do
    if [ -b "$part" ]; then
      echo "  Trying $part..."
      if sudo mount -o ro,noload "$part" "$MOUNT_DIR" 2>/dev/null || sudo mount -o ro "$part" "$MOUNT_DIR" 2>/dev/null; then
        echo "    Mounted OK. Top-level contents:"
        sudo ls "$MOUNT_DIR"/ 2>/dev/null || true
        # Check top-level (for dedicated /boot partition)
        V=$(sudo ls "$MOUNT_DIR"/vmlinuz-* 2>/dev/null | sort -V | tail -1 || true)
        I=$(sudo ls "$MOUNT_DIR"/initrd.img-* 2>/dev/null | sort -V | tail -1 || true)
        PREFIX=""
        # Fallback: check $MOUNT_DIR/boot/ (for root partition with embedded /boot)
        if [ -z "$V" ] || [ -z "$I" ]; then
          V=$(sudo ls "$MOUNT_DIR"/boot/vmlinuz-* 2>/dev/null | sort -V | tail -1 || true)
          I=$(sudo ls "$MOUNT_DIR"/boot/initrd.img-* 2>/dev/null | sort -V | tail -1 || true)
          PREFIX="boot/"
        fi
        sudo umount "$MOUNT_DIR" 2>/dev/null || true
        if [ -n "$V" ] && [ -n "$I" ]; then
          FOUND_VMLINUZ="$V"
          FOUND_INITRD="$I"
          FOUND_PART="$part"
          FOUND_PREFIX="$PREFIX"
          echo "    Found kernel: $(basename "$V") (prefix: '${PREFIX}')"
          break
        fi
      fi
    fi
  done

  if [ -n "$FOUND_VMLINUZ" ] && [ -n "$FOUND_INITRD" ]; then
    if sudo mount -o ro,noload "$FOUND_PART" "$MOUNT_DIR" 2>/dev/null || sudo mount -o ro "$FOUND_PART" "$MOUNT_DIR" 2>/dev/null; then
      echo "Found: $(basename "$FOUND_VMLINUZ"), $(basename "$FOUND_INITRD") on $FOUND_PART"
      sudo cp "$MOUNT_DIR/${FOUND_PREFIX}$(basename "$FOUND_VMLINUZ")" "${OUTPUT_DIR}/vmlinuz"
      sudo cp "$MOUNT_DIR/${FOUND_PREFIX}$(basename "$FOUND_INITRD")" "${OUTPUT_DIR}/initrd.img"
      sudo chown "$(whoami)" "${OUTPUT_DIR}/vmlinuz" "${OUTPUT_DIR}/initrd.img"
      sudo umount "$MOUNT_DIR" 2>/dev/null || true
      echo "EXTRACTED_OK"
    fi
  else
    echo "  No vmlinuz found on any partition"
  fi

  sudo losetup -d "$LOOP_DEV" 2>/dev/null || true
  rm -f "${WORK_DIR}/disk.raw"
) 2>&1 | tee /tmp/losetup-extract.log && grep -q "EXTRACTED_OK" /tmp/losetup-extract.log; then
  EXTRACTED=true
else
  echo "losetup extraction failed, trying qemu-nbd..."
fi

# Method 2: qemu-nbd
if [ "$EXTRACTED" = false ] && command -v qemu-nbd &>/dev/null; then
  echo "Trying qemu-nbd for extraction..."
  if (
    set +e
    sudo modprobe nbd max_part=8 2>/dev/null || exit 1
    MOUNT_DIR="${WORK_DIR}/mnt"
    mkdir -p "$MOUNT_DIR"

    sudo qemu-nbd --connect=/dev/nbd0 "${WORK_DIR}/disk.qcow2" || exit 1
    sleep 3
    sudo partprobe /dev/nbd0 2>/dev/null || true
    sleep 1

    MOUNTED=false
    for part in /dev/nbd0p1 /dev/nbd0p2 /dev/nbd0p3; do
      if [ -b "$part" ]; then
        if sudo mount -o ro,noload "$part" "$MOUNT_DIR" 2>/dev/null || sudo mount -o ro "$part" "$MOUNT_DIR" 2>/dev/null; then
          MOUNTED=true
          echo "  Mounted $part"
          break
        fi
      fi
    done

    if [ "$MOUNTED" = true ]; then
      VMLINUZ=$(ls "$MOUNT_DIR"/boot/vmlinuz-* 2>/dev/null | sort -V | tail -1)
      INITRD=$(ls "$MOUNT_DIR"/boot/initrd.img-* 2>/dev/null | sort -V | tail -1)
      if [ -n "$VMLINUZ" ] && [ -n "$INITRD" ]; then
        echo "Found: $(basename "$VMLINUZ"), $(basename "$INITRD")"
        sudo cp "$VMLINUZ" "${OUTPUT_DIR}/vmlinuz"
        sudo cp "$INITRD" "${OUTPUT_DIR}/initrd.img"
        sudo chown "$(whoami)" "${OUTPUT_DIR}/vmlinuz" "${OUTPUT_DIR}/initrd.img"
        echo "EXTRACTED_OK"
      fi
      sudo umount "$MOUNT_DIR" 2>/dev/null || true
    fi

    sudo qemu-nbd --disconnect /dev/nbd0 2>/dev/null || true
  ) 2>&1 | tee /tmp/nbd-extract.log && grep -q "EXTRACTED_OK" /tmp/nbd-extract.log; then
    EXTRACTED=true
  else
    echo "qemu-nbd extraction failed, trying libguestfs..."
  fi
fi

# Method 3: libguestfs
if [ "$EXTRACTED" = false ] && command -v virt-ls &>/dev/null && command -v virt-copy-out &>/dev/null; then
  export LIBGUESTFS_BACKEND=direct
  echo "Trying libguestfs (virt-copy-out) for extraction..."
  VMLINUZ=$(virt-ls -a "${WORK_DIR}/disk.qcow2" /boot/ 2>/dev/null | grep '^vmlinuz-' | sort -V | tail -1 || true)
  INITRD=$(virt-ls -a "${WORK_DIR}/disk.qcow2" /boot/ 2>/dev/null | grep '^initrd.img-' | sort -V | tail -1 || true)

  if [ -n "$VMLINUZ" ] && [ -n "$INITRD" ]; then
    echo "Found: $VMLINUZ, $INITRD"
    virt-copy-out -a "${WORK_DIR}/disk.qcow2" "/boot/$VMLINUZ" "$OUTPUT_DIR"
    virt-copy-out -a "${WORK_DIR}/disk.qcow2" "/boot/$INITRD" "$OUTPUT_DIR"
    mv "${OUTPUT_DIR}/${VMLINUZ}" "${OUTPUT_DIR}/vmlinuz"
    mv "${OUTPUT_DIR}/${INITRD}" "${OUTPUT_DIR}/initrd.img"
    EXTRACTED=true
  else
    echo "libguestfs could not list /boot/ contents"
  fi
fi

if [ "$EXTRACTED" = false ]; then
  echo "ERROR: Could not extract kernel/initrd from the image."
  echo "Ensure qemu-utils (for qemu-nbd) or libguestfs-tools is installed."
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

# The build already provisions bun, deps, and templates, so this IS the
# provisioned image. Copy it so the desktop app's ensureOverlay picks it up.
cp "${OUTPUT_DIR}/rootfs.qcow2" "${OUTPUT_DIR}/rootfs-provisioned.qcow2"

echo ""
echo "=== Build complete ==="
echo "Output:"
ls -lh "${OUTPUT_DIR}/"
echo ""
echo "Files:"
echo "  ${OUTPUT_DIR}/vmlinuz                  - Linux kernel (decompressed for VZ on arm64)"
echo "  ${OUTPUT_DIR}/initrd.img               - Initial ramdisk"
echo "  ${OUTPUT_DIR}/rootfs.qcow2             - Root filesystem (base)"
echo "  ${OUTPUT_DIR}/rootfs-provisioned.qcow2 - Root filesystem (provisioned with bun + deps)"
