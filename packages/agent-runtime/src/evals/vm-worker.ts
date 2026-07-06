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

import { existsSync, mkdirSync, rmSync, readFileSync, chmodSync, cpSync, mkdtempSync } from 'fs'
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
  /** Share the host workspace dir into the VM via 9p mount instead of using
   *  the isolated overlay disk. Files written to the host dir are visible
   *  inside the VM immediately. */
  mount?: boolean
  /** Base host port for the in-VM API/skill server forward
   *  (host:`skillBasePort + id` → guest:4100). Defaults to 4100 to match
   *  the historical single-run behavior. Override (e.g. 4200) when
   *  running two `run-eval.ts` invocations in parallel so they don't
   *  collide on QEMU host port forwards. */
  skillBasePort?: number
  /** Custom directory for QEMU overlay qcow2 files. Defaults to a shared
   *  tmpdir(). Override when running two parallel invocations so each
   *  has its own pool of overlay files. */
  overlayDir?: string
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
  if (_bundleFiles) return _bundleFiles

  const dir = resolve(tmpdir(), 'shogo-vm-eval-bundle')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  const { execSync } = require('child_process')
  console.log('  Building agent-runtime bundle for VM...')
  execSync(
    `bun build src/server.ts --outdir "${dir}" --target bun --external electron --external playwright-core --external playwright`,
    { cwd: resolve(REPO_ROOT, 'packages/agent-runtime'), stdio: 'pipe' },
  )
  console.log('  Building shogo CLI bundle for VM...')
  execSync(
    `bun build packages/sdk/bin/shogo.ts --outfile "${join(dir, 'shogo.js')}" --target bun ` +
      `--external electron --external playwright-core --external playwright ` +
      `--external @prisma/prisma-schema-wasm --external @prisma/engines ` +
      `--external @prisma/fetch-engine --external @prisma/internals`,
    { cwd: REPO_ROOT, stdio: 'pipe' },
  )

  // Inject the runtime-template SOURCE (no node_modules) into the seed bundle.
  // The template is normally baked into the VM image at /app/templates/, but
  // rootfs-provisioned images can ship without it (the bake step doesn't always
  // persist) — which makes every workspace seed fail with "runtime-template not
  // found in any candidate path". Shipping the source here (cloud-init extracts
  // it at boot) makes the eval self-sufficient regardless of the image; deps are
  // handled separately by ensureWorkspaceDeps. Mirrors the image-build staging:
  // materialize the `@shogo-ai/sdk: workspace:*` sentinel so an in-VM install can
  // resolve outside the monorepo.
  try {
    console.log('  Staging runtime-template source for VM...')
    const stageRoot = mkdtempSync(join(tmpdir(), 'shogo-rt-stage-'))
    const stagedTemplate = join(stageRoot, 'runtime-template')
    const srcTemplate = resolve(REPO_ROOT, 'templates/runtime-template')
    const skipTop = new Set(['node_modules', '.git', 'bun.lock', '.DS_Store'])
    cpSync(srcTemplate, stagedTemplate, {
      recursive: true,
      filter: (src) => {
        const rel = src.slice(srcTemplate.length + 1)
        return rel ? !skipTop.has(rel.split('/')[0]) : true
      },
    })
    const rtPkg = join(stagedTemplate, 'package.json')
    if (existsSync(rtPkg) && readFileSync(rtPkg, 'utf-8').includes('"workspace:')) {
      try {
        execSync(`bun run "${resolve(REPO_ROOT, 'scripts/materialize-runtime-template.ts')}" "${rtPkg}"`, {
          cwd: REPO_ROOT,
          stdio: 'pipe',
        })
      } catch (err: any) {
        console.warn(`  (runtime-template materialize skipped: ${err?.message ?? err})`)
      }
    }
    // COPYFILE_DISABLE=1 + --exclude stop macOS bsdtar from embedding AppleDouble
    // `._*` resource-fork companions. Without this, every `._App.tsx` etc. lands
    // in the guest workspace and the Canvas/TS compile runtime-check fails with
    // "Unexpected" parse errors on the junk files (nothing to do with the model).
    execSync(
      `tar --exclude='._*' --exclude='.DS_Store' -czf "${join(dir, 'runtime-template.tar.gz')}" -C "${stageRoot}" runtime-template`,
      { stdio: 'pipe', env: { ...process.env, COPYFILE_DISABLE: '1' } },
    )
    rmSync(stageRoot, { recursive: true, force: true })
  } catch (err: any) {
    console.warn(`  (runtime-template staging failed — VM will rely on baked image: ${err?.message ?? err})`)
  }

  const readBuf = (f: string) => {
    const p = join(dir, f)
    return existsSync(p) ? readFileSync(p) : Buffer.alloc(0)
  }
  const bundleFiles: Record<string, Buffer> = {
    'server.js': readBuf('server.js'),
    'shogo.js': readBuf('shogo.js'),
  }
  const rtTar = readBuf('runtime-template.tar.gz')
  if (rtTar.length > 0) bundleFiles['runtime-template.tar.gz'] = rtTar

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
  // Honor the same env override the desktop main process uses
  // (apps/desktop/src/vm/index.ts::getVMImageDir). This lets eval runs use
  // a pre-provisioned image installed under ~/Library/Application Support
  // without first copying it into the repo's resources/vm directory.
  if (process.env.SHOGO_VM_IMAGE_DIR) return process.env.SHOGO_VM_IMAGE_DIR
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
  if (config.mount) {
    // 9p with security_model=mapped-file: the guest sees host UID/permissions
    // for files without metadata. Make the workspace world-writable so the
    // guest shogo user can create files before cloud-init chown takes effect.
    chmodSync(dir, 0o777)
  }

  const manager = createVMManager()
  const vmImageDir = config.vmImageDir || getVMImageDir()
  const overlayDir = config.overlayDir || resolve(tmpdir(), 'shogo-vm-eval-overlays')
  mkdirSync(overlayDir, { recursive: true })
  const overlayPath = join(overlayDir, `${name}.qcow2`)

  if (existsSync(overlayPath)) {
    rmSync(overlayPath, { force: true })
  }

  const bundleFiles = ensureVMBundle()

  const skillHostPort = (config.skillBasePort ?? 4100) + id

  const vmEnv: Record<string, string> = {
    PROJECT_ID: name,
    AGENT_MODEL: config.model,
    // Pin the project API server to the same port the VM forwards
    // (host:4100+id → guest:4100 — see VM_DEFAULTS.guestSkillPort in
    // apps/desktop/src/vm/types.ts).  PreviewManager reads this to
    // override its default of 3001 when running inside the VM.
    API_SERVER_PORT: '4100',
    // Legacy alias retained for any not-yet-rebundled code that still
    // looks for SKILL_SERVER_PORT; harmless when ignored.
    SKILL_SERVER_PORT: '4100',
    // Prisma 7.8 resolves `datasource.url` from prisma.config.ts at config
    // load time and HARD-ERRORS ("The datasource.url property is required in
    // your Prisma config file when using prisma db push.") when it can't —
    // i.e. when DATABASE_URL is unset. The desktop runtime always pins this
    // per spawn (preview-manager resolveApiServerEnv / runPrismaIfNeeded),
    // but the eval agent routinely runs `prisma db push` / `prisma generate`
    // straight from its exec shell, which inherits the gateway's process.env
    // (pty-session buildEnv) — so without seeding it here every direct push
    // fails and the app never reaches the DB. Pin the same workspace sqlite
    // file the runtime uses (/workspace is the in-VM project root). Listed
    // before envOverrides so a caller can still override it.
    DATABASE_URL: 'file:/workspace/prisma/dev.db',
    ...config.envOverrides,
  }
  if (process.env.ANTHROPIC_API_KEY && !vmEnv.ANTHROPIC_API_KEY) vmEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
  if (process.env.OPENAI_API_KEY && !vmEnv.OPENAI_API_KEY) vmEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY
  if (process.env.GOOGLE_API_KEY && !vmEnv.GOOGLE_API_KEY) vmEnv.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY
  if (process.env.OPENROUTER_API_KEY && !vmEnv.OPENROUTER_API_KEY) vmEnv.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
  if (process.env.OPENROUTER_BASE_URL && !vmEnv.OPENROUTER_BASE_URL) vmEnv.OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL
  // Forward provider base-URL overrides so custom OpenAI-/Anthropic-compatible
  // endpoints (e.g. Hoshi/MiMo via OPENAI_BASE_URL) are reachable in VM mode —
  // resolveModel('custom') routes through the openai-completions path at
  // OPENAI_BASE_URL, which otherwise defaults to api.openai.com inside the guest.
  if (process.env.OPENAI_BASE_URL && !vmEnv.OPENAI_BASE_URL) vmEnv.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL
  if (process.env.ANTHROPIC_BASE_URL && !vmEnv.ANTHROPIC_BASE_URL) vmEnv.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL

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
    mountWorkspace: config.mount === true,
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
