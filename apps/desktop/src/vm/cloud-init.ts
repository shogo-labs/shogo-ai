// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

export interface CloudInitConfig {
  guestAgentPort: number
  /** VirtioFS bundle mount (macOS) */
  useBundleMount?: boolean
  /** 9p workspace mount tag (macOS/Linux QEMU with 9p support) */
  workspaceMountTag?: string
  /** 9p credential mounts */
  credentialMounts?: Array<{ tag: string; guestPath: string }>
  env?: Record<string, string>
  qemuDir?: string
  /**
   * Extra files to embed in the seed ISO alongside meta-data and user-data.
   * Cloud-init runcmd can mount the seed ISO to access them.
   */
  extraFiles?: Array<{ name: string; content: Buffer }>
}

/**
 * Generate a cloud-init NoCloud seed ISO.
 *
 * On Windows with a pre-provisioned image, the ISO also carries the
 * agent-runtime bundle (server.js, shogo.js) so no file sharing is needed.
 */
export function generateSeedISO(outputPath: string, config: CloudInitConfig): void {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'shogo-seed-'))

  try {
    const instanceId = crypto.randomUUID()
    const metaData = `instance-id: ${instanceId}\nlocal-hostname: shogo-vm\n`
    const userData = buildUserData(config)

    fs.writeFileSync(path.join(tmpDir, 'meta-data'), metaData)
    fs.writeFileSync(path.join(tmpDir, 'user-data'), userData)

    const parentDir = path.dirname(outputPath)
    fs.mkdirSync(parentDir, { recursive: true })

    if (process.platform === 'darwin') {
      // Write extra files into tmpDir so hdiutil picks them up
      if (config.extraFiles) {
        for (const f of config.extraFiles) fs.writeFileSync(path.join(tmpDir, f.name), f.content)
      }
      execSync(
        `hdiutil makehybrid -o "${outputPath}" "${tmpDir}" -iso -joliet -default-volume-name cidata`,
        { stdio: 'pipe', timeout: 30000 }
      )
    } else if (process.platform === 'win32') {
      // Always use the programmatic ISO builder on Windows (no external tools needed)
      const isoFiles: Array<{ name: string; content: Buffer }> = [
        { name: 'META-DATA.;1', content: Buffer.from(metaData, 'utf-8') },
        { name: 'USER-DATA.;1', content: Buffer.from(userData, 'utf-8') },
      ]
      if (config.extraFiles) {
        for (const f of config.extraFiles) {
          isoFiles.push({ name: toIso9660Name(f.name), content: f.content })
        }
      }
      writeIso9660(outputPath, 'CIDATA', isoFiles)
    } else {
      if (config.extraFiles) {
        for (const f of config.extraFiles) fs.writeFileSync(path.join(tmpDir, f.name), f.content)
      }
      execSync(
        `genisoimage -output "${outputPath}" -volid cidata -joliet -rock "${tmpDir}"`,
        { stdio: 'pipe', timeout: 30000 }
      )
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

function toIso9660Name(name: string): string {
  const upper = name.toUpperCase().replace(/[^A-Z0-9_.\-]/g, '_')
  if (!upper.includes('.')) return upper + '.;1'
  return upper + ';1'
}

// ---------------------------------------------------------------------------
// Programmatic ISO 9660 writer
// ---------------------------------------------------------------------------

export function writeIso9660(
  outputPath: string,
  volumeId: string,
  files: Array<{ name: string; content: Buffer }>,
): void {
  const SECTOR = 2048
  const rootDirSector = 19
  let dataSector = 20

  const fileEntries = files.map(f => {
    const sectors = Math.ceil(f.content.length / SECTOR) || 1
    const entry = { ...f, sector: dataSector, sectors }
    dataSector += sectors
    return entry
  })

  // Root directory might exceed one sector if many files
  const rootDirSize = estimateRootDirSize(fileEntries)
  const rootDirSectors = Math.ceil(rootDirSize / SECTOR) || 1
  if (rootDirSectors > 1) {
    // Shift data sectors to accommodate larger root directory
    const shift = rootDirSectors - 1
    for (const e of fileEntries) e.sector += shift
    dataSector += shift
  }

  const totalSectors = dataSector
  const buf = Buffer.alloc(totalSectors * SECTOR)

  // Primary Volume Descriptor (sector 16)
  const pvd = buf.subarray(16 * SECTOR, 17 * SECTOR)
  pvd[0] = 1; pvd.write('CD001', 1, 'ascii'); pvd[6] = 1
  writeStrA(pvd, 8, 32, '')
  writeStrD(pvd, 40, 32, volumeId)
  writeBothEndian32(pvd, 80, totalSectors)
  writeBothEndian16(pvd, 120, 1); writeBothEndian16(pvd, 124, 1)
  writeBothEndian16(pvd, 128, SECTOR)
  writeBothEndian32(pvd, 132, 10)
  writeLE32(pvd, 140, 18); writeLE32(pvd, 144, 0)
  writeBE32(pvd, 148, 18); writeBE32(pvd, 152, 0)

  const rr = pvd.subarray(156, 190)
  rr[0] = 34; writeBothEndian32(rr, 2, rootDirSector)
  writeBothEndian32(rr, 10, rootDirSectors * SECTOR)
  writeDirectoryDate(rr, 18); rr[25] = 0x02
  writeBothEndian16(rr, 28, 1); rr[32] = 1; rr[33] = 0

  writeStrA(pvd, 190, 128, ''); writeStrA(pvd, 318, 128, '')
  writeStrA(pvd, 446, 128, ''); writeStrA(pvd, 574, 128, 'SHOGO')
  writeDecDate(pvd, 813); writeDecDate(pvd, 830)
  pvd.fill(0x30, 847, 864); pvd[863] = 0
  writeDecDate(pvd, 864); pvd[881] = 1

  // Volume Descriptor Set Terminator (sector 17)
  const term = buf.subarray(17 * SECTOR, 18 * SECTOR)
  term[0] = 255; term.write('CD001', 1, 'ascii'); term[6] = 1

  // Path Table (sector 18)
  const pt = buf.subarray(18 * SECTOR, 19 * SECTOR)
  pt[0] = 1; writeLE32(pt, 2, rootDirSector); writeLE16(pt, 6, 1); pt[8] = 0

  // Root Directory
  const rootDir = buf.subarray(rootDirSector * SECTOR, (rootDirSector + rootDirSectors) * SECTOR)
  let off = 0
  off = writeDirectoryRecord(rootDir, off, rootDirSector, rootDirSectors * SECTOR, true, '\x00')
  off = writeDirectoryRecord(rootDir, off, rootDirSector, rootDirSectors * SECTOR, true, '\x01')
  for (const fe of fileEntries) {
    off = writeDirectoryRecord(rootDir, off, fe.sector, fe.content.length, false, fe.name)
  }

  // File data
  for (const fe of fileEntries) fe.content.copy(buf, fe.sector * SECTOR)

  fs.writeFileSync(outputPath, buf)
}

function estimateRootDirSize(entries: Array<{ name: string }>): number {
  let size = 34 + 34 // . and ..
  for (const e of entries) {
    const idLen = e.name.length
    size += 33 + idLen + (idLen % 2 === 0 ? 1 : 0)
  }
  return size
}

// --- Binary helpers ---

function writeLE16(buf: Buffer, off: number, val: number) { buf.writeUInt16LE(val, off) }
function writeLE32(buf: Buffer, off: number, val: number) { buf.writeUInt32LE(val, off) }
function writeBE32(buf: Buffer, off: number, val: number) { buf.writeUInt32BE(val, off) }
function writeBothEndian16(buf: Buffer, off: number, val: number) {
  buf.writeUInt16LE(val, off); buf.writeUInt16BE(val, off + 2)
}
function writeBothEndian32(buf: Buffer, off: number, val: number) {
  buf.writeUInt32LE(val, off); buf.writeUInt32BE(val, off + 4)
}
function writeStrA(buf: Buffer, off: number, len: number, str: string) {
  buf.write(str.padEnd(len, ' ').slice(0, len), off, 'ascii')
}
function writeStrD(buf: Buffer, off: number, len: number, str: string) {
  buf.write(str.toUpperCase().padEnd(len, ' ').slice(0, len), off, 'ascii')
}
function writeDirectoryDate(buf: Buffer, off: number) {
  const d = new Date()
  buf[off] = d.getUTCFullYear() - 1900; buf[off+1] = d.getUTCMonth()+1
  buf[off+2] = d.getUTCDate(); buf[off+3] = d.getUTCHours()
  buf[off+4] = d.getUTCMinutes(); buf[off+5] = d.getUTCSeconds(); buf[off+6] = 0
}
function writeDecDate(buf: Buffer, off: number) {
  const d = new Date()
  const s = d.getUTCFullYear().toString().padStart(4,'0') +
    (d.getUTCMonth()+1).toString().padStart(2,'0') + d.getUTCDate().toString().padStart(2,'0') +
    d.getUTCHours().toString().padStart(2,'0') + d.getUTCMinutes().toString().padStart(2,'0') +
    d.getUTCSeconds().toString().padStart(2,'0') + '00'
  buf.write(s, off, 'ascii'); buf[off+16] = 0
}
function writeDirectoryRecord(
  buf: Buffer, off: number, sector: number, dataLen: number,
  isDir: boolean, id: string,
): number {
  const idLen = id.length
  const recLen = 33 + idLen + (idLen % 2 === 0 ? 1 : 0)
  buf[off] = recLen; buf[off+1] = 0
  writeBothEndian32(buf, off+2, sector); writeBothEndian32(buf, off+10, dataLen)
  writeDirectoryDate(buf, off+18); buf[off+25] = isDir ? 0x02 : 0x00
  writeBothEndian16(buf, off+28, 1); buf[off+32] = idLen
  buf.write(id, off+33, idLen, 'ascii')
  return off + recLen
}

// ---------------------------------------------------------------------------
// User-data builder
// ---------------------------------------------------------------------------

function buildUserData(config: CloudInitConfig): string {
  const lines: string[] = [
    '#cloud-config',
    '',
    'users:',
    '  - name: shogo',
    '    shell: /bin/bash',
    '    sudo: ALL=(ALL) NOPASSWD:ALL',
    '    groups: [sudo]',
    '',
  ]

  if (config.useBundleMount) {
    // macOS VirtioFS bundle-mount path (unchanged)
    lines.push('write_files:')
    lines.push('  - path: /opt/vsock-bridge.py')
    lines.push("    permissions: '0755'")
    lines.push('    content: |')
    lines.push('      #!/usr/bin/env python3')
    lines.push('      import socket, threading, sys')
    lines.push('      def bridge(src, dst):')
    lines.push('          try:')
    lines.push('              while True:')
    lines.push('                  data = src.recv(65536)')
    lines.push('                  if not data: break')
    lines.push('                  dst.sendall(data)')
    lines.push('          except: pass')
    lines.push('          finally:')
    lines.push('              try: src.close()')
    lines.push('              except: pass')
    lines.push('              try: dst.close()')
    lines.push('              except: pass')
    lines.push('      def handle(client, target_port):')
    lines.push('          try:')
    lines.push('              tcp = socket.create_connection(("127.0.0.1", target_port))')
    lines.push('              threading.Thread(target=bridge, args=(client, tcp), daemon=True).start()')
    lines.push('              threading.Thread(target=bridge, args=(tcp, client), daemon=True).start()')
    lines.push('          except: client.close()')
    lines.push('      def serve(vsock_port, tcp_port):')
    lines.push('          vs = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)')
    lines.push('          vs.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)')
    lines.push('          vs.bind((socket.VMADDR_CID_ANY, vsock_port))')
    lines.push('          vs.listen(32)')
    lines.push('          while True:')
    lines.push('              c, _ = vs.accept()')
    lines.push('              threading.Thread(target=handle, args=(c, tcp_port), daemon=True).start()')
    lines.push(`      mappings = [(1, ${config.guestAgentPort}), (2, 4100)]`)
    lines.push('      for vp, tp in mappings:')
    lines.push('          threading.Thread(target=serve, args=(vp, tp), daemon=True).start()')
    lines.push('      import time')
    lines.push('      while True: time.sleep(3600)')
    lines.push('')
  }

  if (config.workspaceMountTag || config.credentialMounts?.length) {
    lines.push('mounts:')
    if (config.workspaceMountTag) {
      lines.push(`  - [${config.workspaceMountTag}, /workspace, 9p, "trans=virtio,msize=524288,version=9p2000.L", "0", "0"]`)
    }
    if (config.credentialMounts) {
      for (const m of config.credentialMounts) {
        lines.push(`  - [${m.tag}, ${m.guestPath}, 9p, "trans=virtio,version=9p2000.L,ro", "0", "0"]`)
      }
    }
    lines.push('')
  }

  lines.push('runcmd:')

  if (config.useBundleMount) {
    // macOS VirtioFS bundle-mount provisioning (unchanged)
    lines.push('  - mkdir -p /workspace /mnt/bundle')
    lines.push('  - mount -t virtiofs workspace /workspace 2>/dev/null || true')
    lines.push('  - mount -t virtiofs bundle /mnt/bundle 2>/dev/null || true')
    lines.push('  - chown shogo:shogo /workspace 2>/dev/null || true')
    lines.push(`  - date -s "${new Date().toISOString()}"`)
    lines.push('  - growpart /dev/vda 1 2>/dev/null || true')
    lines.push('  - resize2fs /dev/vda1 2>/dev/null || true')
    lines.push('  - mkdir -p /app/templates /packages/sdk/bin')
    lines.push('  - ln -sf /mnt/bundle/templates/runtime-template /app/templates/runtime-template')
    lines.push('  - |')
    lines.push('    if [ ! -d /app/templates/skill-server/node_modules ]; then')
    lines.push('      cp -r /mnt/bundle/templates/skill-server /app/templates/skill-server')
    lines.push('    fi')
    lines.push('  - ln -sf /mnt/bundle/shogo.js /packages/sdk/bin/shogo.ts')
    lines.push('  - ln -sf /mnt/bundle/bun /usr/local/bin/bun')
    lines.push('  - ln -sf /mnt/bundle/node /usr/local/bin/node')
    lines.push('  - ln -sf /mnt/bundle/npx /usr/local/bin/npx')
    lines.push('  - ln -sf /mnt/bundle/npm /usr/local/bin/npm')

    const projectId = config.env?.PROJECT_ID || '__POOL__'
    const envLines = [
      `    export PROJECT_ID=${shellEscape(projectId)}`,
      `    export PORT=${config.guestAgentPort}`,
      `    export WORKSPACE_DIR=/workspace`,
      `    export AGENT_DIR=/workspace`,
      `    export PROJECT_DIR=/workspace`,
      `    export NODE_ENV=development`,
      `    export TREE_SITTER_WASM_DIR=/mnt/bundle/wasm`,
      `    export PATH=/mnt/bundle:/mnt/bundle/node_modules/.bin:/workspace/node_modules/.bin:$PATH`,
    ]
    const skip = new Set(['PROJECT_ID', 'PORT', 'WORKSPACE_DIR', 'AGENT_DIR', 'PROJECT_DIR', 'NODE_ENV', 'TREE_SITTER_WASM_DIR', 'PATH'])
    if (config.env) {
      for (const [k, v] of Object.entries(config.env)) {
        if (!skip.has(k)) envLines.push(`    export ${k}=${shellEscape(v)}`)
      }
    }
    lines.push('  - |')
    lines.push(...envLines)
    lines.push(`    nohup /mnt/bundle/bun run /mnt/bundle/server.js > /workspace/.agent-runtime.log 2>&1 &`)
    lines.push('    sleep 1')
    lines.push('    nohup python3 /opt/vsock-bridge.py > /workspace/.vsock-bridge.log 2>&1 &')
  } else {
    // Pre-provisioned image (Windows QEMU, or any image with bun pre-installed)
    // The seed ISO may carry server.js + shogo.js; copy them into the image.
    lines.push('  - mkdir -p /workspace /opt/shogo')
    lines.push('  - chown shogo:shogo /workspace')
    lines.push(`  - date -s "${new Date().toISOString()}"`)
    lines.push('  - growpart /dev/vda 1 2>/dev/null || true')
    lines.push('  - resize2fs /dev/vda1 2>/dev/null || true')
    // Ensure bun is the baseline build (no AVX, works with WHPX) and is
    // a regular file accessible to all users (not a symlink into /root/).
    // Old base images have bun as a symlink to /root/.bun/bin/bun (standard
    // build, not baseline). We must download the actual baseline binary.
    lines.push('  - |')
    lines.push('    NEED_BASELINE=false')
    lines.push('    if [ -L /usr/local/bin/bun ]; then')
    lines.push('      echo "bun is a symlink — need baseline replacement"')
    lines.push('      NEED_BASELINE=true')
    lines.push('    elif ! [ -x /usr/local/bin/bun ]; then')
    lines.push('      echo "bun not found — need baseline install"')
    lines.push('      NEED_BASELINE=true')
    lines.push('    fi')
    lines.push('    if [ "$NEED_BASELINE" = "true" ]; then')
    lines.push('      BUN_VER=$(bun --version 2>/dev/null || echo "1.3.11")')
    lines.push('      echo "Downloading bun-linux-x64-baseline v${BUN_VER}..."')
    lines.push('      cd /tmp')
    lines.push('      curl -fsSL -o bun-baseline.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VER}/bun-linux-x64-baseline.zip"')
    lines.push('      if [ -f bun-baseline.zip ]; then')
    lines.push('        unzip -o bun-baseline.zip -d bun-extract 2>/dev/null')
    lines.push('        rm -f /usr/local/bin/bun')
    lines.push('        cp bun-extract/bun-linux-x64-baseline/bun /usr/local/bin/bun')
    lines.push('        rm -rf bun-baseline.zip bun-extract')
    lines.push('        echo "Installed bun baseline: $(bun --version)"')
    lines.push('      fi')
    lines.push('    fi')
    lines.push('    chmod 755 /usr/local/bin/bun')
    lines.push('    for alias in node npx npm; do')
    lines.push('      rm -f /usr/local/bin/$alias; ln -s /usr/local/bin/bun /usr/local/bin/$alias')
    lines.push('    done')
    lines.push('    echo "bun ready: $(/usr/local/bin/bun --version 2>/dev/null || echo MISSING)"')
    // Mount the seed ISO to extract bundled files (server.js, shogo.js)
    lines.push('  - |')
    lines.push('    mkdir -p /mnt/seed /packages/sdk/bin')
    lines.push('    mount -t iso9660 /dev/sr0 /mnt/seed 2>/dev/null || mount /dev/cdrom /mnt/seed 2>/dev/null || true')
    lines.push('    mkdir -p /opt/shogo/wasm')
    lines.push('    for f in /mnt/seed/*; do')
    lines.push('      case "$f" in *.wasm) cp "$f" /opt/shogo/wasm/ ;; *) cp "$f" /opt/shogo/ ;; esac 2>/dev/null || true')
    lines.push('    done')
    lines.push('    ls -la /opt/shogo/ /opt/shogo/wasm/')
    lines.push('    ln -sf /opt/shogo/shogo.js /packages/sdk/bin/shogo.ts 2>/dev/null || true')
    lines.push('    umount /mnt/seed 2>/dev/null || true')

    // Build env block and start agent-runtime
    const projectId = config.env?.PROJECT_ID || '__POOL__'
    const envParts = [
      `PROJECT_ID=${shellEscape(projectId)}`,
      `PORT=${config.guestAgentPort}`,
      'WORKSPACE_DIR=/workspace',
      'AGENT_DIR=/workspace',
      'PROJECT_DIR=/workspace',
      'NODE_ENV=development',
      'TREE_SITTER_WASM_DIR=/opt/shogo/wasm',
    ]
    const skip = new Set(['PROJECT_ID', 'PORT', 'WORKSPACE_DIR', 'AGENT_DIR', 'PROJECT_DIR', 'NODE_ENV', 'TREE_SITTER_WASM_DIR'])
    if (config.env) {
      for (const [k, v] of Object.entries(config.env)) {
        if (!skip.has(k)) envParts.push(`${k}=${shellEscape(v)}`)
      }
    }
    const envStr = envParts.join(' ')
    lines.push('  - |')
    lines.push('    echo "=== Starting agent-runtime ==="')
    lines.push('    which bun && bun --version || echo "ERROR: bun not found in PATH"')
    lines.push(`    su - shogo -c "export PATH=/usr/local/bin:\\$PATH; ${envStr} /usr/local/bin/bun run /opt/shogo/server.js 2>&1 | tee /workspace/.agent-runtime.log &"`)
    lines.push('    disown 2>/dev/null || true')
  }

  return lines.join('\n') + '\n'
}

function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9_/=:.\-]+$/.test(s)) return s
  return `'${s.replace(/'/g, "'\\''")}'`
}
