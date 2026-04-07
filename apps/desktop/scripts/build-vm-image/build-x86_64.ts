#!/usr/bin/env bun
/**
 * Build a provisioned x86_64 VM image on Windows using QEMU.
 *
 * This is the Windows equivalent of build.sh — provisions an Ubuntu cloud
 * image with bun, node, git, gh, and the shogo agent-runtime scaffolding.
 *
 * Usage:  bun run build-x86_64.ts
 * Output: ../../resources/vm/rootfs-provisioned.qcow2
 */

import { execSync, spawn } from 'child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync, mkdtempSync } from 'fs'
import { resolve, join, dirname } from 'path'
import { tmpdir } from 'os'

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'))
const REPO_ROOT = resolve(SCRIPT_DIR, '../../../..')
const VM_DIR = resolve(SCRIPT_DIR, '../../resources/vm')
const QEMU_DIR = 'C:\\Program Files\\qemu'
const QEMU_IMG = join(QEMU_DIR, 'qemu-img.exe')
const QEMU_SYS = join(QEMU_DIR, 'qemu-system-x86_64.exe')

const provisionedPath = join(VM_DIR, 'rootfs-provisioned.qcow2')
const basePath = join(VM_DIR, 'rootfs.qcow2')

if (existsSync(provisionedPath)) {
  console.log('rootfs-provisioned.qcow2 already exists. Delete it to rebuild.')
  process.exit(0)
}

if (!existsSync(basePath)) {
  console.error('rootfs.qcow2 not found. Download it first.')
  process.exit(1)
}

console.log('=== Building provisioned x86_64 VM image ===')

const workDir = mkdtempSync(join(tmpdir(), 'shogo-build-'))
const diskPath = join(workDir, 'disk.qcow2')

// Step 1: Create working copy
console.log('Creating working disk...')
execSync(`"${QEMU_IMG}" create -f qcow2 -b "${basePath}" -F qcow2 "${diskPath}"`, { stdio: 'pipe' })
execSync(`"${QEMU_IMG}" resize "${diskPath}" 10G`, { stdio: 'pipe' })

// Step 2: Create cloud-init seed ISO
console.log('Creating cloud-init seed...')

const metaData = `instance-id: shogo-build-${Date.now()}\nlocal-hostname: shogo-vm\n`

const userData = `#cloud-config
password: shogo
chpasswd:
  expire: false
ssh_pwauth: true

bootcmd:
  - date -s "${new Date().toISOString()}"
  - timedatectl set-ntp false 2>/dev/null || true

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
  - growpart /dev/vda 1 2>/dev/null || true
  - resize2fs /dev/vda1 2>/dev/null || true
  - useradd -m -s /bin/bash shogo || true
  - echo "shogo ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
  - mkdir -p /workspace /opt/shogo /app/templates/skill-server /packages/sdk/bin
  - chown shogo:shogo /workspace
  - |
    export HOME=/root
    curl -fsSL https://bun.sh/install | bash
    BUN_VER=$(/root/.bun/bin/bun --version)
    echo "Downloading bun-linux-x64-baseline v${BUN_VER}..."
    cd /tmp
    curl -fsSL -o bun-baseline.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VER}/bun-linux-x64-baseline.zip"
    unzip -o bun-baseline.zip -d bun-extract
    cp bun-extract/bun-linux-x64-baseline/bun /usr/local/bin/bun
    chmod 755 /usr/local/bin/bun
    ln -sf /usr/local/bin/bun /usr/local/bin/node
    ln -sf /usr/local/bin/bun /usr/local/bin/npx
    ln -sf /usr/local/bin/bun /usr/local/bin/npm
    rm -rf bun-baseline.zip bun-extract
    echo "Installed bun baseline: $(bun --version)"
  - |
    export HOME=/root
    export PATH=/usr/local/bin:$PATH
    printf '{"name":"skill-server","private":true,"dependencies":{"hono":"^4.7.0","prisma":"7.4.1","@prisma/client":"7.4.1","prisma-adapter-bun-sqlite":"^0.6.8"}}' > /app/templates/skill-server/package.json
    cd /app/templates/skill-server && bun install
  - |
    export HOME=/root
    export PATH=/usr/local/bin:$PATH
    bun add -g typescript-language-server typescript pyright 2>/dev/null || true
  - apt-get clean
  - rm -rf /var/lib/apt/lists/*
  - touch /var/lib/cloud/instance/shogo-provisioned
  - poweroff
`

// Use our programmatic ISO generator
const generateSeedISO = require('../../src/vm/cloud-init').generateSeedISO
const seedPath = join(workDir, 'seed.iso')

// Write the files manually since generateSeedISO expects a config object
const seedTmpDir = mkdtempSync(join(tmpdir(), 'shogo-seed-'))
writeFileSync(join(seedTmpDir, 'meta-data'), metaData)
writeFileSync(join(seedTmpDir, 'user-data'), userData)

// Use our programmatic ISO writer directly
const { writeIso9660 } = (() => {
  // Inline minimal ISO writer since the export isn't public
  const SECTOR = 2048

  function writeLE32(buf: Buffer, off: number, val: number) { buf.writeUInt32LE(val, off) }
  function writeBE32(buf: Buffer, off: number, val: number) { buf.writeUInt32BE(val, off) }
  function writeBothEndian16(buf: Buffer, off: number, val: number) { buf.writeUInt16LE(val, off); buf.writeUInt16BE(val, off + 2) }
  function writeBothEndian32(buf: Buffer, off: number, val: number) { buf.writeUInt32LE(val, off); buf.writeUInt32BE(val, off + 4) }
  function writeLE16(buf: Buffer, off: number, val: number) { buf.writeUInt16LE(val, off) }
  function writeStrA(buf: Buffer, off: number, len: number, str: string) { buf.write(str.padEnd(len, ' ').slice(0, len), off, 'ascii') }
  function writeStrD(buf: Buffer, off: number, len: number, str: string) { buf.write(str.toUpperCase().padEnd(len, ' ').slice(0, len), off, 'ascii') }
  function writeDirectoryDate(buf: Buffer, off: number) {
    const d = new Date()
    buf[off] = d.getUTCFullYear() - 1900; buf[off+1] = d.getUTCMonth()+1; buf[off+2] = d.getUTCDate()
    buf[off+3] = d.getUTCHours(); buf[off+4] = d.getUTCMinutes(); buf[off+5] = d.getUTCSeconds(); buf[off+6] = 0
  }
  function writeDecDate(buf: Buffer, off: number) {
    const d = new Date()
    const s = d.getUTCFullYear().toString().padStart(4,'0')+(d.getUTCMonth()+1).toString().padStart(2,'0')+d.getUTCDate().toString().padStart(2,'0')+d.getUTCHours().toString().padStart(2,'0')+d.getUTCMinutes().toString().padStart(2,'0')+d.getUTCSeconds().toString().padStart(2,'0')+'00'
    buf.write(s, off, 'ascii'); buf[off+16] = 0
  }
  function writeDirectoryRecord(buf: Buffer, off: number, sector: number, dataLen: number, isDir: boolean, id: string) {
    const idLen = id.length; const recLen = 33 + idLen + (idLen % 2 === 0 ? 1 : 0)
    buf[off] = recLen; buf[off+1] = 0; writeBothEndian32(buf, off+2, sector); writeBothEndian32(buf, off+10, dataLen)
    writeDirectoryDate(buf, off+18); buf[off+25] = isDir ? 0x02 : 0x00; writeBothEndian16(buf, off+28, 1)
    buf[off+32] = idLen; buf.write(id, off+33, idLen, 'ascii'); return off + recLen
  }

  return {
    writeIso9660(outputPath: string, files: Array<{name: string, content: Buffer}>) {
      let dataSector = 20
      const entries = files.map(f => { const s = Math.ceil(f.content.length/SECTOR)||1; const e = {...f, sector: dataSector, sectors: s}; dataSector += s; return e })
      const totalSectors = dataSector; const buf = Buffer.alloc(totalSectors * SECTOR)
      const pvd = buf.subarray(16*SECTOR, 17*SECTOR)
      pvd[0] = 1; pvd.write('CD001', 1, 'ascii'); pvd[6] = 1
      writeStrA(pvd, 8, 32, ''); writeStrD(pvd, 40, 32, 'CIDATA')
      writeBothEndian32(pvd, 80, totalSectors); writeBothEndian16(pvd, 120, 1); writeBothEndian16(pvd, 124, 1)
      writeBothEndian16(pvd, 128, SECTOR); writeBothEndian32(pvd, 132, 10)
      writeLE32(pvd, 140, 18); writeLE32(pvd, 144, 0); writeBE32(pvd, 148, 18); writeBE32(pvd, 152, 0)
      const rr = pvd.subarray(156, 190)
      rr[0] = 34; rr[1] = 0; writeBothEndian32(rr, 2, 19); writeBothEndian32(rr, 10, SECTOR)
      writeDirectoryDate(rr, 18); rr[25] = 0x02; writeBothEndian16(rr, 28, 1); rr[32] = 1; rr[33] = 0
      writeStrA(pvd, 190, 128, ''); writeStrA(pvd, 318, 128, ''); writeStrA(pvd, 446, 128, '')
      writeStrA(pvd, 574, 128, 'SHOGO'); writeDecDate(pvd, 813); writeDecDate(pvd, 830)
      pvd.fill(0x30, 847, 864); pvd[863] = 0; writeDecDate(pvd, 864); pvd[881] = 1
      const term = buf.subarray(17*SECTOR, 18*SECTOR)
      term[0] = 255; term.write('CD001', 1, 'ascii'); term[6] = 1
      const pt = buf.subarray(18*SECTOR, 19*SECTOR)
      pt[0] = 1; pt[1] = 0; writeLE32(pt, 2, 19); writeLE16(pt, 6, 1); pt[8] = 0
      const rootDir = buf.subarray(19*SECTOR, 20*SECTOR)
      let o = 0
      o = writeDirectoryRecord(rootDir, o, 19, SECTOR, true, '\x00')
      o = writeDirectoryRecord(rootDir, o, 19, SECTOR, true, '\x01')
      for (const e of entries) o = writeDirectoryRecord(rootDir, o, e.sector, e.content.length, false, e.name)
      for (const e of entries) e.content.copy(buf, e.sector * SECTOR)
      require('fs').writeFileSync(outputPath, buf)
    }
  }
})()

writeIso9660(seedPath, [
  { name: 'META-DATA.;1', content: Buffer.from(metaData) },
  { name: 'USER-DATA.;1', content: Buffer.from(userData) },
])

console.log(`Seed ISO: ${seedPath}`)

// Step 3: Boot and provision
console.log('Booting VM for provisioning (this takes several minutes with WHPX)...')

const vmlinuz = join(VM_DIR, 'vmlinuz')
const initrd = join(VM_DIR, 'initrd.img')
const args = [
  '-accel', 'whpx', '-accel', 'tcg',
  '-machine', 'q35', '-cpu', 'Broadwell-v4',
  '-m', '4096', '-smp', '4',
  '-rtc', 'base=utc,clock=host',
  '-kernel', vmlinuz,
  '-initrd', initrd,
  '-append', 'root=LABEL=cloudimg-rootfs console=ttyS0 ds=nocloud',
  '-drive', `file=${diskPath},if=virtio,format=qcow2,cache=writeback`,
  '-cdrom', seedPath,
  '-netdev', 'user,id=net0',
  '-device', 'virtio-net-pci,netdev=net0',
  '-nographic',
  '-no-reboot',
]

const proc = spawn(QEMU_SYS, args, { stdio: ['ignore', 'pipe', 'pipe'] })

proc.stdout?.on('data', (d: Buffer) => {
  process.stdout.write(d)
})
proc.stderr?.on('data', (d: Buffer) => {
  const t = d.toString().trim()
  if (t && !/injection failed/.test(t)) console.error(`  [QEMU] ${t}`)
})

await new Promise<void>((resolve) => {
  const timeout = setTimeout(() => {
    console.error('Provisioning timed out (15min). Killing QEMU...')
    proc.kill()
    resolve()
  }, 900_000)

  proc.on('exit', (code) => {
    clearTimeout(timeout)
    console.log(`QEMU exited with code ${code}`)
    resolve()
  })
})

// Step 4: Flatten into standalone provisioned image
console.log('Flattening provisioned image...')
execSync(`"${QEMU_IMG}" convert -O qcow2 -c "${diskPath}" "${provisionedPath}"`, {
  stdio: 'inherit',
  timeout: 300_000,
})

// Cleanup
rmSync(workDir, { recursive: true, force: true })
rmSync(seedTmpDir, { recursive: true, force: true })

console.log('')
console.log('=== Build complete ===')
console.log(`  ${provisionedPath}`)
