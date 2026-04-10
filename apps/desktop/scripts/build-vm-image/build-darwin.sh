#!/bin/bash
# Build a provisioned VM image on macOS (aarch64 with HVF acceleration).
#
# This is the macOS equivalent of build.sh (which targets Linux CI).
# Key differences:
#   - Uses HVF hardware acceleration (native speed vs TCG emulation)
#   - Uses hdiutil for seed ISO creation (no cloud-localds needed)
#   - Reuses kernel/initrd from an existing CI release or extracts via qemu
#
# Usage:
#   ./build-darwin.sh
#
# Requires: qemu-system-aarch64, qemu-img (brew install qemu)

set -euo pipefail

ARCH="aarch64"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="${SCRIPT_DIR}/output/${ARCH}"
WORK_DIR="${SCRIPT_DIR}/.work/${ARCH}"
CLOUD_IMAGE_BASE="https://cloud-images.ubuntu.com/noble/current"
CLOUD_IMAGE="noble-server-cloudimg-arm64.img"

mkdir -p "$OUTPUT_DIR" "$WORK_DIR"

echo "=== Building Shogo VM image for ${ARCH} (macOS HVF) ==="

# Step 1: Download cloud image
if [ ! -f "${WORK_DIR}/${CLOUD_IMAGE}" ]; then
  echo "Downloading Ubuntu 24.04 cloud image..."
  curl -fSL -o "${WORK_DIR}/${CLOUD_IMAGE}" "${CLOUD_IMAGE_BASE}/${CLOUD_IMAGE}"
fi

# Step 2: Create a working copy with extra space
echo "Creating working disk..."
cp "${WORK_DIR}/${CLOUD_IMAGE}" "${WORK_DIR}/disk.qcow2"
qemu-img resize "${WORK_DIR}/disk.qcow2" 10G

# Step 3: Create cloud-init seed ISO using hdiutil
echo "Creating cloud-init seed..."
SEED_TMP="${WORK_DIR}/seed-tmp"
rm -rf "$SEED_TMP"
mkdir -p "$SEED_TMP"

cat > "${SEED_TMP}/user-data" << 'USERDATA'
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
  - echo "=== PROVISIONING COMPLETE ==="
  - poweroff
USERDATA

cat > "${SEED_TMP}/meta-data" << METADATA
instance-id: shogo-build-$(date +%s)
local-hostname: shogo-vm
METADATA

SEED_ISO="${WORK_DIR}/seed.iso"
rm -f "$SEED_ISO"
hdiutil makehybrid -o "$SEED_ISO" "$SEED_TMP" -iso -joliet -default-volume-name cidata
rm -rf "$SEED_TMP"

# Step 4: Boot and provision with HVF acceleration
# aarch64 requires UEFI firmware to boot from disk (no legacy BIOS).
# We also add a serial console for output visibility.
EFI_CODE="/opt/homebrew/share/qemu/edk2-aarch64-code.fd"
if [ ! -f "$EFI_CODE" ]; then
  echo "ERROR: UEFI firmware not found at $EFI_CODE"
  echo "Install with: brew install qemu"
  exit 1
fi

# Create writable EFI vars file
EFI_VARS="${WORK_DIR}/efi-vars.fd"
dd if=/dev/zero of="$EFI_VARS" bs=1m count=64 2>/dev/null

echo ""
echo "Booting VM for provisioning (HVF acceleration, expect ~5 min)..."
echo "Console output will stream below:"
echo "---"

qemu-system-aarch64 \
  -accel hvf \
  -machine virt \
  -cpu host \
  -m 4096 -smp 4 \
  -drive if=pflash,format=raw,readonly=on,file="$EFI_CODE" \
  -drive if=pflash,format=raw,file="$EFI_VARS" \
  -drive file="${WORK_DIR}/disk.qcow2",if=virtio \
  -drive file="${SEED_ISO}",if=virtio,format=raw,readonly=on \
  -netdev user,id=net0 \
  -device virtio-net-pci,netdev=net0 \
  -serial mon:stdio \
  -nographic \
  -no-reboot

echo "---"
echo "VM provisioning complete (guest powered off)."

# Step 5: Kernel/initrd extraction
# On macOS we can't easily mount qcow2 images. Use the kernel+initrd from
# the CI release (same Ubuntu base) or from the local resources directory.
echo ""
echo "Checking for kernel/initrd..."
KERNEL_SOURCE=""

if [ -f "${OUTPUT_DIR}/vmlinuz" ] && [ -f "${OUTPUT_DIR}/initrd.img" ]; then
  echo "Using existing kernel/initrd in output directory."
  KERNEL_SOURCE="existing"
fi

# Try CI release
if [ -z "$KERNEL_SOURCE" ]; then
  echo "Downloading kernel/initrd from CI release..."
  RELEASE_TMP="${WORK_DIR}/release-tmp"
  mkdir -p "$RELEASE_TMP"
  if command -v gh &>/dev/null; then
    gh release download vm-images-v3 --repo shogo-labs/shogo-ai \
      --pattern 'vm-image-aarch64.tar.gz' --dir "$RELEASE_TMP" 2>/dev/null || true
    if [ -f "${RELEASE_TMP}/vm-image-aarch64.tar.gz" ]; then
      tar xzf "${RELEASE_TMP}/vm-image-aarch64.tar.gz" -C "$RELEASE_TMP"
      cp "${RELEASE_TMP}/vmlinuz" "${OUTPUT_DIR}/vmlinuz"
      cp "${RELEASE_TMP}/initrd.img" "${OUTPUT_DIR}/initrd.img"
      KERNEL_SOURCE="ci-release"
    fi
  fi
  rm -rf "$RELEASE_TMP"
fi

# Fallback: check local resources
if [ -z "$KERNEL_SOURCE" ]; then
  LOCAL_VM="${SCRIPT_DIR}/../../resources/vm"
  for name in vmlinuz.local-backup vmlinuz; do
    if [ -f "${LOCAL_VM}/${name}" ]; then
      cp "${LOCAL_VM}/${name}" "${OUTPUT_DIR}/vmlinuz"
      break
    fi
  done
  for name in initrd.img.local-backup initrd.img; do
    if [ -f "${LOCAL_VM}/${name}" ]; then
      cp "${LOCAL_VM}/${name}" "${OUTPUT_DIR}/initrd.img"
      break
    fi
  done
  if [ -f "${OUTPUT_DIR}/vmlinuz" ] && [ -f "${OUTPUT_DIR}/initrd.img" ]; then
    KERNEL_SOURCE="local"
  fi
fi

if [ -z "$KERNEL_SOURCE" ]; then
  echo "ERROR: Could not obtain kernel/initrd. Please provide vmlinuz + initrd.img in ${OUTPUT_DIR}/"
  exit 1
fi
echo "Kernel source: ${KERNEL_SOURCE}"

# Step 6: Shrink and save
echo ""
echo "Shrinking rootfs (qcow2 compression)..."
qemu-img convert -O qcow2 -c "${WORK_DIR}/disk.qcow2" "${OUTPUT_DIR}/rootfs-provisioned.qcow2"

echo ""
echo "=== Build complete ==="
echo "Output:"
ls -lh "${OUTPUT_DIR}/"
echo ""
echo "To test with evals:"
echo "  cp ${OUTPUT_DIR}/* apps/desktop/resources/vm/"
echo "  bun run packages/agent-runtime/src/evals/run-eval.ts --vm --mount --verbose --filter edit-file-simple-rename"
