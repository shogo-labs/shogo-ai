// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
// Phase 3a: PreviewManager lifecycle/getter/health coverage. Covers
// stop()/restart()/getStatus()/phase/isApiHealthy/isRunning/apiServerPort/
// resolveDevServer + schema-watcher + customRoutes-watcher + console-log
// reset paths. Stays away from start() — that's Phase 3b.
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PreviewManager, reapStaleViteWatchers } from '../preview-manager'
import { previewConsoleLogPath, previewBuildLogPath } from '../runtime-log-paths'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pm-lc-'))
  delete process.env.PUBLIC_URL
  delete process.env.SHOGO_LOCAL_MODE
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function mk(over: Partial<ConstructorParameters<typeof PreviewManager>[0]> = {}) {
  return new PreviewManager({
    workspaceDir: dir,
    runtimePort: 38306,
    publicUrl: 'https://preview.example/abc',
    localMode: false,
    ...over,
  })
}

// --- Getter sanity --------------------------------------------------------

describe('PreviewManager — read-only getters', () => {
  it('phase starts at "idle"', () => {
    expect(mk().phase).toBe('idle')
  })

  it('isStarted is false before start()', () => {
    expect(mk().isStarted).toBe(false)
  })

  it('isRunning is false when no buildWatch process has been spawned', () => {
    expect(mk().isRunning).toBe(false)
  })

  it('apiServerPort is null when the API process has not been started', () => {
    expect(mk().apiServerPort).toBeNull()
  })

  it('apiServerPhase starts at "idle"', () => {
    expect(mk().apiServerPhase).toBe('idle')
  })

  it('apiLastGenerateError starts null', () => {
    expect(mk().apiLastGenerateError).toBeNull()
  })

  it('apiServerUrl always reports the resolved API port', () => {
    expect(mk().apiServerUrl).toMatch(/^http:\/\/localhost:\d+$/)
  })

  it('internalUrl uses runtimePort', () => {
    const m = mk({ runtimePort: 45000 })
    expect(m.internalUrl).toBe('http://localhost:45000/')
  })

  it('externalUrl prefers publicUrl when set', () => {
    expect(mk({ publicUrl: 'https://x.example' }).externalUrl).toBe('https://x.example')
  })

  it('externalUrl falls back to internalUrl when publicUrl is empty', () => {
    const m = mk({ publicUrl: '' })
    expect(m.externalUrl).toBe(m.internalUrl)
  })

  it('externalUrl falls back to internalUrl when publicUrl is undefined', () => {
    const m = mk({ publicUrl: undefined })
    expect(m.externalUrl).toBe(m.internalUrl)
  })

  it('isLocalMode reflects the config flag', () => {
    expect(mk({ localMode: true }).isLocalMode).toBe(true)
    expect(mk({ localMode: false }).isLocalMode).toBe(false)
  })

  it('metroDeviceUrl is null before metro starts', () => {
    expect(mk().metroDeviceUrl).toBeNull()
  })

  it('depsReady is a Promise that has NOT settled before start()', () => {
    const m = mk()
    expect(m.depsReady).toBeInstanceOf(Promise)
    expect(m.depsSettled).toBe(false)
  })

  it('bundlerCwd falls back to legacy <ws>/project/ when no package.json exists', () => {
    const m = mk()
    expect(m.bundlerCwd).toBe(join(dir, 'project'))
  })

  it('bundlerCwd returns workspace root when only root package.json exists (Expo layout)', () => {
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}')
    expect(mk().bundlerCwd).toBe(dir)
  })

  it('bundlerCwd prefers legacy <ws>/project/ when both layouts exist', () => {
    mkdirSync(join(dir, 'project'), { recursive: true })
    writeFileSync(join(dir, 'project/package.json'), '{"name":"a"}')
    writeFileSync(join(dir, 'package.json'), '{"name":"b"}')
    expect(mk().bundlerCwd).toBe(join(dir, 'project'))
  })
})

// --- resolveDevServer (via getStatus().devServer) -------------------------

describe('PreviewManager.resolveDevServer (via getStatus)', () => {
  it('defaults to "vite" when no .tech-stack marker exists', () => {
    expect(mk().getStatus().devServer).toBe('vite')
  })

  it('defaults to "vite" when .tech-stack is empty', () => {
    writeFileSync(join(dir, '.tech-stack'), '   \n')
    expect(mk().getStatus().devServer).toBe('vite')
  })

  it('defaults to "vite" when stack id is unknown', () => {
    writeFileSync(join(dir, '.tech-stack'), 'totally-made-up-stack')
    expect(mk().getStatus().devServer).toBe('vite')
  })
})

// --- isApiHealthy ---------------------------------------------------------

describe('PreviewManager.isApiHealthy', () => {
  // isApiHealthy short-circuits with `false` when apiServerPort is null
  // (no running process). To exercise the fetch branch we splice in a
  // fake "running" apiServerProcess.
  const withProc = (m: PreviewManager) => {
    ;(m as any).apiServerProcess = { killed: false, kill: () => {} }
    return m
  }

  it('returns false fast when no API process has been started', async () => {
    expect(await mk().isApiHealthy()).toBe(false)
  })

  it('returns true on a 200', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    )
    try {
      expect(await withProc(mk()).isApiHealthy()).toBe(true)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('returns false on a non-2xx', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('nope', { status: 503 }),
    )
    try {
      expect(await withProc(mk()).isApiHealthy()).toBe(false)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('returns false when fetch throws', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection refused'))
    try {
      expect(await withProc(mk()).isApiHealthy()).toBe(false)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('passes an AbortSignal to fetch (timeout is wired)', async () => {
    let observedInit: RequestInit | undefined
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((_url: any, init?: RequestInit) => {
      observedInit = init
      return Promise.resolve(new Response('ok', { status: 200 }))
    })
    try {
      await withProc(mk()).isApiHealthy()
      expect(observedInit?.signal).toBeInstanceOf(AbortSignal)
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

// --- stop() ---------------------------------------------------------------

describe('PreviewManager.stop', () => {
  it('is safe to call before start() (no procs to kill)', () => {
    const m = mk()
    expect(() => m.stop()).not.toThrow()
    expect(m.phase).toBe('idle')
    expect(m.apiServerPhase).toBe('stopped')
    expect(m.isStarted).toBe(false)
  })

  it('clears the schemaTimer if one is pending', () => {
    const m = mk() as any
    let cleared = 0
    m.schemaTimer = setTimeout(() => {}, 5_000)
    const origClear = globalThis.clearTimeout
    globalThis.clearTimeout = ((t: any) => { cleared++; return origClear(t) }) as any
    try {
      m.stop()
    } finally {
      globalThis.clearTimeout = origClear
    }
    expect(cleared).toBeGreaterThanOrEqual(1)
    expect(m.schemaTimer).toBeNull()
  })

  it('kills any wired child processes and nulls their slots', () => {
    const m = mk() as any
    const kills: string[] = []
    const fakeProc = (label: string) => ({
      kill: (sig: string) => { kills.push(`${label}:${sig}`); return true },
      killed: false,
    })
    m.apiServerProcess = fakeProc('api')
    m.buildWatchProcess = fakeProc('build')
    m.metroProcess = fakeProc('metro')
    m.metroUrl = 'exp://x.exp.direct'

    const log = console.log
    console.log = () => {}
    try {
      m.stop()
    } finally {
      console.log = log
    }
    expect(kills.sort()).toEqual([
      'api:SIGTERM', 'build:SIGTERM', 'metro:SIGTERM',
    ])
    expect(m.apiServerProcess).toBeNull()
    expect(m.buildWatchProcess).toBeNull()
    expect(m.metroProcess).toBeNull()
    expect(m.metroUrl).toBeNull()
    expect(m.phase).toBe('idle')
    expect(m.apiServerPhase).toBe('stopped')
  })

  it('clears a pending crashRestartTimer', () => {
    const m = mk() as any
    m.crashRestartTimer = setTimeout(() => {}, 60_000)
    m.stop()
    expect(m.crashRestartTimer).toBeNull()
  })
})

// --- restart() ------------------------------------------------------------

describe('PreviewManager.restart', () => {
  it('calls stop() then start() exactly once each', async () => {
    const m = mk() as any
    let stopCalls = 0
    let startCalls = 0
    m.stop = function () { stopCalls++ }
    m.start = async function () {
      startCalls++
      return { mode: 'none', port: null, timings: {} }
    }
    const r = await m.restart()
    expect(stopCalls).toBe(1)
    expect(startCalls).toBe(1)
    expect(r).toEqual({ mode: 'none', port: null, timings: {} })
  })
})

// --- getStatus() ----------------------------------------------------------

describe('PreviewManager.getStatus', () => {
  it('reports running=false / port=null / urls=null before start', () => {
    const s = mk().getStatus()
    expect(s.running).toBe(false)
    expect(s.port).toBeNull()
    expect(s.url).toBeNull()
    expect(s.internalUrl).toBeNull()
    expect(s.publicUrl).toBeNull()
    expect(s.metroUrl).toBeNull()
  })

  it('exposes workspaceDir + bundlerCwd + devServer', () => {
    const s = mk().getStatus()
    expect(s.workspaceDir).toBe(dir)
    expect(s.bundlerCwd).toBe(join(dir, 'project'))
    expect(s.devServer).toBe('vite')
  })

  it('errors.install/generate start null', () => {
    const s = mk().getStatus()
    expect(s.errors.install).toBeNull()
    expect(s.errors.generate).toBeNull()
  })

  it('reflects lastGenerateError when the regenerate pipeline has failed', () => {
    const m = mk() as any
    m.lastGenerateError = 'prisma broke'
    const s = m.getStatus()
    expect(s.errors.generate).toBe('prisma broke')
  })

  it('reports running URLs only when phase=ready AND started=true', () => {
    const m = mk({ publicUrl: 'https://x.example' }) as any
    m.started = true
    m._phase = 'ready'
    const s = m.getStatus()
    expect(s.running).toBe(true)
    expect(s.port).toBe(38306)
    expect(s.url).toBe('https://x.example')
    expect(s.internalUrl).toBe('http://localhost:38306/')
    expect(s.publicUrl).toBe('https://x.example')
  })

  it('reports running=false when started but phase is not "ready"', () => {
    const m = mk() as any
    m.started = true
    m._phase = 'installing'
    const s = m.getStatus()
    expect(s.running).toBe(false)
    expect(s.url).toBeNull()
  })
})

// --- Schema watcher start/stop -------------------------------------------

describe('PreviewManager schema watcher', () => {
  it('startSchemaWatcher creates the prisma dir and attaches a watcher when missing', () => {
    const m = mk() as any
    expect(() => m.startSchemaWatcher()).not.toThrow()
    // The watcher created the prisma/ dir under bundlerCwd (legacy `<ws>/project/`)
    expect(m.schemaWatcher).not.toBeNull()
    m.stopSchemaWatcher()
  })

  it('stopSchemaWatcher is idempotent when no watcher is active', () => {
    const m = mk() as any
    expect(() => m.stopSchemaWatcher()).not.toThrow()
    expect(() => m.stopSchemaWatcher()).not.toThrow()
  })

  it('startSchemaWatcher attaches an FSWatcher when prisma/schema.prisma exists', () => {
    mkdirSync(join(dir, 'prisma'), { recursive: true })
    writeFileSync(join(dir, 'prisma/schema.prisma'), 'datasource db {}')
    const m = mk() as any
    try {
      m.startSchemaWatcher()
      expect(m.schemaWatcher).not.toBeNull()
    } finally {
      m.stopSchemaWatcher()
    }
    expect(m.schemaWatcher).toBeNull()
  })

  it('startSchemaWatcher also picks up the .shogo/server/schema.prisma legacy path', () => {
    mkdirSync(join(dir, '.shogo/server'), { recursive: true })
    writeFileSync(join(dir, '.shogo/server/schema.prisma'), 'datasource db {}')
    const m = mk() as any
    try {
      m.startSchemaWatcher()
      // either schemaWatcher OR projectSchemaWatcher should be set
      const any = m.schemaWatcher || m.projectSchemaWatcher
      expect(any).not.toBeNull()
    } finally {
      m.stopSchemaWatcher()
    }
  })

  // --- Content-hash guard against spurious wakes -------------------------
  //
  // On Windows `fs.watch(prismaDir)` fires on attribute-change
  // notifications too (e.g. another process opening `schema.prisma` for
  // read), so the watcher must compare the file's actual content
  // against the last-acted-on hash before triggering a regenerate.
  // Without the guard, each chat turn re-armed the full kill-server →
  // `bun run generate` → restart cycle and re-armed itself because the
  // generator subprocess re-opens the file.

  it('computeSchemaHash returns null when schema.prisma is missing', () => {
    const m = mk() as any
    expect(m.computeSchemaHash()).toBeNull()
  })

  it('computeSchemaHash is stable for identical content and changes when content does', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p' }))
    mkdirSync(join(dir, 'prisma'), { recursive: true })
    const schemaPath = join(dir, 'prisma', 'schema.prisma')
    writeFileSync(schemaPath, 'datasource db { provider = "sqlite" }\nmodel A { id String @id }\n')
    const m = mk() as any
    const h1 = m.computeSchemaHash()
    expect(h1).not.toBeNull()
    // Re-write the exact same bytes — hash MUST match (this is the
    // invariant the watcher's guard relies on).
    writeFileSync(schemaPath, 'datasource db { provider = "sqlite" }\nmodel A { id String @id }\n')
    expect(m.computeSchemaHash()).toBe(h1)
    // Change the content — hash MUST move.
    writeFileSync(schemaPath, 'datasource db { provider = "sqlite" }\nmodel A { id String @id }\nmodel B { id String @id }\n')
    expect(m.computeSchemaHash()).not.toBe(h1)
  })

  it('startSchemaWatcher seeds lastSchemaHash from the on-disk schema', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p' }))
    mkdirSync(join(dir, 'prisma'), { recursive: true })
    const schemaPath = join(dir, 'prisma', 'schema.prisma')
    writeFileSync(schemaPath, 'datasource db { provider = "sqlite" }\nmodel A { id String @id }\n')
    const m = mk() as any
    try {
      m.startSchemaWatcher()
      // Must equal whatever computeSchemaHash returns right now — that's
      // the baseline the watcher callback compares against.
      expect(m.lastSchemaHash).toBe(m.computeSchemaHash())
    } finally {
      m.stopSchemaWatcher()
    }
  })

  it('rewriting identical schema.prisma bytes does NOT trigger handleSchemaChange; changing them does', async () => {
    // Workspace package.json so resolveBundlerCwd() === workspaceDir,
    // which keeps the watched path and the test write path in lock-step.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p' }))
    mkdirSync(join(dir, 'prisma'), { recursive: true })
    const schemaPath = join(dir, 'prisma', 'schema.prisma')
    const original = 'datasource db { provider = "sqlite" }\nmodel A { id String @id }\n'
    writeFileSync(schemaPath, original)

    const m = mk() as any
    // Stub the heavy regen path — we only care whether the watcher
    // calls into it. mockImplementation lets the spy track invocations
    // without triggering child-process spawns.
    const handleSpy = spyOn(m, 'handleSchemaChange').mockImplementation(async () => {})

    // Local mirror of the source-side `SCHEMA_DEBOUNCE_MS = 1500`. Kept
    // inline rather than re-exported because the constant is internal
    // to the preview-manager and exposing it would widen the public
    // surface only for this test.
    const SCHEMA_DEBOUNCE_MS = 1500

    try {
      m.startSchemaWatcher()
      expect(m.schemaWatcher).not.toBeNull()
      const baseline = m.lastSchemaHash
      expect(baseline).not.toBeNull()

      // Touch the file with identical bytes. fs.watch fires (mtime
      // moves), but the hash compare must short-circuit before
      // handleSchemaChange runs.
      writeFileSync(schemaPath, original)
      await new Promise((r) => setTimeout(r, SCHEMA_DEBOUNCE_MS + 400))
      expect(handleSpy).not.toHaveBeenCalled()
      // Baseline must still match the on-disk content.
      expect(m.lastSchemaHash).toBe(baseline)

      // Real edit — hash diverges, watcher must dispatch.
      writeFileSync(schemaPath, original + 'model B { id String @id }\n')
      await new Promise((r) => setTimeout(r, SCHEMA_DEBOUNCE_MS + 400))
      expect(handleSpy).toHaveBeenCalled()
    } finally {
      handleSpy.mockRestore()
      m.stopSchemaWatcher()
    }
  }, 10_000)
})

// --- Custom-routes watcher -----------------------------------------------

describe('PreviewManager custom-routes watcher', () => {
  it('startCustomRoutesWatcher is a no-op when custom-routes.ts is missing', () => {
    const m = mk() as any
    expect(() => m.startCustomRoutesWatcher()).not.toThrow()
    expect(m.customRoutesWatcher).toBeNull()
  })

  it('attaches an FSWatcher to bundlerCwd when it exists', () => {
    // bundlerCwd is `<dir>/project/` (legacy layout) by default. We create
    // the dir so the watcher can attach. The watcher fires on filename
    // matches inside the dir; we only assert the attach succeeded.
    mkdirSync(join(dir, 'project'), { recursive: true })
    writeFileSync(join(dir, 'project/custom-routes.ts'), 'export default {}')
    const m = mk() as any
    try {
      m.startCustomRoutesWatcher()
      expect(m.customRoutesWatcher).not.toBeNull()
    } finally {
      m.stopCustomRoutesWatcher()
    }
    expect(m.customRoutesWatcher).toBeNull()
  })

  it('is idempotent — second startCustomRoutesWatcher call is a no-op', () => {
    mkdirSync(join(dir, 'project'), { recursive: true })
    const m = mk() as any
    m.startCustomRoutesWatcher()
    const first = m.customRoutesWatcher
    m.startCustomRoutesWatcher()
    expect(m.customRoutesWatcher).toBe(first)
    m.stopCustomRoutesWatcher()
  })

  it('stopCustomRoutesWatcher clears any pending debounce timer', () => {
    const m = mk() as any
    m.customRoutesTimer = setTimeout(() => {}, 60_000)
    m.stopCustomRoutesWatcher()
    expect(m.customRoutesTimer).toBeNull()
  })
})

// --- clearRuntimeConsoleLog ----------------------------------------------

describe('PreviewManager.clearRuntimeConsoleLog', () => {
  it('truncates an existing console.log to empty', () => {
    // clearRuntimeConsoleLog now writes under <workspace>/.shogo/logs/ —
    // bundlerCwd is irrelevant. ensureRuntimeLogDir runs inside the
    // helper, so a fresh workspace dir works without explicit mkdir.
    const logPath = previewConsoleLogPath(dir)
    const m = mk() as any
    // Pre-seed the file at the new canonical location.
    m.clearRuntimeConsoleLog() // creates the dir + empties the file
    writeFileSync(logPath, 'old content here\n')
    m.clearRuntimeConsoleLog()
    expect(readFileSync(logPath, 'utf-8')).toBe('')
  })

  it('also calls the optional onConsoleLogReset listener', () => {
    let calls = 0
    const m = mk({ onConsoleLogReset: () => { calls++ } }) as any
    m.clearRuntimeConsoleLog()
    expect(calls).toBe(1)
  })

  it('creates the .shogo/logs/ directory on first call (no ENOENT)', () => {
    // Fresh workspace with no .shogo/ — clearRuntimeConsoleLog must
    // mkdir -p before writing; otherwise the first preview start
    // would throw and we'd lose every log line until the next manual
    // mkdir.
    const m = mk() as any
    expect(() => m.clearRuntimeConsoleLog()).not.toThrow()
    expect(existsSync(previewConsoleLogPath(dir))).toBe(true)
  })

  it('still truncates the file even if the listener is undefined', () => {
    const logPath = previewConsoleLogPath(dir)
    const m = mk() as any
    m.clearRuntimeConsoleLog()
    writeFileSync(logPath, 'before')
    // No onConsoleLogReset wired
    m.clearRuntimeConsoleLog()
    expect(readFileSync(logPath, 'utf-8')).toBe('')
  })
})

// --- cleanupLegacyRuntimeLogs --------------------------------------------
//
// One-shot orphan cleanup run from `start()`. Pre-2026-05 runtimes wrote
// `.build.log` / `.console.log` next to `index.html` at the workspace
// root (or in `<workspace>/project/` for legacy Vite layouts). Leaving
// them there re-arms the Windows chokidar rebuild-loop the move to
// `.shogo/logs/` was meant to defeat — so every `start()` deletes them.

describe('PreviewManager.cleanupLegacyRuntimeLogs', () => {
  it('removes legacy <workspace>/.build.log and .console.log', () => {
    writeFileSync(join(dir, '.build.log'), 'stale\n')
    writeFileSync(join(dir, '.console.log'), 'stale\n')
    const m = mk() as any
    m.cleanupLegacyRuntimeLogs()
    expect(existsSync(join(dir, '.build.log'))).toBe(false)
    expect(existsSync(join(dir, '.console.log'))).toBe(false)
  })

  it('removes legacy <workspace>/project/.build.log and .console.log (Vite layout)', () => {
    const bundler = join(dir, 'project')
    mkdirSync(bundler, { recursive: true })
    writeFileSync(join(bundler, 'package.json'), '{}')
    writeFileSync(join(bundler, '.build.log'), 'stale\n')
    writeFileSync(join(bundler, '.console.log'), 'stale\n')
    const m = mk() as any
    m.cleanupLegacyRuntimeLogs()
    expect(existsSync(join(bundler, '.build.log'))).toBe(false)
    expect(existsSync(join(bundler, '.console.log'))).toBe(false)
  })

  it('does NOT touch the new canonical files under .shogo/logs/', () => {
    const newBuild = previewBuildLogPath(dir)
    const newConsole = previewConsoleLogPath(dir)
    mkdirSync(join(dir, '.shogo', 'logs'), { recursive: true })
    writeFileSync(newBuild, 'fresh\n')
    writeFileSync(newConsole, 'fresh\n')
    const m = mk() as any
    m.cleanupLegacyRuntimeLogs()
    expect(readFileSync(newBuild, 'utf-8')).toBe('fresh\n')
    expect(readFileSync(newConsole, 'utf-8')).toBe('fresh\n')
  })

  it('is a no-op (no throw) when nothing legacy exists', () => {
    const m = mk() as any
    expect(() => m.cleanupLegacyRuntimeLogs()).not.toThrow()
  })
})

// --- _markDepsSettled ----------------------------------------------------

describe('PreviewManager._markDepsSettled', () => {
  it('resolves depsReady on first call and is idempotent on subsequent calls', async () => {
    const m = mk() as any
    expect(m.depsSettled).toBe(false)
    m._markDepsSettled()
    expect(m.depsSettled).toBe(true)
    await m.depsReady
    // Second call is a no-op
    m._markDepsSettled()
    expect(m.depsSettled).toBe(true)
  })
})

// --- reapStaleViteWatchers ------------------------------------------------
//
// Reaper for orphaned `vite build --watch` processes that prior
// agent-runtime incarnations stranded with PPID=1. See the function
// docstring for the leak path this defends against (macOS jetsam,
// hot-reload, 5s waitForExit vs 30s graceful drain).
//
// We exercise the function in isolation (not via startBuildWatch) so
// we don't need to mock vite-bin discovery, the spawn invocation, or
// the build-log writer. Every test injects a fixture `listProcesses`
// and records `killGroup` calls — the production paths
// (`ps -A`/`Get-CimInstance`, `process.kill(-pgid, …)`/`taskkill`)
// stay covered by their respective platforms in CI integration.

describe('reapStaleViteWatchers', () => {
  /**
   * Build a POSIX `ps` line matching the production argv shape:
   *   <bun-binary> <workspace>/node_modules/vite/bin/vite.js build --watch --emptyOutDir false
   * Each line is rendered as `<pid> <pgid> <command>` to mirror
   * `ps -A -o pid=,pgid=,command=`.
   *
   * The vite-bin path is built with `path.join` so the fixture's
   * separators agree with the source's `viteBinFragment` (also built
   * via `path.join`) on whichever host is running the test. Without
   * this, Windows test runs feed forward-slash fixtures into a parser
   * that's looking for backslash substrings → 0 matches → false reds.
   */
  function psLine(pid: number, pgid: number, workspace: string, extraArgs = '--emptyOutDir false') {
    const bun = '/Applications/Shogo.app/Contents/Resources/bun/bun'
    const viteBin = join(workspace, 'node_modules', 'vite', 'bin', 'vite.js')
    return `${pid} ${pgid} ${bun} ${viteBin} build --watch ${extraArgs}`
  }

  it('returns empty + does not kill anything when ps output is empty', () => {
    const killed: Array<[number, NodeJS.Signals]> = []
    const out = reapStaleViteWatchers('/ws/x', {
      listProcesses: () => '',
      killGroup: (pgid, sig) => killed.push([pgid, sig]),
      platform: 'darwin',
      selfPid: 99999,
      logger: { log: () => {}, warn: () => {} },
    })
    expect(out).toEqual([])
    expect(killed).toEqual([])
  })

  it('returns empty + does not kill anything when no rows match the workspace', () => {
    const killed: Array<[number, NodeJS.Signals]> = []
    const lines = [
      '1 1 /sbin/launchd',
      psLine(2000, 2000, '/ws/some-other-project'),
      '3000 3000 /Applications/Shogo.app/Contents/Resources/bun/bun /tmp/a/node_modules/vite/bin/vite.js build --foo',
    ].join('\n')
    const out = reapStaleViteWatchers('/ws/x', {
      listProcesses: () => lines,
      killGroup: (pgid, sig) => killed.push([pgid, sig]),
      platform: 'darwin',
      selfPid: 99999,
      logger: { log: () => {}, warn: () => {} },
    })
    expect(out).toEqual([])
    expect(killed).toEqual([])
  })

  it('matches only watchers whose argv contains BOTH the workspace vite path AND "build --watch"', () => {
    const killed: Array<[number, NodeJS.Signals]> = []
    const ws = '/ws/match-me'
    const lines = [
      // Same workspace, but not build --watch — skip. Use path.join
      // so the workspace fragment matches the OS-native separator the
      // source's `viteBinFragment` also produces.
      `100 100 /bun ${join(ws, 'node_modules', 'vite', 'bin', 'vite.js')} --port 5173`,
      // build --watch, but a different workspace — skip
      psLine(200, 200, '/ws/other'),
      // Match
      psLine(300, 300, ws),
      // Match — different argv but same workspace + watch
      psLine(400, 400, ws, '--mode dev'),
    ].join('\n')
    const out = reapStaleViteWatchers(ws, {
      listProcesses: () => lines,
      killGroup: (pgid, sig) => killed.push([pgid, sig]),
      platform: 'darwin',
      selfPid: 99999,
      logger: { log: () => {}, warn: () => {} },
    })
    expect(out.map((m) => m.pid).sort()).toEqual([300, 400])
    expect(killed.sort()).toEqual([[300, 'SIGTERM'], [400, 'SIGTERM']])
  })

  it('kills the PGID column (not the PID) so rollup workers in the group are reaped too', () => {
    const killed: Array<[number, NodeJS.Signals]> = []
    const ws = '/ws/pgid-check'
    // Vite is spawned `detached: true` so pgid == pid for the
    // group leader. But the production kill path targets the PGID
    // specifically — assert we send the PGID number, not the PID.
    // Use distinct values to make the regression visible if the
    // implementation ever swaps them.
    const viteBin = join(ws, 'node_modules', 'vite', 'bin', 'vite.js')
    const out = reapStaleViteWatchers(ws, {
      listProcesses: () => `${999} ${888} /bun ${viteBin} build --watch`,
      killGroup: (pgid, sig) => killed.push([pgid, sig]),
      platform: 'darwin',
      selfPid: 11111,
      logger: { log: () => {}, warn: () => {} },
    })
    expect(out).toEqual([{ pid: 999, pgid: 888, command: expect.any(String) as unknown as string }])
    expect(killed).toEqual([[888, 'SIGTERM']])
  })

  it('skips the current process even if its argv would otherwise match', () => {
    const killed: Array<[number, NodeJS.Signals]> = []
    const ws = '/ws/self-skip'
    const selfPid = 42424
    const lines = [
      psLine(selfPid, selfPid, ws),
      psLine(100, 100, ws),
    ].join('\n')
    const out = reapStaleViteWatchers(ws, {
      listProcesses: () => lines,
      killGroup: (pgid, sig) => killed.push([pgid, sig]),
      platform: 'darwin',
      selfPid,
      logger: { log: () => {}, warn: () => {} },
    })
    expect(out.map((m) => m.pid)).toEqual([100])
    expect(killed).toEqual([[100, 'SIGTERM']])
  })

  it('handles ps lines with multiple spaces in the command path (e.g. "Application Support") without truncation', () => {
    const killed: Array<[number, NodeJS.Signals]> = []
    const ws = '/Users/x/Library/Application Support/Shogo/data/workspaces/abc-123'
    // The bun argv0 has a space (`Application Support`), AND so does
    // the workspace path. ps emits the command verbatim with embedded
    // spaces preserved; our parser must reconstruct the full command
    // string from column 3 onwards, not split-and-take-only-the-third.
    const cmd = `/Applications/Shogo.app/Contents/Resources/bun/bun ${join(ws, 'node_modules', 'vite', 'bin', 'vite.js')} build --watch --emptyOutDir false`
    const out = reapStaleViteWatchers(ws, {
      listProcesses: () => `12345 12345 ${cmd}\n`,
      killGroup: (pgid, sig) => killed.push([pgid, sig]),
      platform: 'darwin',
      selfPid: 1,
      logger: { log: () => {}, warn: () => {} },
    })
    expect(out).toHaveLength(1)
    expect(out[0].pgid).toBe(12345)
    expect(out[0].command).toContain('Application Support')
    expect(killed).toEqual([[12345, 'SIGTERM']])
  })

  it('returns [] + logs a warning (does not throw) when listProcesses throws', () => {
    const killed: Array<[number, NodeJS.Signals]> = []
    const warns: string[] = []
    const out = reapStaleViteWatchers('/ws/y', {
      listProcesses: () => { throw new Error('ps: command not found') },
      killGroup: (pgid, sig) => killed.push([pgid, sig]),
      platform: 'darwin',
      selfPid: 1,
      logger: { log: () => {}, warn: (m: string) => warns.push(m) },
    })
    expect(out).toEqual([])
    expect(killed).toEqual([])
    expect(warns.some((m) => m.includes('process table scan failed'))).toBe(true)
  })

  it('swallows kill errors so one stale group does not block reaping the rest', () => {
    // Mirrors the ESRCH-after-ps race: the orphan exited between
    // our `ps` snapshot and our kill. The reaper must continue
    // to the next match instead of bubbling the error up to
    // startBuildWatch (which would prevent the new vite spawn).
    const killCalls: number[] = []
    const ws = '/ws/kill-errors'
    const out = reapStaleViteWatchers(ws, {
      listProcesses: () => [psLine(10, 10, ws), psLine(20, 20, ws), psLine(30, 30, ws)].join('\n'),
      killGroup: (pgid) => {
        killCalls.push(pgid)
        if (pgid === 20) throw new Error('ESRCH')
      },
      platform: 'darwin',
      selfPid: 1,
      logger: { log: () => {}, warn: () => {} },
    })
    // All three are reported as matches even though one kill threw.
    expect(out.map((m) => m.pgid).sort()).toEqual([10, 20, 30])
    // All three kill attempts were made (no short-circuit on the error).
    expect(killCalls.sort()).toEqual([10, 20, 30])
  })

  it('parses Windows `Get-CimInstance` JSON output (array form)', () => {
    const killed: Array<[number, NodeJS.Signals]> = []
    // PowerShell forward-slash-normalizes inconsistently, so the
    // reaper normalizes both sides; verify a mixed-slash workspace
    // matches an argv with forward slashes.
    const ws = 'C:\\Users\\Russell\\AppData\\Roaming\\Shogo\\workspaces\\abc'
    const json = JSON.stringify([
      {
        ProcessId: 5000,
        ParentProcessId: 1,
        CommandLine:
          '"C:/Program Files/Shogo/bun.exe" "C:/Users/Russell/AppData/Roaming/Shogo/workspaces/abc/node_modules/vite/bin/vite.js" build --watch --emptyOutDir false',
      },
      {
        ProcessId: 6000,
        ParentProcessId: 1,
        CommandLine: 'C:/Windows/System32/svchost.exe',
      },
    ])
    const out = reapStaleViteWatchers(ws, {
      listProcesses: () => json,
      killGroup: (pgid, sig) => killed.push([pgid, sig]),
      platform: 'win32',
      selfPid: 1,
      logger: { log: () => {}, warn: () => {} },
    })
    expect(out.map((m) => m.pid)).toEqual([5000])
    // Windows has no PGID; reaper treats pid==pgid and the production
    // killGroup wraps `taskkill /T /F /PID <pgid>` to walk the tree.
    expect(killed).toEqual([[5000, 'SIGTERM']])
  })

  it('parses Windows JSON output (single-element object form, not wrapped in array)', () => {
    // PowerShell's `ConvertTo-Json` returns a bare object — NOT a
    // one-element array — when there's exactly one match. Real bug
    // we'd hit on a machine with exactly one orphan vite-watch.
    const killed: Array<[number, NodeJS.Signals]> = []
    const ws = 'C:/ws/single'
    const json = JSON.stringify({
      ProcessId: 7777,
      ParentProcessId: 1,
      CommandLine: `bun.exe ${ws}/node_modules/vite/bin/vite.js build --watch`,
    })
    const out = reapStaleViteWatchers(ws, {
      listProcesses: () => json,
      killGroup: (pgid, sig) => killed.push([pgid, sig]),
      platform: 'win32',
      selfPid: 1,
      logger: { log: () => {}, warn: () => {} },
    })
    expect(out.map((m) => m.pid)).toEqual([7777])
    expect(killed).toEqual([[7777, 'SIGTERM']])
  })

  it('returns [] when Windows JSON is malformed (defensive parse)', () => {
    const killed: Array<[number, NodeJS.Signals]> = []
    const out = reapStaleViteWatchers('C:/ws/x', {
      listProcesses: () => 'not-json {{',
      killGroup: (pgid, sig) => killed.push([pgid, sig]),
      platform: 'win32',
      selfPid: 1,
      logger: { log: () => {}, warn: () => {} },
    })
    expect(out).toEqual([])
    expect(killed).toEqual([])
  })

  it('emits a single summary log line listing the pgids it is reaping', () => {
    // The log line is the operator's only signal that the reaper
    // fired — it's how a desktop user finds out "Shogo cleaned up
    // 3 orphan watchers from a previous session". Keep the format
    // pinned so log parsers / dashboards stay stable.
    const logs: string[] = []
    const ws = '/ws/logs'
    reapStaleViteWatchers(ws, {
      listProcesses: () => [psLine(7, 7, ws), psLine(8, 8, ws)].join('\n'),
      killGroup: () => {},
      platform: 'darwin',
      selfPid: 1,
      logger: { log: (m: string) => logs.push(m), warn: () => {} },
    })
    const summary = logs.find((l) => l.includes('reapStaleViteWatchers'))
    expect(summary).toBeDefined()
    expect(summary).toContain('found 2 orphan')
    expect(summary).toContain('pgid(s)=7,8')
  })

  it('is silent (no log lines) when no orphans are found', () => {
    // Steady-state guard: the reaper runs on EVERY startBuildWatch
    // (including normal cold starts), so noisy logging here would
    // spam every project start with `found 0 orphans` lines.
    const logs: string[] = []
    reapStaleViteWatchers('/ws/quiet', {
      listProcesses: () => '',
      killGroup: () => {},
      platform: 'darwin',
      selfPid: 1,
      logger: { log: (m: string) => logs.push(m), warn: () => {} },
    })
    expect(logs).toEqual([])
  })
})
