#!/usr/bin/env bun
/**
 * E2E eval test: VM boots agent-runtime in pool mode, gets assigned, runs chat.
 *
 * Flow:
 *   1. Boot VM via Go helper with VirtioFS mount sharing the monorepo
 *   2. Cloud-init starts agent-runtime from the VirtioFS mount (pool mode)
 *   3. Forward vsock port to localhost
 *   4. Wait for /health to report ready
 *   5. POST /pool/assign to assign a project
 *   6. Send a simple agent chat prompt
 *   7. Verify response
 *   8. Shut down
 */

import { spawn, execSync, type ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'

const DESKTOP_DIR = path.dirname(new URL(import.meta.url).pathname)
const REPO_ROOT = path.resolve(DESKTOP_DIR, '../..')
const VM_IMAGE_DIR = path.join(DESKTOP_DIR, 'resources', 'vm')
const GO_HELPER = path.join(DESKTOP_DIR, 'native', 'shogo-vm', 'shogo-vm-arm64')
const TEST_DIR = '/tmp/shogo-vm-eval-test'
const WORKSPACE_DIR = path.join(TEST_DIR, 'workspace')
const BUNDLE_DIR = path.join(TEST_DIR, 'bundle')

class TestJsonRpcClient {
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private lineBuffer = ''

  constructor(private proc: ChildProcess) {
    proc.stdout!.on('data', (chunk: Buffer) => {
      this.lineBuffer += chunk.toString()
      const lines = this.lineBuffer.split('\n')
      this.lineBuffer = lines.pop()!
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const resp = JSON.parse(line)
          const p = this.pending.get(resp.id)
          if (p) {
            this.pending.delete(resp.id)
            if (resp.error) p.reject(new Error(resp.error))
            else p.resolve(resp.result)
          }
        } catch {}
      }
    })
  }

  async call(method: string, params: any, timeout = 30000): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const msg = JSON.stringify({ id, method, params }) + '\n'
      this.proc.stdin!.write(msg)
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`RPC timeout: ${method}`))
        }
      }, timeout)
    })
  }

  destroy() { this.proc.stdin?.end() }
}

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 23)
  console.log(`[${ts}] ${msg}`)
}
function pass(name: string) { console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
function fail(name: string, err?: any) { console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err}`); }
async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  console.log('\n\x1b[1m=== VM Eval E2E Test ===\x1b[0m\n')

  // -----------------------------------------------------------------------
  // Pre-checks
  // -----------------------------------------------------------------------
  log('Pre-checks...')

  if (!fs.existsSync(GO_HELPER)) {
    fail('Go helper', `Not found: ${GO_HELPER}`)
    process.exit(1)
  }
  pass('Go helper binary exists')

  for (const f of ['vmlinuz', 'initrd.img', 'rootfs.raw']) {
    if (!fs.existsSync(path.join(VM_IMAGE_DIR, f))) {
      fail(`VM image ${f}`, 'Not found')
      process.exit(1)
    }
  }
  pass('VM images present')

  // -----------------------------------------------------------------------
  // Prepare test workspace
  // -----------------------------------------------------------------------
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true })
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true })
  fs.mkdirSync(BUNDLE_DIR, { recursive: true })

  // Write a minimal config.json so agent-runtime doesn't error
  fs.writeFileSync(path.join(WORKSPACE_DIR, 'config.json'), JSON.stringify({
    model: { provider: 'anthropic', name: 'claude-sonnet-4-6' },
    activeMode: 'none',
    heartbeat: { enabled: false, intervalMs: 300000 },
    channels: [],
    skills: [],
    memory: { enabled: false },
  }, null, 2))

  // Build agent-runtime bundle (self-contained, no node_modules needed)
  log('Building agent-runtime bundle...')
  execSync(
    `bun build src/server.ts --outdir "${BUNDLE_DIR}" --target bun --external electron --external playwright-core --external playwright`,
    { cwd: path.join(REPO_ROOT, 'packages/agent-runtime'), stdio: 'pipe' }
  )
  if (!fs.existsSync(path.join(BUNDLE_DIR, 'server.js'))) {
    fail('Build agent-runtime bundle', 'server.js not found')
    process.exit(1)
  }
  const bundleSize = (fs.statSync(path.join(BUNDLE_DIR, 'server.js')).size / 1024 / 1024).toFixed(1)
  pass(`Agent-runtime bundle built (${bundleSize}MB)`)

  // Download Linux aarch64 bun binary if not already present
  const bunLinuxPath = path.join(BUNDLE_DIR, 'bun')
  if (!fs.existsSync(bunLinuxPath)) {
    log('Downloading Linux aarch64 bun binary...')
    execSync(
      `curl -fsSL -o /tmp/bun-linux.zip "https://github.com/oven-sh/bun/releases/download/bun-v1.3.5/bun-linux-aarch64.zip" && ` +
      `unzip -o /tmp/bun-linux.zip -d /tmp/bun-linux-extract && ` +
      `cp /tmp/bun-linux-extract/bun-linux-aarch64/bun "${bunLinuxPath}" && ` +
      `chmod +x "${bunLinuxPath}"`,
      { stdio: 'pipe' }
    )
    pass('Linux bun binary downloaded')
  } else {
    pass('Linux bun binary already present')
  }

  // Create node/npx/npm symlinks to bun so skill-server codegen and npx work
  for (const alias of ['node', 'npx', 'npm']) {
    const link = path.join(BUNDLE_DIR, alias)
    if (!fs.existsSync(link)) fs.symlinkSync('bun', link)
  }
  pass('Created node/npx/npm -> bun symlinks for VM PATH')

  // Copy tree-sitter wasm files for code analysis inside the VM
  const wasmDir = path.join(BUNDLE_DIR, 'wasm')
  if (!fs.existsSync(wasmDir)) {
    fs.mkdirSync(wasmDir, { recursive: true })
    const tsWasmSrc = path.join(REPO_ROOT, 'node_modules/.bun/web-tree-sitter@0.25.10/node_modules/web-tree-sitter/tree-sitter.wasm')
    if (fs.existsSync(tsWasmSrc)) {
      execSync(`cp "${tsWasmSrc}" "${wasmDir}/"`, { stdio: 'pipe' })
    }
    const langWasmDir = (() => {
      try { return execSync(`ls -d ${REPO_ROOT}/node_modules/.bun/tree-sitter-wasms@*/node_modules/tree-sitter-wasms/out 2>/dev/null`, { encoding: 'utf-8' }).trim() } catch { return '' }
    })()
    if (langWasmDir && fs.existsSync(langWasmDir)) {
      execSync(`cp "${langWasmDir}"/*.wasm "${wasmDir}/"`, { stdio: 'pipe' })
    }
    pass(`Tree-sitter wasm files copied (${fs.readdirSync(wasmDir).length} files)`)
  } else {
    pass('Tree-sitter wasm files already present')
  }

  // -----------------------------------------------------------------------
  // Create overlay disk
  // -----------------------------------------------------------------------
  const overlayPath = path.join(TEST_DIR, 'overlay.raw')
  log('Creating overlay disk (copying rootfs.raw)...')
  execSync(`cp "${path.join(VM_IMAGE_DIR, 'rootfs.raw')}" "${overlayPath}"`)
  pass('Overlay disk ready')

  // -----------------------------------------------------------------------
  // Load API keys from .env.local
  // -----------------------------------------------------------------------
  const envLocalPath = path.join(REPO_ROOT, '.env.local')
  const envLocal = fs.existsSync(envLocalPath) ? fs.readFileSync(envLocalPath, 'utf-8') : ''
  function getEnvValue(content: string, key: string): string {
    const match = content.match(new RegExp(`^${key}=(.+)$`, 'm'))
    return match ? match[1].trim() : ''
  }
  const ANTHROPIC_KEY = getEnvValue(envLocal, 'ANTHROPIC_API_KEY')
  if (!ANTHROPIC_KEY) {
    fail('ANTHROPIC_API_KEY', 'not found in .env.local')
    process.exit(1)
  }
  pass(`ANTHROPIC_API_KEY loaded from .env.local`)

  // -----------------------------------------------------------------------
  // Create cloud-init seed ISO
  // -----------------------------------------------------------------------
  const seedDir = path.join(TEST_DIR, 'seed-data')
  fs.mkdirSync(seedDir, { recursive: true })
  fs.writeFileSync(path.join(seedDir, 'meta-data'),
    `instance-id: eval-test-${Date.now()}\nlocal-hostname: shogo-vm\n`)
  fs.writeFileSync(path.join(seedDir, 'user-data'), `#cloud-config
password: shogo
chpasswd:
  expire: false
users:
  - name: shogo
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    plain_text_passwd: shogo
write_files:
  - path: /opt/vsock-bridge.py
    permissions: '0755'
    content: |
      #!/usr/bin/env python3
      import socket, threading, sys

      def bridge(src, dst):
          try:
              while True:
                  data = src.recv(65536)
                  if not data:
                      break
                  dst.sendall(data)
          except:
              pass
          finally:
              try: src.close()
              except: pass
              try: dst.close()
              except: pass

      def handle(client, target_port):
          tcp = socket.create_connection(('127.0.0.1', target_port))
          t1 = threading.Thread(target=bridge, args=(client, tcp), daemon=True)
          t2 = threading.Thread(target=bridge, args=(tcp, client), daemon=True)
          t1.start()
          t2.start()

      vsock = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
      vsock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
      vsock.bind((socket.VMADDR_CID_ANY, 1))
      vsock.listen(32)
      sys.stdout.write("vsock-bridge listening on port 1\\n")
      sys.stdout.flush()
      while True:
          client, addr = vsock.accept()
          threading.Thread(target=handle, args=(client, 8080), daemon=True).start()
runcmd:
  - mkdir -p /mnt/workspace /mnt/bundle
  - mount -t virtiofs workspace /mnt/workspace 2>/dev/null || true
  - mount -t virtiofs bundle /mnt/bundle 2>/dev/null || true
  - date -s "${new Date().toISOString()}"
  - echo "BOOT_OK $(date)" > /mnt/workspace/vm-boot-marker.txt 2>/dev/null || true
  - |
    export PATH=/mnt/bundle:$PATH
    cd /mnt/workspace
    /mnt/bundle/bun add typescript-language-server typescript 2>/mnt/workspace/lsp-install.log || true
    echo "LSP_INSTALLED" > /mnt/workspace/lsp-installed.txt
  - |
    export PROJECT_ID=__POOL__
    export PORT=8080
    export WORKSPACE_DIR=/mnt/workspace
    export AGENT_DIR=/mnt/workspace
    export PROJECT_DIR=/mnt/workspace
    export NODE_ENV=development
    export RUNTIME_AUTH_SECRET=test-secret
    export TREE_SITTER_WASM_DIR=/mnt/bundle/wasm
    export PATH=/mnt/bundle:/mnt/workspace/node_modules/.bin:$PATH
    export ANTHROPIC_API_KEY=${ANTHROPIC_KEY}
    nohup /mnt/bundle/bun run /mnt/bundle/server.js > /mnt/workspace/agent-runtime.log 2>&1 &
    sleep 1
    nohup python3 /opt/vsock-bridge.py > /mnt/workspace/vsock-bridge.log 2>&1 &
    echo "AGENT_STARTED" > /mnt/workspace/agent-started.txt
`)

  const seedISO = path.join(TEST_DIR, 'seed.iso')
  execSync(`hdiutil makehybrid -o "${seedISO}" "${seedDir}" -iso -joliet -default-volume-name cidata`, { stdio: 'pipe' })
  pass('Cloud-init seed ISO created')

  // -----------------------------------------------------------------------
  // Start Go helper + boot VM
  // -----------------------------------------------------------------------
  log('Spawning Go helper...')
  const goProc = spawn(GO_HELPER, [], { stdio: ['pipe', 'pipe', 'pipe'] })

  const consoleLines: string[] = []
  goProc.stderr!.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(l => l.trim())
    consoleLines.push(...lines)
  })

  const rpc = new TestJsonRpcClient(goProc)
  pass(`Go helper spawned (PID ${goProc.pid})`)

  // Boot VM with two VirtioFS shares:
  //   "workspace" -> test workspace dir
  //   "repo"      -> monorepo root (so VM can run agent-runtime source directly)
  log('Test 1: Starting VM...')
  const t1 = Date.now()
  try {
    const result = await rpc.call('start', {
      kernelPath: path.join(VM_IMAGE_DIR, 'vmlinuz'),
      initrdPath: path.join(VM_IMAGE_DIR, 'initrd.img'),
      rootDiskPath: overlayPath,
      seedISOPath: seedISO,
      memoryMB: 4096,
      cpus: 4,
      shares: {
        workspace: WORKSPACE_DIR,
        bundle: BUNDLE_DIR,
      },
      readOnlyShares: {},
    }, 30000)
    pass(`VM started in ${Date.now() - t1}ms`)
  } catch (err) {
    fail('Start VM', err)
    goProc.kill()
    process.exit(1)
  }

  // -----------------------------------------------------------------------
  // Forward vsock port 1 -> localhost TCP
  // -----------------------------------------------------------------------
  log('Test 2: Forwarding vsock port 1 -> localhost:39200...')
  const HOST_PORT = 39200
  try {
    await rpc.call('forward', { vsockPort: 1, hostPort: HOST_PORT })
    pass(`Port forward: vsock:1 -> localhost:${HOST_PORT}`)
  } catch (err) {
    fail('Port forward', err)
  }

  const agentUrl = `http://localhost:${HOST_PORT}`

  // -----------------------------------------------------------------------
  // Wait for cloud-init boot marker
  // -----------------------------------------------------------------------
  log('Test 3: Waiting for cloud-init + VirtioFS (max 40s)...')
  let booted = false
  for (let i = 0; i < 40; i++) {
    await sleep(1000)
    if (fs.existsSync(path.join(WORKSPACE_DIR, 'vm-boot-marker.txt'))) {
      const marker = fs.readFileSync(path.join(WORKSPACE_DIR, 'vm-boot-marker.txt'), 'utf-8').trim()
      pass(`Cloud-init done: "${marker}" (${i + 1}s)`)
      booted = true
      break
    }
  }
  if (!booted) {
    fail('Cloud-init boot', 'Boot marker not found after 40s')
    console.log(`  Last ${Math.min(10, consoleLines.length)} console lines:`)
    for (const l of consoleLines.slice(-10)) console.log(`    ${l}`)
    await cleanup(rpc, goProc)
    process.exit(1)
  }

  // Check if agent-runtime was started
  if (fs.existsSync(path.join(WORKSPACE_DIR, 'agent-started.txt'))) {
    pass('Agent-runtime start command issued by cloud-init')
  } else {
    fail('Agent start marker', 'agent-started.txt not found')
  }

  // -----------------------------------------------------------------------
  // Wait for agent-runtime /health to respond
  // -----------------------------------------------------------------------
  log('Test 4: Waiting for agent-runtime /health (max 90s)...')
  let healthy = false
  const healthStart = Date.now()
  for (let i = 0; i < 90; i++) {
    try {
      const res = await fetch(`${agentUrl}/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        const body = await res.json() as any
        const elapsed = ((Date.now() - healthStart) / 1000).toFixed(1)
        pass(`/health responded 200 in ${elapsed}s`)
        if (body.gateway?.running) {
          pass(`Gateway is running`)
        } else {
          log('Gateway not yet running, waiting...')
          // Wait more for gateway
          for (let j = 0; j < 30; j++) {
            await sleep(2000)
            try {
              const r2 = await fetch(`${agentUrl}/health`, { signal: AbortSignal.timeout(2000) })
              if (r2.ok) {
                const b2 = await r2.json() as any
                if (b2.gateway?.running) {
                  pass(`Gateway ready (${((Date.now() - healthStart) / 1000).toFixed(1)}s total)`)
                  healthy = true
                  break
                }
              }
            } catch {}
          }
          if (!healthy) {
            // Health is responding but gateway may not fully start in pool mode
            // That's OK -- pool mode waits for /pool/assign before starting gateway
            pass(`Health OK (pool mode — gateway starts after assign)`)
            healthy = true
          }
        }
        healthy = true
        break
      }
    } catch {
      // Not ready yet
    }
    // Check the log file for errors
    if (i > 0 && i % 15 === 0) {
      const logPath = path.join(WORKSPACE_DIR, 'agent-runtime.log')
      if (fs.existsSync(logPath)) {
        const logContent = fs.readFileSync(logPath, 'utf-8')
        const lastLines = logContent.split('\n').slice(-5).join('\n')
        log(`  agent-runtime.log tail: ${lastLines.substring(0, 200)}`)
      } else {
        log('  agent-runtime.log not yet created')
      }
    }
    await sleep(1000)
  }

  if (!healthy) {
    fail('Agent-runtime health', `No healthy response after 90s`)
    const logPath = path.join(WORKSPACE_DIR, 'agent-runtime.log')
    if (fs.existsSync(logPath)) {
      console.log('\n--- agent-runtime.log (last 30 lines) ---')
      const content = fs.readFileSync(logPath, 'utf-8')
      const lines = content.split('\n').slice(-30)
      for (const l of lines) console.log(`  ${l}`)
    }
    await cleanup(rpc, goProc)
    process.exit(1)
  }

  // -----------------------------------------------------------------------
  // Test /pool/assign
  // -----------------------------------------------------------------------
  const AUTH_SECRET = 'test-secret'
  log('Test 5: POST /pool/assign...')
  try {
    const assignRes = await fetch(`${agentUrl}/pool/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-runtime-token': AUTH_SECRET },
      body: JSON.stringify({
        projectId: 'eval-test-project',
        env: {
          PROJECT_ID: 'eval-test-project',
          WORKSPACE_DIR: '/mnt/workspace',
          ANTHROPIC_API_KEY: ANTHROPIC_KEY,
        },
      }),
      signal: AbortSignal.timeout(30000),
    })
    if (assignRes.ok) {
      const body = await assignRes.json() as any
      pass(`/pool/assign succeeded: ${JSON.stringify(body).substring(0, 100)}`)
    } else {
      const text = await assignRes.text()
      fail('/pool/assign', `HTTP ${assignRes.status}: ${text.substring(0, 200)}`)
    }
  } catch (err: any) {
    fail('/pool/assign', err.message)
  }

  // Wait for re-initialization after assign (gateway + skills + LSP startup)
  await sleep(20000)

  // -----------------------------------------------------------------------
  // Test: /health after assign
  // -----------------------------------------------------------------------
  log('Test 6: /health after assign...')
  try {
    const res = await fetch(`${agentUrl}/health`, { headers: { 'x-runtime-token': AUTH_SECRET }, signal: AbortSignal.timeout(5000) })
    if (res.ok) {
      const body = await res.json() as any
      pass(`/health OK after assign (gateway.running=${body.gateway?.running})`)
    } else {
      fail('/health after assign', `HTTP ${res.status}`)
    }
  } catch (err: any) {
    fail('/health after assign', err.message)
  }

  // -----------------------------------------------------------------------
  // Test: simple agent chat (if gateway is up)
  // -----------------------------------------------------------------------
  log('Test 7: Simple agent chat (with ANTHROPIC_API_KEY)...')
  try {
    const chatRes = await fetch(`${agentUrl}/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-runtime-token': AUTH_SECRET },
      body: JSON.stringify({
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'Reply with exactly the text: EVAL_OK' }] }],
      }),
      signal: AbortSignal.timeout(120000),
    })
    if (chatRes.ok) {
      const reader = chatRes.body?.getReader()
      let responseText = ''
      if (reader) {
        const decoder = new TextDecoder()
        const readStart = Date.now()
        while (Date.now() - readStart < 60000) {
          const { done, value } = await reader.read()
          if (done) break
          responseText += decoder.decode(value, { stream: true })
        }
        try { reader.cancel() } catch {}
      }

      // Parse SSE events to find text content from the LLM
      const textParts: string[] = []
      const errorParts: string[] = []
      let usageData: any = null
      for (const line of responseText.split('\n')) {
        if (!line.startsWith('data: ')) continue
        try {
          const evt = JSON.parse(line.slice(6))
          if (evt.type === 'text-delta' && evt.delta) textParts.push(evt.delta)
          if (evt.type === 'text-delta' && evt.textDelta) textParts.push(evt.textDelta)
          if (evt.type === 'data-content' && evt.data) {
            for (const part of evt.data) {
              if (part.type === 'text') textParts.push(part.text)
            }
          }
          if (evt.type === 'data-usage') usageData = evt.data
          if (evt.type === 'error') errorParts.push(JSON.stringify(evt))
        } catch {}
      }
      const llmText = textParts.join('')

      if (errorParts.length > 0) {
        fail('LLM errors in stream', errorParts.join('; ').substring(0, 300))
      }

      if (llmText.length > 0) {
        pass(`LLM responded: "${llmText.substring(0, 200).replace(/\n/g, '\\n')}"`)
        if (llmText.includes('EVAL_OK')) {
          pass('LLM followed instruction correctly (contains EVAL_OK)')
        }
        if (usageData) {
          pass(`Usage: ${usageData.inputTokens} in / ${usageData.outputTokens} out, ${usageData.iterations} iteration(s), ${usageData.toolCallCount} tool calls`)
        }
      } else {
        log(`  Full raw stream (${responseText.length} bytes):`)
        for (const line of responseText.split('\n')) {
          if (line.trim()) log(`    ${line.substring(0, 200)}`)
        }
        fail('No LLM text in stream response')
      }
    } else {
      const text = await chatRes.text()
      fail('Agent chat', `HTTP ${chatRes.status}: ${text.substring(0, 300)}`)
    }
  } catch (err: any) {
    fail('Agent chat', err.message)
  }

  // Wait for log to flush after chat
  await sleep(5000)

  // -----------------------------------------------------------------------
  // Verify VM logs for LSP + skill-server
  // -----------------------------------------------------------------------
  log('Test 8: Checking VM logs for LSP and skill-server...')
  const logPath = path.join(WORKSPACE_DIR, 'agent-runtime.log')
  if (fs.existsSync(logPath)) {
    const logContent = fs.readFileSync(logPath, 'utf-8')
    if (logContent.includes('LSP-TS') && !logContent.includes('Could not find language server binary')) {
      pass('TypeScript LSP started successfully')
    } else if (logContent.includes('Could not find language server binary')) {
      fail('TypeScript LSP', 'typescript-language-server not found in PATH')
    } else {
      pass('TypeScript LSP (no explicit error)')
    }

    if (logContent.includes('Script not found "npx"') || logContent.includes("npx: not found")) {
      fail('npx availability', 'npx not found in PATH')
    } else {
      pass('npx available on PATH (bun symlink)')
    }

    // Print any remaining errors
    const errorLines = logContent.split('\n').filter(l => l.toLowerCase().includes('error') || l.toLowerCase().includes('fail'))
    if (errorLines.length > 0) {
      log(`  ${errorLines.length} error/warning lines in agent-runtime.log:`)
      for (const l of errorLines.slice(0, 5)) log(`    ${l.substring(0, 150)}`)
    }
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------
  await cleanup(rpc, goProc)

  console.log('\n\x1b[1m=== Test Summary ===\x1b[0m')
  console.log(`  Platform: macOS ${process.arch} (Virtualization.framework)`)
  console.log(`  Agent-runtime: pool mode -> /pool/assign -> chat`)
  console.log(`  VM Memory: 4GB, CPUs: 4`)
  console.log('')
}

async function cleanup(rpc: TestJsonRpcClient, goProc: ChildProcess) {
  log('Stopping VM...')
  try {
    await rpc.call('stop', {}, 10000)
    pass('VM stopped')
  } catch (err) {
    fail('Stop VM', err)
  }
  rpc.destroy()
  goProc.kill('SIGTERM')
  await sleep(1000)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
