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

import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs'
import { resolve, join } from 'path'
import { tmpdir } from 'os'
import { type DockerWorker, REPO_ROOT } from './docker-worker'

function getPrepareBundleModule() {
  return require(resolve(REPO_ROOT, 'apps/desktop/src/vm/prepare-bundle')) as {
    prepareVMBundle(opts: { destDir: string; repoRoot: string; prebuiltServerJs?: string; prebuiltShogoJs?: string }): void
    getTreeSitterWasmBuffer(repoRoot: string): Buffer | null
  }
}

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
let _bundleFiles: Record<string, Buffer> | null = null

/**
 * Build the agent-runtime + shogo CLI JS bundles for ISO embedding.
 *
 * Both platforms use pre-provisioned images with bun/templates pre-installed.
 * Only server.js, shogo.js, and tree-sitter.wasm are injected per boot via
 * the seed ISO.
 */
function ensureVMBundle(): Record<string, Buffer> {
  if (_bundleDir && _bundleFiles && existsSync(join(_bundleDir, 'server.js'))) {
    return _bundleFiles
  }

  const dir = resolve(tmpdir(), 'shogo-vm-eval-bundle')
  mkdirSync(dir, { recursive: true })

  const { execSync } = require('child_process')
  if (!existsSync(join(dir, 'server.js'))) {
    console.log('  Building agent-runtime bundle for VM...')
    execSync(
      `bun build src/server.ts --outdir "${dir}" --target bun --external electron --external playwright-core --external playwright`,
      { cwd: resolve(REPO_ROOT, 'packages/agent-runtime'), stdio: 'pipe' },
    )
  }
  if (!existsSync(join(dir, 'shogo.js'))) {
    console.log('  Building shogo CLI bundle for VM...')
    execSync(
      `bun build packages/sdk/bin/shogo.ts --outfile "${join(dir, 'shogo.js')}" --target bun ` +
        `--external electron --external playwright-core --external playwright ` +
        `--external @prisma/prisma-schema-wasm --external @prisma/engines ` +
        `--external @prisma/fetch-engine --external @prisma/internals`,
      { cwd: REPO_ROOT, stdio: 'pipe' },
    )
  }

  const readBuf = (f: string) => {
    const p = join(dir, f)
    return existsSync(p) ? readFileSync(p) : Buffer.alloc(0)
  }
  const bundleFiles: Record<string, Buffer> = {
    'server.js': readBuf('server.js'),
    'shogo.js': readBuf('shogo.js'),
  }

  const bundleMod = getPrepareBundleModule()
  const wasmBuf = bundleMod.getTreeSitterWasmBuffer(REPO_ROOT)
  if (wasmBuf) bundleFiles['tree-sitter.wasm'] = wasmBuf

  _bundleDir = dir
  _bundleFiles = bundleFiles
  console.log(`  VM bundle ready at ${dir}`)
  return bundleFiles
}

// ---------------------------------------------------------------------------
// VM tracking
// ---------------------------------------------------------------------------

const _vmHandles = new Map<number, { handle: VMHandle; manager: VMManagerLike; overlayPath: string }>()

function createVMManager(): VMManagerLike {
  const vmModule = require(resolve(REPO_ROOT, 'apps/desktop/src/vm/index'))
  return vmModule.createVMManager()
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

  const manager = createVMManager()
  const vmImageDir = config.vmImageDir || getVMImageDir()
  const overlayDir = resolve(tmpdir(), 'shogo-vm-eval-overlays')
  mkdirSync(overlayDir, { recursive: true })
  const overlayPath = join(overlayDir, `${name}.qcow2`)

  if (existsSync(overlayPath)) {
    rmSync(overlayPath, { force: true })
  }

  const bundleFiles = ensureVMBundle()

  const skillHostPort = 4100 + id

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
    skillServerHostPort: skillHostPort,
    env: vmEnv,
    bundleFiles,
  })

  _vmHandles.set(id, { handle, manager, overlayPath })

  const vmUrl = handle.agentUrl
  const vmPort = parseInt(new URL(vmUrl).port)

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
