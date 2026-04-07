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
import { existsSync, mkdirSync, rmSync, symlinkSync, readdirSync, copyFileSync, cpSync, writeFileSync } from 'fs'
import { resolve, join } from 'path'
import { tmpdir } from 'os'
import { type DockerWorker, REPO_ROOT } from './docker-worker'

const isWin = process.platform === 'win32'

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
// Cross-platform helpers
// ---------------------------------------------------------------------------

function findGlobDirs(baseDir: string, pattern: RegExp): string[] {
  if (!existsSync(baseDir)) return []
  const results: string[] = []
  try {
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (entry.isDirectory() && pattern.test(entry.name)) {
        results.push(join(baseDir, entry.name))
      }
    }
  } catch {}
  return results
}

function downloadLinuxBun(destDir: string): void {
  // VM guest is always Linux; pick arch based on host (arm64 Mac -> aarch64, x64 -> x64)
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64'
  const bunVersion = execSync('bun --version', { encoding: 'utf-8' }).trim()
  console.log(`  Downloading Linux ${arch} bun v${bunVersion} for VM...`)

  const zipPath = join(tmpdir(), `bun-linux-${arch}.zip`)
  const extractDir = join(tmpdir(), 'bun-extract')

  // curl is available on both macOS and Windows 10+
  execSync(
    `curl -fsSL -o "${zipPath}" "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-linux-${arch}.zip"`,
    { stdio: 'pipe', timeout: 60_000 }
  )

  mkdirSync(extractDir, { recursive: true })

  if (isWin) {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
      { stdio: 'pipe', timeout: 30_000 }
    )
  } else {
    execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: 'pipe' })
  }

  const bunBinaryPath = join(extractDir, `bun-linux-${arch}`, 'bun')
  const dest = join(destDir, 'bun')
  copyFileSync(bunBinaryPath, dest)

  if (!isWin) {
    execSync(`chmod +x "${dest}"`, { stdio: 'pipe' })
  }
}

function copyPrismaPackages(destDir: string): void {
  const prismaPackages = ['prisma', '@prisma/client', '@prisma/prisma-schema-wasm', '@prisma/internals', '@prisma/fetch-engine', '@prisma/engines']
  const srcBase = join(REPO_ROOT, 'node_modules')
  const destBase = join(destDir, 'node_modules')

  for (const pkg of prismaPackages) {
    const destPkg = join(destBase, pkg)
    if (existsSync(destPkg)) continue

    // Resolve through .bun junctions or direct paths
    let srcPkg = join(srcBase, pkg)
    if (!existsSync(join(srcPkg, 'package.json'))) {
      // Search .bun cache directory
      const bunDir = join(srcBase, '.bun')
      if (existsSync(bunDir)) {
        const prefix = pkg.replace('/', '+') + '@'
        const dirs = findGlobDirs(bunDir, new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
        for (const d of dirs) {
          const candidate = join(d, 'node_modules', pkg)
          if (existsSync(join(candidate, 'package.json'))) {
            srcPkg = candidate
            break
          }
        }
      }
    }

    if (existsSync(join(srcPkg, 'package.json'))) {
      mkdirSync(join(destBase, ...pkg.split('/').slice(0, -1)), { recursive: true })
      cpSync(srcPkg, destPkg, { recursive: true })
    }
  }
}

function createBunAlias(dir: string, alias: string): void {
  const link = join(dir, alias)
  if (existsSync(link)) return

  if (isWin) {
    // The VM runs Linux — create a Unix symlink-like shell script
    // that the Linux bun binary can execute. Don't copy the 95MB binary.
    try { symlinkSync('bun', link) } catch {
      // If symlinks need admin, write a tiny shell script instead
      writeFileSync(link, '#!/bin/sh\nexec "$(dirname "$0")/bun" "$@"\n')
    }
  } else {
    try { symlinkSync('bun', link) } catch {}
  }
}

// ---------------------------------------------------------------------------
// VM bundle preparation
// ---------------------------------------------------------------------------

let _bundleDir: string | null = null
let _bundleFiles: Record<string, Buffer> | null = null

/**
 * Build the agent-runtime + shogo CLI JS bundles.
 *
 * On macOS (VirtioFS bundle mount): also downloads Linux bun, templates, wasm
 * files into a directory that gets mounted into the VM.
 *
 * On Windows (pre-provisioned image): only builds server.js + shogo.js.
 * These are embedded in the seed ISO; the base image already has bun, node,
 * templates, etc.
 */
function ensureVMBundle(): { dir: string; bundleFiles: Record<string, Buffer> } {
  if (_bundleDir && _bundleFiles && existsSync(join(_bundleDir, 'server.js'))) {
    return { dir: _bundleDir, bundleFiles: _bundleFiles }
  }

  const dir = resolve(tmpdir(), 'shogo-vm-eval-bundle')
  mkdirSync(dir, { recursive: true })

  // Always build the JS bundles (needed on all platforms)
  if (!existsSync(join(dir, 'server.js'))) {
    console.log('  Building agent-runtime bundle for VM...')
    execSync(
      `bun build src/server.ts --outdir "${dir}" --target bun --external electron --external playwright-core --external playwright`,
      { cwd: resolve(REPO_ROOT, 'packages/agent-runtime'), stdio: 'pipe' }
    )
  }

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

  // Read the JS bundles into memory for ISO embedding (used on Windows)
  const readBuf = (f: string) => {
    const p = join(dir, f)
    return existsSync(p) ? require('fs').readFileSync(p) : Buffer.alloc(0)
  }
  const bundleFiles: Record<string, Buffer> = {
    'server.js': readBuf('server.js'),
    'shogo.js': readBuf('shogo.js'),
  }

  // Include tree-sitter.wasm so the VM agent-runtime can load it
  if (isWin) {
    const bunModBase = join(REPO_ROOT, 'node_modules', '.bun')
    const tsWasmDirs = findGlobDirs(bunModBase, /^web-tree-sitter@/)
    for (const d of tsWasmDirs) {
      const wasmFile = join(d, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm')
      if (existsSync(wasmFile)) {
        bundleFiles['tree-sitter.wasm'] = require('fs').readFileSync(wasmFile)
        break
      }
    }
  }

  // macOS needs the full bundle directory with bun binary, templates, wasm, etc.
  if (!isWin) {
    ensureMacOSBundleExtras(dir)
  }

  _bundleDir = dir
  _bundleFiles = bundleFiles
  console.log(`  VM bundle ready at ${dir}`)
  return { dir, bundleFiles }
}

/** macOS-only: populate the full bundle directory for VirtioFS mount */
function ensureMacOSBundleExtras(dir: string): void {
  // Prisma packages for shogo CLI
  if (!existsSync(join(dir, 'node_modules', '@prisma', 'internals'))) {
    console.log('  Installing prisma packages for shogo CLI...')
    if (!existsSync(join(dir, 'package.json'))) {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'vm-bundle', private: true }))
    }
    try {
      execSync(
        `bun add prisma @prisma/client @prisma/prisma-schema-wasm @prisma/internals @prisma/fetch-engine`,
        { cwd: dir, stdio: 'pipe', timeout: 60_000 }
      )
    } catch {
      copyPrismaPackages(dir)
    }
  }

  // Linux bun binary
  if (!existsSync(join(dir, 'bun'))) downloadLinuxBun(dir)
  for (const alias of ['node', 'npx', 'npm']) createBunAlias(dir, alias)

  // Tree-sitter wasm files
  const wasmDir = join(dir, 'wasm')
  if (!existsSync(wasmDir)) {
    mkdirSync(wasmDir, { recursive: true })
    try {
      const bunModBase = join(REPO_ROOT, 'node_modules', '.bun')
      const tsWasmDirs = findGlobDirs(bunModBase, /^web-tree-sitter@/)
      for (const d of tsWasmDirs) {
        const wasmFile = join(d, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm')
        if (existsSync(wasmFile)) { copyFileSync(wasmFile, join(wasmDir, 'tree-sitter.wasm')); break }
      }
      const langWasmDirs = findGlobDirs(bunModBase, /^tree-sitter-wasms@/)
      for (const d of langWasmDirs) {
        const outDir = join(d, 'node_modules', 'tree-sitter-wasms', 'out')
        if (existsSync(outDir)) {
          for (const f of readdirSync(outDir)) {
            if (f.endsWith('.wasm')) copyFileSync(join(outDir, f), join(wasmDir, f))
          }
          break
        }
      }
    } catch {}
  }

  // Templates
  const templatesDir = join(dir, 'templates')
  const rtDir = join(templatesDir, 'runtime-template')
  const ssDir = join(templatesDir, 'skill-server')

  if (!existsSync(join(rtDir, 'node_modules'))) {
    console.log('  Preparing runtime-template with deps for VM...')
    const srcTemplate = resolve(REPO_ROOT, 'templates/runtime-template')
    mkdirSync(rtDir, { recursive: true })
    cpSync(srcTemplate, rtDir, { recursive: true })
    try {
      execSync('bun install', { cwd: rtDir, stdio: 'pipe', timeout: 60_000 })
    } catch {
      if (!existsSync(join(rtDir, 'node_modules'))) throw new Error('bun install failed')
    }
  }

  if (!existsSync(join(ssDir, 'package.json'))) {
    mkdirSync(ssDir, { recursive: true })
    writeFileSync(join(ssDir, 'package.json'), JSON.stringify({
      name: 'skill-server', private: true,
      dependencies: { 'hono': '^4.7.0', 'prisma': '7.4.1', '@prisma/client': '7.4.1', 'prisma-adapter-bun-sqlite': '^0.6.8' },
    }))
  }
}

// ---------------------------------------------------------------------------
// VM tracking
// ---------------------------------------------------------------------------

const _vmHandles = new Map<number, { handle: VMHandle; manager: VMManagerLike; overlayPath: string }>()
let _vmManager: VMManagerLike | null = null

function getVMManager(): VMManagerLike {
  if (_vmManager) return _vmManager

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

  const { dir: bundleDir, bundleFiles } = ensureVMBundle()

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
    bundleDir: isWin ? undefined : bundleDir,
    skillServerHostPort: skillHostPort,
    env: vmEnv,
    bundleFiles: isWin ? bundleFiles : undefined,
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
