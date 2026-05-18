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
import { PreviewManager } from '../preview-manager'

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
  it('truncates an existing .console.log to empty', () => {
    const bundler = join(dir, 'project')
    mkdirSync(bundler, { recursive: true })
    writeFileSync(join(bundler, 'package.json'), '{}')
    const logPath = join(bundler, '.console.log')
    writeFileSync(logPath, 'old content here\n')
    const m = mk() as any
    m.clearRuntimeConsoleLog()
    expect(readFileSync(logPath, 'utf-8')).toBe('')
  })

  it('also calls the optional onConsoleLogReset listener', () => {
    const bundler = join(dir, 'project')
    mkdirSync(bundler, { recursive: true })
    writeFileSync(join(bundler, 'package.json'), '{}')
    writeFileSync(join(bundler, '.console.log'), 'x')
    let calls = 0
    const m = mk({ onConsoleLogReset: () => { calls++ } }) as any
    m.clearRuntimeConsoleLog()
    expect(calls).toBe(1)
  })

  it('is a no-op (logs a warning) when the bundlerCwd does not exist', () => {
    const m = mk() as any
    const warn = console.warn
    console.warn = () => {}
    try {
      expect(() => m.clearRuntimeConsoleLog()).not.toThrow()
    } finally {
      console.warn = warn
    }
  })

  it('still truncates the file even if the listener is undefined', () => {
    const bundler = join(dir, 'project')
    mkdirSync(bundler, { recursive: true })
    writeFileSync(join(bundler, 'package.json'), '{}')
    const logPath = join(bundler, '.console.log')
    writeFileSync(logPath, 'before')
    // No onConsoleLogReset wired
    const m = mk() as any
    m.clearRuntimeConsoleLog()
    expect(readFileSync(logPath, 'utf-8')).toBe('')
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
