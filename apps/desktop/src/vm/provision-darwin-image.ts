#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Provision a macOS-aarch64 base VM image with bun, templates, and deps
 * pre-installed. Produces rootfs-provisioned.qcow2 in the VM resources dir.
 *
 * Usage: bun run apps/desktop/src/vm/provision-darwin-image.ts
 */

import { execSync, spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'

const REPO_ROOT = path.resolve(__dirname, '../../../../')
const VM_DIR = path.join(REPO_ROOT, 'apps/desktop/resources/vm')
const BASE_IMAGE = path.join(VM_DIR, 'rootfs.qcow2')
const PROVISIONED_IMAGE = path.join(VM_DIR, 'rootfs-provisioned.qcow2')
const OVERLAY = path.join(os.tmpdir(), 'shogo-provision-overlay.qcow2')

function findQemuBinary(): string {
  const brewArm = '/opt/homebrew/bin/qemu-system-aarch64'
  if (fs.existsSync(brewArm)) return brewArm
  const brewIntel = '/usr/local/bin/qemu-system-aarch64'
  if (fs.existsSync(brewIntel)) return brewIntel
  return 'qemu-system-aarch64'
}

function findQemuImg(): string {
  const brewArm = '/opt/homebrew/bin/qemu-img'
  if (fs.existsSync(brewArm)) return brewArm
  const brewIntel = '/usr/local/bin/qemu-img'
  if (fs.existsSync(brewIntel)) return brewIntel
  return 'qemu-img'
}

function buildProvisionCloudInit(): { metaData: string; userData: string } {
  const metaData = [
    'instance-id: provision-001',
    'local-hostname: shogo-provision',
  ].join('\n') + '\n'

  const userData = [
    '#cloud-config',
    '',
    'users:',
    '  - name: shogo',
    '    shell: /bin/bash',
    '    sudo: ALL=(ALL) NOPASSWD:ALL',
    '    groups: [sudo]',
    '',
    'ssh_genkeytypes: []',
    '',
    'bootcmd:',
    '  - systemctl mask multipathd multipathd.socket 2>/dev/null || true',
    '  - systemctl stop multipathd 2>/dev/null || true',
    '  - systemctl mask boot-efi.mount 2>/dev/null || true',
    '',
    'runcmd:',
    '  - |',
    '    ROOT_DEV=$(findmnt -n -o SOURCE /)',
    '    ROOT_DISK=$(lsblk -no PKNAME "$ROOT_DEV" 2>/dev/null | head -1)',
    '    ROOT_PART=$(echo "$ROOT_DEV" | grep -oP "\\d+$")',
    '    if [ -n "$ROOT_DISK" ] && [ -n "$ROOT_PART" ]; then',
    '      growpart "/dev/$ROOT_DISK" "$ROOT_PART" 2>/dev/null || true',
    '      resize2fs "$ROOT_DEV" 2>/dev/null || true',
    '    fi',
    '  - mkdir -p /workspace /opt/shogo /opt/shogo/wasm /packages/sdk/bin',
    '  - mkdir -p /app/templates/runtime-template /app/templates/skill-server',
    '  - chown shogo:shogo /workspace',
    '  - apt-get update -qq && apt-get install -y -qq unzip ripgrep >/dev/null 2>&1',
    '  - |',
    '    ARCH=$(uname -m)',
    '    if [ "$ARCH" = "aarch64" ]; then',
    '      BUN_PKG="bun-linux-aarch64"',
    '    else',
    '      BUN_PKG="bun-linux-x64-baseline"',
    '    fi',
    '    BUN_VER="1.3.11"',
    '    echo "Installing ${BUN_PKG} v${BUN_VER}..."',
    '    cd /tmp',
    '    curl -fsSL -o bun-dl.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VER}/${BUN_PKG}.zip"',
    '    unzip -o bun-dl.zip -d bun-extract',
    '    cp bun-extract/${BUN_PKG}/bun /usr/local/bin/bun',
    '    chmod 755 /usr/local/bin/bun',
    '    for alias in node npx npm; do',
    '      rm -f /usr/local/bin/$alias; ln -s /usr/local/bin/bun /usr/local/bin/$alias',
    '    done',
    '    rm -rf bun-dl.zip bun-extract',
    '    echo "bun ready: $(/usr/local/bin/bun --version)"',
    '  - |',
    '    cd /app/templates/skill-server',
    '    echo \'{"name":"skill-server","private":true,"dependencies":{"hono":"^4.7.0","prisma":"7.4.1","@prisma/client":"7.4.1","prisma-adapter-bun-sqlite":"^0.6.8"}}\' > package.json',
    '    /usr/local/bin/bun install',
    '    echo "skill-server deps installed"',
    '  - |',
    '    mkdir -p /mnt/seed',
    '    mount /dev/vdb /mnt/seed 2>/dev/null || mount -t iso9660 /dev/sr0 /mnt/seed 2>/dev/null || true',
    '    if [ -f /mnt/seed/runtime-template.tar.gz ]; then',
    '      tar -xzf /mnt/seed/runtime-template.tar.gz -C /app/templates/',
    '      echo "runtime-template extracted from seed ISO"',
    '    else',
    '      echo "WARNING: runtime-template.tar.gz not found in seed ISO"',
    '    fi',
    '    umount /mnt/seed 2>/dev/null || true',
    '  - |',
    '    cd /app/templates/runtime-template',
    '    /usr/local/bin/bun install',
    '    echo "runtime-template deps installed"',
    '  - |',
    '    mkdir -p /opt/shogo/templates',
    '    ln -sf /app/templates/runtime-template /opt/shogo/templates/runtime-template',
    '    echo "runtime-template symlinked to /opt/shogo/templates/"',
    '  - cloud-init clean --logs',
    '  - sync',
    '  - echo "=== PROVISION COMPLETE ==="',
    '  - poweroff',
  ].join('\n') + '\n'

  return { metaData, userData }
}

function createSeedISO(
  isoPath: string,
  metaData: string,
  userData: string,
  extraFiles?: Array<{ name: string; content: Buffer }>,
) {
  const tmpDir = path.join(os.tmpdir(), 'shogo-provision-seed')
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'meta-data'), metaData)
  fs.writeFileSync(path.join(tmpDir, 'user-data'), userData)
  if (extraFiles) {
    for (const f of extraFiles) fs.writeFileSync(path.join(tmpDir, f.name), f.content)
  }

  if (process.platform === 'darwin') {
    execSync(
      `hdiutil makehybrid -o "${isoPath}" "${tmpDir}" -iso -joliet -default-volume-name cidata`,
      { stdio: 'pipe', timeout: 30_000 },
    )
  } else {
    execSync(
      `genisoimage -output "${isoPath}" -volid cidata -joliet -rock "${tmpDir}"`,
      { stdio: 'pipe', timeout: 30_000 },
    )
  }

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

async function main() {
  if (!fs.existsSync(BASE_IMAGE)) {
    console.error(`Base image not found: ${BASE_IMAGE}`)
    process.exit(1)
  }

  const qemuBin = findQemuBinary()
  const qemuImg = findQemuImg()
  console.log(`Using QEMU: ${qemuBin}`)
  console.log(`Using qemu-img: ${qemuImg}`)

  // Clean up stale files
  for (const f of [OVERLAY, PROVISIONED_IMAGE]) {
    if (fs.existsSync(f)) fs.rmSync(f, { force: true })
  }

  console.log('Creating overlay from base image...')
  execSync(`"${qemuImg}" create -f qcow2 -b "${BASE_IMAGE}" -F qcow2 "${OVERLAY}"`, { stdio: 'pipe' })
  execSync(`"${qemuImg}" resize "${OVERLAY}" 10G`, { stdio: 'pipe' })

  const { metaData, userData } = buildProvisionCloudInit()
  const seedISOPath = path.join(os.tmpdir(), 'shogo-provision-seed.iso')
  if (fs.existsSync(seedISOPath)) fs.rmSync(seedISOPath, { force: true })

  console.log('Creating runtime-template tarball from repo...')
  const templateTar = execSync(
    `tar -czf - --exclude=node_modules --exclude=.DS_Store --exclude=bun.lock --exclude=.git -C "${path.join(REPO_ROOT, 'templates')}" runtime-template`,
    { maxBuffer: 10 * 1024 * 1024 },
  )
  console.log(`  runtime-template.tar.gz: ${(templateTar.length / 1024).toFixed(1)} KB`)

  console.log('Creating seed ISO...')
  createSeedISO(seedISOPath, metaData, userData, [
    { name: 'runtime-template.tar.gz', content: templateTar },
  ])

  console.log('Booting VM for provisioning...')
  const proc = spawn(qemuBin, [
    '-accel', 'hvf',
    '-machine', 'virt',
    '-cpu', 'host',
    '-m', '4096',
    '-smp', '4',
    '-kernel', path.join(VM_DIR, 'vmlinuz'),
    '-initrd', path.join(VM_DIR, 'initrd.img'),
    '-append', 'root=LABEL=cloudimg-rootfs rw console=ttyAMA0 ds=nocloud quiet systemd.mask=boot-efi.mount',
    '-drive', `file=${OVERLAY},if=virtio,format=qcow2,cache=writeback`,
    '-drive', `file=${seedISOPath},if=virtio,format=raw,readonly=on`,
    '-netdev', 'user,id=net0',
    '-device', 'virtio-net-pci,netdev=net0',
    '-nographic',
    '-no-reboot',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  let lastLine = ''
  proc.stdout?.on('data', (data: Buffer) => {
    const text = data.toString()
    process.stdout.write(text)
    lastLine = text.split('\n').filter(Boolean).pop() || lastLine
  })
  proc.stderr?.on('data', (data: Buffer) => {
    process.stderr.write(data.toString())
  })

  const exitCode = await new Promise<number | null>(resolve => {
    proc.on('exit', resolve)
  })

  console.log(`\nQEMU exited with code ${exitCode}`)

  // Clean up seed ISO
  if (fs.existsSync(seedISOPath)) fs.rmSync(seedISOPath, { force: true })

  if (exitCode !== 0 && exitCode !== null) {
    console.error('Provisioning failed')
    if (fs.existsSync(OVERLAY)) fs.rmSync(OVERLAY, { force: true })
    process.exit(1)
  }

  console.log('Converting overlay to standalone provisioned image...')
  execSync(
    `"${qemuImg}" convert -O qcow2 "${OVERLAY}" "${PROVISIONED_IMAGE}"`,
    { stdio: 'inherit', timeout: 300_000 },
  )

  // Clean up overlay
  fs.rmSync(OVERLAY, { force: true })

  const stat = fs.statSync(PROVISIONED_IMAGE)
  console.log(`\nProvisioned image created: ${PROVISIONED_IMAGE}`)
  console.log(`Size: ${(stat.size / 1024 / 1024).toFixed(1)} MB`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
