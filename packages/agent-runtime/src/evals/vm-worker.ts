// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * VM-based worker pool for eval runners.
 *
 * Boots a VM via DarwinVMManager (macOS) or Win32VMManager (Windows) instead
 * of spawning Docker containers or local bun processes. The VM runs agent-runtime
 * in pool mode, and the eval harness talks to it over HTTP just like Docker/local.
 *
 * Usage: pass --vm to run-eval.ts to use VM isolation.
 */

import { execSync } from 'child_process'
import { existsSync, mkdirSync, rmSync, symlinkSync, readdirSync, copyFileSync } from 'fs'
import { resolve, join } from 'path'
import { tmpdir } from 'os'
import { type DockerWorker, REPO_ROOT } from './docker-worker'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VMWorkerConfig {
  containerPrefix: string
  baseHostPort: number
  model: string
  verbose: boolean
  memoryMB?: number
  cpus?: number
  vmImageDir?: string
  envOverrides?: Record<string, string>
}

interface VMHandle {
  id: string
  agentUrl: string
  skillServerPort: number
  pid: number
  platform: 'darwin' | 'win32'
}

interface VMManagerLike {
  startVM(config: any): Promise<VMHandle>
  stopVM(handle: VMHandle): Promise<void>
  isRunning(handle: VMHandle): boolean
  forwardPort(handle: VMHandle, guestPort: number, hostPort: number): Promise<void>
  removeForward(handle: VMHandle, hostPort: number): Promise<void>
}

// ---------------------------------------------------------------------------
// VM bundle preparation
// ---------------------------------------------------------------------------

let _bundleDir: string | null = null

function ensureVMBundle(): string {
  if (_bundleDir && existsSync(join(_bundleDir, 'server.js'))) return _bundleDir

  const dir = resolve(tmpdir(), 'shogo-vm-eval-bundle')
  mkdirSync(dir, { recursive: true })

  // 1. Build agent-runtime bundle
  if (!existsSync(join(dir, 'server.js'))) {
    console.log('  Building agent-runtime bundle for VM...')
    execSync(
      `bun build src/server.ts --outdir "${dir}" --target bun --external electron --external playwright-core --external playwright`,
      { cwd: resolve(REPO_ROOT, 'packages/agent-runtime'), stdio: 'pipe' }
    )
  }

  // 2. Build shogo CLI bundle — externalize @prisma/* (bun bakes __dirname as
  //    absolute host paths for bundled packages with native/WASM assets)
  if (!existsSync(join(dir, 'shogo.js'))) {
    console.log('  Building shogo CLI bundle for VM...')
    execSync(
      `bun build packages/sdk/bin/shogo.ts --outfile "${join(dir, 'shogo.js')}" --target bun ` +
      `--external electron --external playwright-core --external playwright ` +
      `--external @prisma/prisma-schema-wasm --external @prisma/engines ` +
      `--external @prisma/fetch-engine --external @prisma/internals`,
      { cwd: REPO_ROOT, stdio: 'pipe' }
    )
  }

  // 2b. Install externalized prisma packages in the bundle's node_modules so
  //     they resolve correctly at runtime (WASM is platform-independent)
  if (!existsSync(join(dir, 'node_modules', '@prisma', 'internals'))) {
    console.log('  Installing prisma packages for shogo CLI...')
    execSync(
      `cd "${dir}" && bun add prisma @prisma/client @prisma/prisma-schema-wasm @prisma/internals @prisma/fetch-engine`,
      { stdio: 'pipe', timeout: 60_000 }
    )
  }

  // 3. Download Linux bun binary
  if (!existsSync(join(dir, 'bun'))) {
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x64'
    const bunVersion = execSync('bun --version', { encoding: 'utf-8' }).trim()
    console.log(`  Downloading Linux ${arch} bun v${bunVersion} for VM...`)
    const zipPath = join(tmpdir(), `bun-linux-${arch}.zip`)
    execSync(
      `curl -fsSL -o "${zipPath}" "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-linux-${arch}.zip" && ` +
      `unzip -o "${zipPath}" -d "${join(tmpdir(), 'bun-extract')}" && ` +
      `cp "${join(tmpdir(), 'bun-extract', `bun-linux-${arch}`, 'bun')}" "${join(dir, 'bun')}" && ` +
      `chmod +x "${join(dir, 'bun')}"`,
      { stdio: 'pipe' }
    )
  }

  // 4. Create node/npx/npm symlinks to bun
  for (const alias of ['node', 'npx', 'npm']) {
    const link = join(dir, alias)
    if (!existsSync(link)) {
      try { symlinkSync('bun', link) } catch {}
    }
  }

  // 5. Copy tree-sitter wasm files
  const wasmDir = join(dir, 'wasm')
  if (!existsSync(wasmDir)) {
    mkdirSync(wasmDir, { recursive: true })
    try {
      const tsWasmGlob = execSync(
        `ls ${REPO_ROOT}/node_modules/.bun/web-tree-sitter@*/node_modules/web-tree-sitter/tree-sitter.wasm 2>/dev/null || true`,
        { encoding: 'utf-8' }
      ).trim()
      if (tsWasmGlob) copyFileSync(tsWasmGlob.split('\n')[0], join(wasmDir, 'tree-sitter.wasm'))

      const langDir = execSync(
        `ls -d ${REPO_ROOT}/node_modules/.bun/tree-sitter-wasms@*/node_modules/tree-sitter-wasms/out 2>/dev/null || true`,
        { encoding: 'utf-8' }
      ).trim()
      if (langDir && existsSync(langDir)) {
        for (const f of readdirSync(langDir)) {
          if (f.endsWith('.wasm')) copyFileSync(join(langDir, f), join(wasmDir, f))
        }
      }
    } catch {}
  }

  // 6. Pre-install templates with node_modules — mirrors what Docker does
  //    Docker: /app/templates/runtime-template (with node_modules for vite, react, etc.)
  //    Docker: /app/templates/skill-server    (with node_modules for prisma, hono, etc.)
  const templatesDir = join(dir, 'templates')
  const rtDir = join(templatesDir, 'runtime-template')
  const ssDir = join(templatesDir, 'skill-server')

  if (!existsSync(join(rtDir, 'node_modules'))) {
    console.log('  Preparing runtime-template with deps for VM...')
    const srcTemplate = resolve(REPO_ROOT, 'templates/runtime-template')
    mkdirSync(rtDir, { recursive: true })
    execSync(`cp -a "${srcTemplate}/." "${rtDir}/"`, { stdio: 'pipe' })
    execSync(`cd "${rtDir}" && "${join(dir, 'bun')}" install 2>/dev/null || bun install`, { stdio: 'pipe', timeout: 60_000 })
  }

  // Skill-server template: only create package.json, deps are installed inside
  // the VM at boot (Prisma needs Linux-native engine binaries)
  if (!existsSync(join(ssDir, 'package.json'))) {
    console.log('  Preparing skill-server template for VM...')
    mkdirSync(ssDir, { recursive: true })
    const ssPackageJson = JSON.stringify({
      name: 'skill-server',
      private: true,
      dependencies: {
        'hono': '^4.7.0',
        'prisma': '7.4.1',
        '@prisma/client': '7.4.1',
        'prisma-adapter-bun-sqlite': '^0.6.8',
      },
    })
    require('fs').writeFileSync(join(ssDir, 'package.json'), ssPackageJson)
  }

  _bundleDir = dir
  console.log(`  VM bundle ready at ${dir}`)
  return dir
}

// ---------------------------------------------------------------------------
// VM tracking
// ---------------------------------------------------------------------------

const _vmHandles = new Map<number, { handle: VMHandle; manager: VMManagerLike; overlayPath: string }>()
let _vmManager: VMManagerLike | null = null

function getVMManager(): VMManagerLike {
  if (_vmManager) return _vmManager

  // Dynamically import the desktop VM module
  const vmModule = require(resolve(REPO_ROOT, 'apps/desktop/src/vm/index'))
  _vmManager = vmModule.createVMManager()
  return _vmManager!
}

function getVMImageDir(): string {
  return resolve(REPO_ROOT, 'apps/desktop/resources/vm')
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

export async function startVMWorker(
  id: number,
  config: VMWorkerConfig,
  opts?: { workspaceDir?: string },
): Promise<DockerWorker> {
  const port = config.baseHostPort + id
  const name = `${config.containerPrefix}-${id}`
  const dir = opts?.workspaceDir || resolve(tmpdir(), `${config.containerPrefix}-${id}`)

  console.log(`  Starting VM worker ${id} (${name}) on port ${port}...`)

  mkdirSync(dir, { recursive: true })

  const manager = getVMManager()
  const vmImageDir = config.vmImageDir || getVMImageDir()
  const overlayDir = resolve(tmpdir(), 'shogo-vm-eval-overlays')
  mkdirSync(overlayDir, { recursive: true })
  const overlayPath = join(overlayDir, `${name}.${process.platform === 'darwin' ? 'raw' : 'qcow2'}`)

  if (existsSync(overlayPath)) {
    rmSync(overlayPath, { force: true })
  }

  // Prepare VM bundle directory (bun, agent-runtime, shogo CLI, wasm files)
  const bundleDir = ensureVMBundle()

  // Skill-server host port matches Docker convention: SKILL_SERVER_BASE_PORT + worker.id
  const skillHostPort = 4100 + id

  // Collect env vars to pass to the VM (no RUNTIME_AUTH_SECRET — eval requests skip auth)
  const vmEnv: Record<string, string> = {
    PROJECT_ID: name,
    AGENT_MODEL: config.model,
    SKILL_SERVER_PORT: '4100',
    ...config.envOverrides,
  }
  if (process.env.ANTHROPIC_API_KEY && !vmEnv.ANTHROPIC_API_KEY) vmEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
  if (process.env.OPENAI_API_KEY && !vmEnv.OPENAI_API_KEY) vmEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY

  const handle = await manager.startVM({
    workspaceDir: dir,
    credentialDirs: [],
    memoryMB: config.memoryMB || 8192,
    cpus: config.cpus || 4,
    networkEnabled: true,
    overlayPath,
    vmImageDir,
    bundleDir,
    skillServerHostPort: skillHostPort,
    env: vmEnv,
  })

  _vmHandles.set(id, { handle, manager, overlayPath })

  // The VM's agent-runtime URL comes from the handle
  const vmUrl = handle.agentUrl
  const vmPort = parseInt(new URL(vmUrl).port)

  // Poll /health until ready (VM boot + cloud-init + dep install can take a while)
  const maxWait = 180_000
  const start = Date.now()
  let delay = 2000

  while (Date.now() - start < maxWait) {
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 3_000)
      const res = await fetch(`${vmUrl}/health`, { signal: ctl.signal })
      clearTimeout(t)
      if (res.ok) {
        const body = await res.json().catch(() => null) as any
        if (body?.gateway?.running === true) {
          console.log(`  VM worker ${id} ready on port ${vmPort} (${Date.now() - start}ms)`)
          return { id, port: vmPort, dir, containerName: name }
        }
        if (config.verbose && Date.now() - start > 5_000) {
          console.log(`  VM worker ${id} HTTP ok but gateway not ready yet (${Date.now() - start}ms)`)
        }
      }
    } catch {
      if (!manager.isRunning(handle)) {
        _vmHandles.delete(id)
        throw new Error(`VM worker ${id} died during startup`)
      }
    }

    await Bun.sleep(delay)
    delay = Math.min(delay * 1.5, 3_000)
  }

  stopVMWorker({ id, port: vmPort, dir, containerName: name })
  throw new Error(`VM worker ${id} failed to start within ${maxWait}ms`)
}

export function stopVMWorker(worker: DockerWorker): void {
  const entry = _vmHandles.get(worker.id)
  if (!entry) return

  entry.manager.stopVM(entry.handle).catch(() => {})

  // Clean up overlay
  if (existsSync(entry.overlayPath)) {
    try { rmSync(entry.overlayPath, { force: true }) } catch {}
  }

  _vmHandles.delete(worker.id)
}

export function stopAllVMWorkers(): void {
  for (const [id, entry] of _vmHandles) {
    entry.manager.stopVM(entry.handle).catch(() => {})
    if (existsSync(entry.overlayPath)) {
      try { rmSync(entry.overlayPath, { force: true }) } catch {}
    }
  }
  _vmHandles.clear()
}
