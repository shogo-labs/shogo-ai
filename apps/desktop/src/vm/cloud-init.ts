// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

interface CloudInitConfig {
  /** Port the agent-runtime should listen on inside the VM */
  guestAgentPort: number
  /** 9p workspace mount tag (Windows only — macOS uses VirtioFS configured by Go helper) */
  workspaceMountTag?: string
  /** 9p credential mounts (Windows only) */
  credentialMounts?: Array<{ tag: string; guestPath: string }>
  /** Whether the VM uses a VirtioFS bundle mount at /mnt/bundle with bun + agent-runtime */
  useBundleMount?: boolean
  /** Extra environment variables to pass to the agent-runtime */
  env?: Record<string, string>
}

/**
 * Generate a cloud-init NoCloud seed ISO for a VM instance.
 *
 * The ISO contains:
 *   - meta-data: instance ID (unique per workspace)
 *   - user-data: cloud-config with user setup, mounts, agent-runtime start
 *
 * The VM boots agent-runtime in pool mode (PROJECT_ID=__POOL__) — the same
 * process and contract used by K8s pods. Assignment happens via POST /pool/assign.
 */
export function generateSeedISO(outputPath: string, config: CloudInitConfig): void {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'shogo-seed-'))

  try {
    const instanceId = crypto.randomUUID()

    const metaData = [
      `instance-id: ${instanceId}`,
      'local-hostname: shogo-vm',
    ].join('\n')

    const userData = buildUserData(config)

    fs.writeFileSync(path.join(tmpDir, 'meta-data'), metaData)
    fs.writeFileSync(path.join(tmpDir, 'user-data'), userData)

    const parentDir = path.dirname(outputPath)
    fs.mkdirSync(parentDir, { recursive: true })

    if (process.platform === 'darwin') {
      execSync(
        `hdiutil makehybrid -o "${outputPath}" "${tmpDir}" -iso -joliet -default-volume-name cidata`,
        { stdio: 'pipe', timeout: 10000 }
      )
    } else if (process.platform === 'win32') {
      try {
        execSync(
          `oscdimg -n -d "${tmpDir}" "${outputPath}"`,
          { stdio: 'pipe', timeout: 10000 }
        )
      } catch {
        const fallbackDir = outputPath.replace(/\.iso$/, '')
        fs.mkdirSync(fallbackDir, { recursive: true })
        fs.copyFileSync(path.join(tmpDir, 'meta-data'), path.join(fallbackDir, 'meta-data'))
        fs.copyFileSync(path.join(tmpDir, 'user-data'), path.join(fallbackDir, 'user-data'))
        console.warn('[CloudInit] oscdimg not found, using directory fallback for seed')
        return
      }
    } else {
      execSync(
        `genisoimage -output "${outputPath}" -volid cidata -joliet -rock "${tmpDir}"`,
        { stdio: 'pipe', timeout: 10000 }
      )
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

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

  // Vsock-to-TCP bridge script — binds multiple vsock ports, each forwarding
  // to a different local TCP port (agent-runtime on 8080, skill-server on 4100)
  if (config.useBundleMount) {
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
    lines.push('      # Port mappings: vsock_port -> local tcp_port')
    lines.push(`      mappings = [(1, ${config.guestAgentPort}), (2, 4100)]`)
    lines.push('      for vp, tp in mappings:')
    lines.push('          threading.Thread(target=serve, args=(vp, tp), daemon=True).start()')
    lines.push('      import time')
    lines.push('      while True: time.sleep(3600)')
    lines.push('')
  }

  // Windows: 9p mounts configured via cloud-init
  if (config.workspaceMountTag || config.credentialMounts?.length) {
    lines.push('mounts:')

    if (config.workspaceMountTag) {
      lines.push(`  - [${config.workspaceMountTag}, /workspace, 9p, "trans=virtio,msize=524288,version=9p2000.L", "0", "0"]`)
    }

    if (config.credentialMounts) {
      for (const mount of config.credentialMounts) {
        lines.push(`  - [${mount.tag}, ${mount.guestPath}, 9p, "trans=virtio,version=9p2000.L,ro", "0", "0"]`)
      }
    }
    lines.push('')
  }

  lines.push('runcmd:')

  if (config.useBundleMount) {
    // Bundle-mount provisioning: bun, agent-runtime, shogo CLI, templates etc. from VirtioFS
    lines.push('  - mkdir -p /workspace /mnt/bundle')
    lines.push('  - mount -t virtiofs workspace /workspace 2>/dev/null || true')
    lines.push('  - mount -t virtiofs bundle /mnt/bundle 2>/dev/null || true')
    lines.push('  - chown shogo:shogo /workspace')
    // Sync clock so TLS works
    lines.push(`  - date -s "${new Date().toISOString()}"`)
    // Extend root filesystem to use full disk (overlay is extended to 10GB)
    lines.push('  - growpart /dev/vda 1 2>/dev/null || true')
    lines.push('  - resize2fs /dev/vda1 2>/dev/null || true')
    // Mirror Docker layout: /app/templates, /packages/sdk/bin
    // runtime-template: symlink to VirtioFS (pure JS, no native binaries)
    // skill-server: copy locally so we can install Linux-native Prisma binaries
    lines.push('  - mkdir -p /app/templates /packages/sdk/bin')
    lines.push('  - ln -sf /mnt/bundle/templates/runtime-template /app/templates/runtime-template')
    lines.push('  - |')
    lines.push('    if [ ! -d /app/templates/skill-server/node_modules ]; then')
    lines.push('      mkdir -p /app/templates/skill-server')
    lines.push('      cp /mnt/bundle/templates/skill-server/package.json /app/templates/skill-server/ 2>/dev/null || true')
    lines.push('    fi')
    lines.push('  - ln -sf /mnt/bundle/shogo.js /packages/sdk/bin/shogo.ts')
    // Make bun available globally
    lines.push('  - ln -sf /mnt/bundle/bun /usr/local/bin/bun')
    lines.push('  - ln -sf /mnt/bundle/node /usr/local/bin/node')
    lines.push('  - ln -sf /mnt/bundle/npx /usr/local/bin/npx')
    lines.push('  - ln -sf /mnt/bundle/npm /usr/local/bin/npm')
    // Install skill-server deps only if not already prebaked into the base image
    lines.push('  - |')
    lines.push('    if [ ! -d /app/templates/skill-server/node_modules ]; then')
    lines.push('      export PATH=/mnt/bundle:$PATH')
    lines.push('      cd /app/templates/skill-server && /mnt/bundle/bun install 2>/dev/null || true')
    lines.push('    fi')
    // Install typescript-language-server only if not already prebaked
    lines.push('  - |')
    lines.push('    if ! which typescript-language-server >/dev/null 2>&1; then')
    lines.push('      export PATH=/mnt/bundle:$PATH')
    lines.push('      cd /workspace')
    lines.push('      /mnt/bundle/bun add typescript-language-server typescript 2>/workspace/.lsp-install.log || true')
    lines.push('    fi')

    // Build env block
    const projectId = config.env?.PROJECT_ID || '__POOL__'
    const envLines: string[] = [
      `    export PROJECT_ID=${shellEscape(projectId)}`,
      `    export PORT=${config.guestAgentPort}`,
      `    export WORKSPACE_DIR=/workspace`,
      `    export AGENT_DIR=/workspace`,
      `    export PROJECT_DIR=/workspace`,
      `    export NODE_ENV=development`,
      `    export TREE_SITTER_WASM_DIR=/mnt/bundle/wasm`,
      `    export PATH=/mnt/bundle:/workspace/node_modules/.bin:$PATH`,
    ]
    const skipKeys = new Set(['PROJECT_ID', 'PORT', 'WORKSPACE_DIR', 'AGENT_DIR', 'PROJECT_DIR', 'NODE_ENV', 'TREE_SITTER_WASM_DIR', 'PATH'])
    if (config.env) {
      for (const [key, value] of Object.entries(config.env)) {
        if (!skipKeys.has(key)) envLines.push(`    export ${key}=${shellEscape(value)}`)
      }
    }

    lines.push('  - |')
    lines.push(...envLines)
    lines.push(`    nohup /mnt/bundle/bun run /mnt/bundle/server.js > /workspace/.agent-runtime.log 2>&1 &`)
    lines.push('    sleep 1')
    lines.push('    nohup python3 /opt/vsock-bridge.py > /workspace/.vsock-bridge.log 2>&1 &')
  } else {
    // Pre-provisioned image mode (baked VM image with everything installed)
    lines.push('  - mkdir -p /workspace')
    lines.push('  - chown shogo:shogo /workspace')
    lines.push(`  - su - shogo -c "PROJECT_ID=__POOL__ PORT=${config.guestAgentPort} bun run /opt/shogo/agent-runtime.js &"`)
  }

  return lines.join('\n') + '\n'
}

function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9_/=:.\-]+$/.test(s)) return s
  return `'${s.replace(/'/g, "'\\''")}'`
}
