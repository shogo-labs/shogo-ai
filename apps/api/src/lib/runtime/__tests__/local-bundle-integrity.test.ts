// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Packaging guard for the desktop local-mode API bundle.
 *
 *   bun test apps/api/src/lib/runtime/__tests__/local-bundle-integrity.test.ts
 *
 * The desktop ships `apps/api` as a single `bun build` artifact at
 * `resources/bundle/api.js` (see `apps/desktop/scripts/bundle-api.mjs`); no
 * TypeScript source tree is shipped alongside it.
 *
 * Cloud-only islands are kept out of that bundle with the idiom
 *
 *   if (process.env.SHOGO_LOCAL_MODE !== 'true') {
 *     mod = await import(new URL('./cloud-only.ts', import.meta.url).href)
 *   }
 *
 * `new URL(..., import.meta.url)` is opaque to the bundler, so the module is
 * never inlined. That is *only* safe because the build defines
 * SHOGO_LOCAL_MODE="true", which lets bun dead-code-eliminate the whole branch.
 *
 * If that idiom is used WITHOUT the guard — or on a module the desktop
 * actually needs — the import survives DCE and resolves at runtime against
 * `resources/bundle/`, where no `.ts` file exists. The packaged app throws
 *
 *   Cannot find module '<...>/resources/bundle/<mod>.ts' from '<...>/api.js'
 *
 * which surfaces to the user as a 500 from `/sandbox/url` ("couldn't reach
 * project's runtime"). Source checkouts never reproduce it, because there the
 * `.ts` file really is on disk.
 *
 * This builds the runtime manager the way packaging does and asserts the
 * invariant: zero surviving runtime-relative `.ts` imports.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveTunnelWorkerEntry, startTunnelInWorker } from '@shogo-ai/worker/tunnel-host'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..', '..')
const MANAGER_ENTRY = join(REPO_ROOT, 'apps/api/src/lib/runtime/manager.ts')
/** The entry `bundle-api.mjs` actually ships as `resources/bundle/api.js`. */
const API_ENTRY = join(REPO_ROOT, 'apps/api/src/entry.ts')
/** The tunnel's Worker thread, shipped as `resources/bundle/tunnel-worker.js`. */
const TUNNEL_WORKER_ENTRY = join(REPO_ROOT, 'packages/shogo-worker/src/lib/tunnel-worker.ts')
const BUNDLE_SCRIPT = join(REPO_ROOT, 'apps/desktop/scripts/bundle-api.mjs')

/** Bundler module banners are `// <path>` comments with forward slashes on every platform. */
const inlines = (bundle: string, repoPath: string) => bundle.includes(`// ${repoPath}`)

/** Mirrors EXTERNAL_PACKAGES in apps/desktop/scripts/bundle-api.mjs. */
const EXTERNAL_PACKAGES = [
  'electron',
  'playwright-core',
  '@playwright/mcp',
  '@prisma/client',
  'prisma',
  'prisma-adapter-bun-sqlite',
  'sqlite-vec',
  'typescript-language-server',
  'typescript',
  'pyright',
]

/**
 * Build the runtime manager the way `bundle-api.mjs` builds `api.js`.
 *
 * Shells out to `bun build` rather than calling `Bun.build()` in-process:
 * sibling suites in this directory use `mock.module()`, and a populated mock
 * registry makes in-process bundling fail to read the real files
 * ("Unexpected reading file: .../cloud-sync-watcher.ts"), silently emitting a
 * bundle with modules missing. A subprocess is isolated from that registry,
 * and it is also exactly what packaging does.
 */
function buildLocalModeBundle(outDir: string, entry = MANAGER_ENTRY): string {
  const externals = EXTERNAL_PACKAGES.flatMap((pkg) => ['--external', pkg])
  const proc = Bun.spawnSync({
    cmd: [
      'bun',
      'build',
      entry,
      '--target',
      'bun',
      '--outdir',
      outDir,
      '--define',
      'process.env.SHOGO_LOCAL_MODE="true"',
      ...externals,
    ],
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (proc.exitCode !== 0) {
    throw new Error(
      `bun build failed (exit ${proc.exitCode}):\n${proc.stderr.toString()}`
    )
  }
  return readFileSync(join(outDir, `${basename(entry, '.ts')}.js`), 'utf-8')
}

/**
 * Executable `new URL("./x.ts", import.meta.url)` specifiers left in the
 * emitted bundle. Bundler module banners (`// path/to/x.ts`) are comments and
 * deliberately excluded — those mean the module WAS inlined, which is good.
 */
function survivingRuntimeTsImports(bundle: string): string[] {
  const matches = bundle.matchAll(
    /new URL\(\s*["'](\.{1,2}\/[A-Za-z0-9._/-]*\.ts)["']\s*,\s*import\.meta\.url\s*\)/g
  )
  return [...new Set([...matches].map((m) => m[1]))].sort()
}

describe('desktop local-mode bundle integrity', () => {
  let outDir: string
  let bundle: string

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), 'shogo-bundle-integrity-'))
    bundle = buildLocalModeBundle(outDir)
  })

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true })
  })

  test('no runtime-relative .ts import survives dead-code elimination', () => {
    const surviving = survivingRuntimeTsImports(bundle)

    expect(
      surviving,
      surviving.length
        ? `These modules are imported via new URL(..., import.meta.url) but are ` +
          `NOT dead-code-eliminated in local mode, so they will not exist in ` +
          `resources/bundle/ at runtime: ${surviving.join(', ')}. Either import ` +
          `them with a static specifier (import('./x')) so the bundler inlines ` +
          `them, or gate them behind process.env.SHOGO_LOCAL_MODE !== 'true'.`
        : undefined
    ).toEqual([])
  })

  test('cloud-content-sync is inlined into the local bundle', () => {
    // Positive control: the desktop calls into cloud-content-sync on the
    // project-open path (isProjectCloudLinked / syncCloudProjectIntoDir /
    // isCloudSyncActive), so its implementation must actually ship.
    // Compare booleans, not the 2 MB bundle, so failures stay readable.
    const inlined = bundle.includes('apps/api/src/lib/runtime/cloud-content-sync.ts')
    const unresolvable = bundle.includes('new URL("./cloud-content-sync.ts"')

    expect(
      { inlined, unresolvable },
      'cloud-content-sync must be inlined into the desktop bundle, not ' +
        'imported at runtime from resources/bundle/cloud-content-sync.ts'
    ).toEqual({ inlined: true, unresolvable: false })
  })
})

describe('desktop API bundle (apps/api/src/entry.ts) integrity', () => {
  let outDir: string
  let bundle: string

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), 'shogo-api-bundle-integrity-'))
    bundle = buildLocalModeBundle(outDir, API_ENTRY)
  })

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true })
  })

  test('no runtime-relative .ts import survives anywhere in the shipped API', () => {
    // Reachable ones fail at runtime on desktop, e.g. every
    // `/chat/status` request imported `../lib/metal-eligibility.ts`.
    expect(survivingRuntimeTsImports(bundle)).toEqual([])
  })

  test('desktop resolves agent models with the real resolver, not a divergent shim', () => {
    expect({
      resolver: inlines(bundle, 'apps/api/src/lib/runtime/agent-model-defaults.ts'),
      shim: inlines(bundle, 'apps/api/src/lib/runtime/agent-model-defaults-runtime.ts'),
    }).toEqual({ resolver: true, shim: false })
  })

  test('local-reachable features ship; cloud-only islands stay out', () => {
    expect({
      // `/api/chat` resolves named project agents on desktop too.
      projectAgentService: inlines(bundle, 'apps/api/src/services/projectAgent.service.ts'),
      // Warm pools, the GitHub App client and Redis-backed billing sessions are cloud-only.
      warmPoolController: inlines(bundle, 'apps/api/src/lib/warm-pool-controller.ts'),
      githubService: inlines(bundle, 'apps/api/src/services/github.service.ts'),
      proxyBillingSession: inlines(bundle, 'apps/api/src/lib/proxy-billing-session.ts'),
      ioredis: bundle.includes('node_modules/ioredis/') || bundle.includes('node_modules/.bun/ioredis@'),
    }).toEqual({
      projectAgentService: true,
      warmPoolController: false,
      githubService: false,
      proxyBillingSession: false,
      ioredis: false,
    })
  })
})

/**
 * The tunnel runs on its own Worker thread (SHO-185 §5), and the packaged API
 * reaches that worker by *path*. This is the guard for that path: the entry is
 * declared in the packaging script, it builds, and a host pointed at the built
 * file really comes up.
 *
 * It has to be spelled out because `new URL('./tunnel-worker.ts', import.meta.url)`
 * looks fine in a checkout and is dead in `resources/bundle/` — no source tree
 * ships, so the desktop asked for a `.ts` that was never there, never got a
 * `ready`, and the tunnel never existed. A green build says nothing about that.
 */
describe('desktop tunnel worker entry', () => {
  let outDir: string
  let builtEntry: string
  /** A directory shaped like `resources/bundle/`. */
  let packagedDir: string
  let packagedEntry: string

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), 'shogo-tunnel-worker-'))
    // Exactly the command `bundle-api.mjs` runs for this entry.
    const externals = EXTERNAL_PACKAGES.flatMap((pkg) => ['--external', pkg])
    const proc = Bun.spawnSync({
      cmd: ['bun', 'build', TUNNEL_WORKER_ENTRY, '--target', 'bun', '--outdir', outDir, ...externals],
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (proc.exitCode !== 0) {
      throw new Error(`bun build failed (exit ${proc.exitCode}):\n${proc.stderr.toString()}`)
    }
    builtEntry = join(outDir, 'tunnel-worker.js')

    // The same thing for the host, so its `import.meta.dir` is a bundle
    // directory rather than `src/lib` — which is how `api.js` sees the world.
    packagedDir = mkdtempSync(join(tmpdir(), 'shogo-bundle-shape-'))
    const hostBuild = Bun.spawnSync({
      cmd: [
        'bun',
        'build',
        join(REPO_ROOT, 'packages/shogo-worker/src/lib/tunnel-host.ts'),
        '--target',
        'bun',
        '--outdir',
        packagedDir,
        ...externals,
      ],
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (hostBuild.exitCode !== 0) {
      throw new Error(`host build failed (exit ${hostBuild.exitCode}):\n${hostBuild.stderr.toString()}`)
    }
    packagedEntry = join(packagedDir, 'tunnel-host.js')
  })

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true })
    rmSync(packagedDir, { recursive: true, force: true })
  })

  test('packaging ships the worker entry beside the API bundle', () => {
    const script = readFileSync(BUNDLE_SCRIPT, 'utf-8')
    expect(
      {
        declared: script.includes('packages/shogo-worker/src/lib/tunnel-worker.ts'),
        // `api.js` looks for a sibling, so the output must land in bundle/.
        output: /output:\s*'tunnel-worker\.js'/.test(script),
      },
      'bundle-api.mjs must build the tunnel worker into bundle/tunnel-worker.js — ' +
        'without it the packaged API has no tunnel at all',
    ).toEqual({ declared: true, output: true })
  })

  test('the built entry is a real, self-contained worker file', () => {
    expect(existsSync(builtEntry)).toBe(true)
    expect(statSync(builtEntry).size).toBeGreaterThan(1_000)
    // Nothing left to resolve at runtime: a surviving `.ts` import would make
    // the worker fail to load exactly like the bug this fixes.
    expect(survivingRuntimeTsImports(readFileSync(builtEntry, 'utf-8'))).toEqual([])
  })

  test('the packaged shape — compiled host, compiled worker, no sources — comes up', async () => {
    // `resources/bundle/`: api.js and tunnel-worker.js, nothing else. The host is
    // bundled on its own so `import.meta.dir` is that directory, which is what
    // `api.js` gets; nothing here is a `.ts` and there is no source tree above it.
    copyFileSync(builtEntry, join(packagedDir, 'tunnel-worker.js'))
    const previous = process.env.SHOGO_TUNNEL_WORKER_PATH
    delete process.env.SHOGO_TUNNEL_WORKER_PATH
    let host: { stop(): void; ready(): Promise<void> } | null = null
    try {
      const packaged = (await import(`${pathToFileURL(packagedEntry).href}?t=${Date.now()}`)) as any
      // The sibling the packaging step ships, not the checkout's `.ts`. Compared
      // by file name: macOS reports `/var/…` and `/private/var/…` for one path.
      const resolved = packaged.resolveTunnelWorkerEntry()
      expect({ file: basename(resolved), exists: existsSync(resolved) }).toEqual({
        file: 'tunnel-worker.js',
        exists: true,
      })

      host = packaged.startTunnelInWorker({
        apiKey: 'test-key',
        cloudUrl: 'http://127.0.0.1:1',
        name: 'packaged-shape',
        kind: 'desktop',
        resolver: {
          async resolveLocalUrl() {
            return null
          },
          async deriveRuntimeToken() {
            return null
          },
          getActiveProjects() {
            return []
          },
          status() {
            return null
          },
        },
        logger: { log: () => {}, warn: () => {}, error: () => {} },
        readyTimeoutMs: 8_000,
      })
      await host.ready()
    } finally {
      host?.stop()
      if (previous !== undefined) process.env.SHOGO_TUNNEL_WORKER_PATH = previous
    }
  }, 20_000)

  test('a host pointed at the built worker comes up — no source tree needed', async () => {
    const previous = process.env.SHOGO_TUNNEL_WORKER_PATH
    process.env.SHOGO_TUNNEL_WORKER_PATH = builtEntry
    let host: ReturnType<typeof startTunnelInWorker> | null = null
    try {
      expect(resolveTunnelWorkerEntry()).toBe(builtEntry)
      host = startTunnelInWorker({
        apiKey: 'test-key',
        // Unreachable on purpose: `ready` is posted before the first connect, so
        // startup must not depend on there being a cloud to talk to.
        cloudUrl: 'http://127.0.0.1:1',
        name: 'bundle-integrity',
        kind: 'desktop',
        resolver: {
          async resolveLocalUrl() {
            return null
          },
          async deriveRuntimeToken() {
            return null
          },
          getActiveProjects() {
            return []
          },
          status() {
            return null
          },
        },
        logger: { log: () => {}, warn: () => {}, error: () => {} },
        readyTimeoutMs: 8_000,
      })
      await host.ready()
    } finally {
      host?.stop()
      if (previous === undefined) delete process.env.SHOGO_TUNNEL_WORKER_PATH
      else process.env.SHOGO_TUNNEL_WORKER_PATH = previous
    }
  }, 20_000)

  test('a worker that is not there fails fast, so the caller can go in-process', async () => {
    // In a checkout the ts source beside this module is what resolves.
    expect(resolveTunnelWorkerEntry({ SHOGO_TUNNEL_WORKER_PATH: '' } as NodeJS.ProcessEnv)).toEndWith(
      'tunnel-worker.ts',
    )

    const previous = process.env.SHOGO_TUNNEL_WORKER_PATH
    process.env.SHOGO_TUNNEL_WORKER_PATH = join(outDir, 'gone.js')
    let host: ReturnType<typeof startTunnelInWorker> | null = null
    let failure: unknown = null
    try {
      host = startTunnelInWorker({
        apiKey: 'test-key',
        cloudUrl: 'http://127.0.0.1:1',
        name: 'bundle-integrity-missing',
        kind: 'desktop',
        resolver: {
          async resolveLocalUrl() {
            return null
          },
          async deriveRuntimeToken() {
            return null
          },
          getActiveProjects() {
            return []
          },
          status() {
            return null
          },
        },
        logger: { log: () => {}, warn: () => {}, error: () => {} },
        // Short, because some runtimes accept a path that does not exist and
        // only fail later — that must not become a 10s hole in startup.
        readyTimeoutMs: 1_000,
      })
      await host.ready()
    } catch (error) {
      failure = error
    } finally {
      host?.stop()
      if (previous === undefined) delete process.env.SHOGO_TUNNEL_WORKER_PATH
      else process.env.SHOGO_TUNNEL_WORKER_PATH = previous
    }

    // Either shape reaches `demoteToInProcess`: a synchronous throw, or a
    // rejection from `ready()`. What is not allowed is resolving.
    expect(failure).toBeInstanceOf(Error)
  }, 20_000)
})
