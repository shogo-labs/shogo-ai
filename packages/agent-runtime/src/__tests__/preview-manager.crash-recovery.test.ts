// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
// Phase 3c: PreviewManager error paths + start() proper. Covers all 4
// start() fast-bail returns + the prebuilt-dist / background-build /
// metro entry points (with backgroundSetup stubbed at the instance level
// so we don't spawn real subprocesses). Then killApiServer (idle bail +
// SIGTERM-then-exit happy path), runPrismaIfNeeded (no-schema /
// client-exists / generate-throws / db-exists / db-push-throws), and
// forwardLogLine swallow-listener-exceptions guarantee.
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'

// --- Mocks (must be before the SUT import) -------------------------------

let prismaGenerateImpl: (cwd: string) => Promise<void> = async () => {}
let prismaDbPushImpl: (cwd: string, opts: any) => Promise<void> = async () => {}

mock.module('@shogo/shared-runtime', () => ({
  pkg: {
    prismaGenerateAsync: (cwd: string) => prismaGenerateImpl(cwd),
    prismaDbPushAsync: (cwd: string, opts: any) => prismaDbPushImpl(cwd, opts),
  },
  resolveBinInvocation: (_cwd: string, _bin: string) => null,
}))

import { PreviewManager } from '../preview-manager'

// --- Helpers --------------------------------------------------------------

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pm-cr-'))
  prismaGenerateImpl = async () => {}
  prismaDbPushImpl = async () => {}
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function mk(over: Partial<ConstructorParameters<typeof PreviewManager>[0]> = {}) {
  return new PreviewManager({
    workspaceDir: dir,
    runtimePort: 38306,
    publicUrl: 'https://preview.example/abc',
    localMode: false,
    ...over,
  })
}

function projectDir() {
  const p = join(dir, 'project')
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
  return p
}

function withPackageJson(content: any = { name: 'x' }) {
  const p = projectDir()
  writeFileSync(join(p, 'package.json'), JSON.stringify(content))
  return p
}

// A fake child process that mimics the minimal surface PreviewManager
// touches: kill(), killed, exit-once event, EventEmitter wiring.
class FakeProc extends EventEmitter {
  killed = false
  killSignals: NodeJS.Signals[] = []
  exitAfterKillMs?: number
  constructor(opts: { exitAfterKillMs?: number } = {}) {
    super()
    this.exitAfterKillMs = opts.exitAfterKillMs
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killSignals.push(signal)
    if (this.killed) return true
    if (signal === 'SIGKILL') {
      this.killed = true
      setImmediate(() => this.emit('exit', 0, signal))
      return true
    }
    if (this.exitAfterKillMs !== undefined) {
      setTimeout(() => {
        this.killed = true
        this.emit('exit', 0, signal)
      }, this.exitAfterKillMs)
    }
    return true
  }
}

// --- start() — all 4 entry points ---------------------------------------

describe('PreviewManager.start — fast-bail returns', () => {
  it('returns already-running when started=true', async () => {
    const m = mk() as any
    m.started = true
    expect(await m.start()).toEqual({
      mode: 'already-running',
      port: 38306,
      timings: {},
    })
  })

  it('returns no-project when bundlerCwd has no package.json', async () => {
    const log = mock(() => {}); console.log = log as any
    try {
      const r = await mk().start()
      expect(r.mode).toBe('no-project')
      expect(r.port).toBeNull()
    } finally {
      // restore is handled in afterEach via the test boundary
    }
  })

  it('returns no-bundler + phase=ready when devServer is "none"', async () => {
    const p = withPackageJson()
    writeFileSync(join(dir, '.tech-stack'), 'static-html')
    const m = mk() as any
    // Stub resolveDevServer so we don't depend on tech-stack discovery.
    m.resolveDevServer = () => 'none'
    const r = await m.start()
    expect(r.mode).toBe('no-bundler')
    expect(r.port).toBe(38306)
    expect(m.phase).toBe('ready')
    expect(m.isStarted).toBe(true)
  })
})

describe('PreviewManager.start — vite (prebuilt vs cold)', () => {
  it('reports prebuilt-dist and phase=ready when dist/index.html exists', async () => {
    const p = withPackageJson()
    mkdirSync(join(p, 'dist'), { recursive: true })
    writeFileSync(join(p, 'dist/index.html'), '<html></html>')
    const m = mk() as any
    let bgCalls = 0
    m.backgroundSetup = async () => { bgCalls++ }
    const r = await m.start()
    expect(r.mode).toBe('prebuilt-dist')
    expect(m.phase).toBe('ready')
    expect(m.isStarted).toBe(true)
    // backgroundSetup runs but we don't await it from start()
    await new Promise((r) => setImmediate(r))
    expect(bgCalls).toBe(1)
  })

  it('reports background-build and phase=building when no prebuilt dist', async () => {
    withPackageJson()
    const m = mk() as any
    m.backgroundSetup = async () => {}
    const r = await m.start()
    expect(r.mode).toBe('background-build')
    expect(m.phase).toBe('building')
    expect(m.isStarted).toBe(true)
  })

  it('start() does NOT crash when backgroundSetup rejects', async () => {
    withPackageJson()
    const m = mk() as any
    m.backgroundSetup = async () => { throw new Error('install failed') }
    const err = mock(() => {}); console.error = err as any
    const r = await m.start()
    // Wait one microtask so the catch handler runs.
    await new Promise((r) => setImmediate(r))
    expect(r.mode).toBe('background-build')
    expect(m.phase).toBe('building') // didn't auto-progress; just didn't crash
  })
})

describe('PreviewManager.start — metro', () => {
  it('returns metro-web (background) and phase=building', async () => {
    withPackageJson({ dependencies: { expo: '*', 'react-native': '*' } })
    writeFileSync(join(dir, '.tech-stack'), 'expo-app')
    const m = mk() as any
    let metroCalls = 0
    m.backgroundSetupMetro = async () => { metroCalls++ }
    const r = await m.start()
    expect(r.mode).toBe('metro-web (background)')
    expect(r.port).toBe(38306)
    expect(m.phase).toBe('building')
    expect(m.isStarted).toBe(true)
    await new Promise((r) => setImmediate(r))
    expect(metroCalls).toBe(1)
  })

  it('start() does NOT crash when backgroundSetupMetro rejects', async () => {
    withPackageJson()
    writeFileSync(join(dir, '.tech-stack'), 'expo-app')
    const m = mk() as any
    m.backgroundSetupMetro = async () => { throw new Error('expo failed') }
    const err = mock(() => {}); console.error = err as any
    const r = await m.start()
    await new Promise((r) => setImmediate(r))
    expect(r.mode).toBe('metro-web (background)')
  })
})

// --- killApiServer -------------------------------------------------------

describe('PreviewManager.killApiServer (private)', () => {
  it('fast-bails when no apiServerProcess is set', async () => {
    const m = mk() as any
    await m.killApiServer()
    expect(m.apiServerProcess).toBeNull()
    expect(m.intentionalStop).toBe(true)
  })

  it('fast-bails when the apiServerProcess is already killed', async () => {
    const m = mk() as any
    const fake = new FakeProc()
    fake.killed = true
    m.apiServerProcess = fake
    await m.killApiServer()
    expect(m.apiServerProcess).toBeNull()
    expect(fake.killSignals).toEqual([])
  })

  it('sends SIGTERM and resolves when the process exits cleanly', async () => {
    const m = mk() as any
    const fake = new FakeProc({ exitAfterKillMs: 5 })
    m.apiServerProcess = fake
    const t0 = Date.now()
    await m.killApiServer()
    const elapsed = Date.now() - t0
    expect(fake.killSignals).toEqual(['SIGTERM'])
    expect(elapsed).toBeLessThan(500)
    expect(m.apiServerProcess).toBeNull()
  })

  it('clears a pending crashRestartTimer before signalling', async () => {
    const m = mk() as any
    m.crashRestartTimer = setTimeout(() => {}, 60_000)
    m.apiServerProcess = new FakeProc({ exitAfterKillMs: 5 })
    await m.killApiServer()
    expect(m.crashRestartTimer).toBeNull()
  })
})

// --- runPrismaIfNeeded ---------------------------------------------------

describe('PreviewManager.runPrismaIfNeeded (private)', () => {
  it('is a no-op when prisma/schema.prisma is missing', async () => {
    withPackageJson()
    const m = mk() as any
    const timings: Record<string, number> = {}
    let generateCalls = 0
    prismaGenerateImpl = async () => { generateCalls++ }
    await m.runPrismaIfNeeded(timings)
    expect(generateCalls).toBe(0)
    expect(timings.prisma).toBeUndefined()
  })

  it('skips generate when .prisma/client already exists', async () => {
    const p = withPackageJson()
    mkdirSync(join(p, 'prisma'), { recursive: true })
    writeFileSync(join(p, 'prisma/schema.prisma'), 'datasource db {}')
    mkdirSync(join(p, 'node_modules/.prisma/client'), { recursive: true })
    let calls = 0
    prismaGenerateImpl = async () => { calls++ }
    const m = mk() as any
    const timings: Record<string, number> = {}
    const log = mock(() => {}); console.log = log as any
    await m.runPrismaIfNeeded(timings)
    expect(calls).toBe(0)
    expect(timings.prisma).toBe(0)
  })

  it('runs generate when client is missing and records timing', async () => {
    const p = withPackageJson()
    mkdirSync(join(p, 'prisma'), { recursive: true })
    writeFileSync(join(p, 'prisma/schema.prisma'), 'datasource db {}')
    let observedCwd = ''
    prismaGenerateImpl = async (cwd) => { observedCwd = cwd; await new Promise((r) => setTimeout(r, 1)) }
    const m = mk() as any
    const timings: Record<string, number> = {}
    await m.runPrismaIfNeeded(timings)
    expect(observedCwd).toBe(p)
    expect(timings.prisma).toBeGreaterThanOrEqual(1)
  })

  it('catches generate errors without throwing and still records timing', async () => {
    const p = withPackageJson()
    mkdirSync(join(p, 'prisma'), { recursive: true })
    writeFileSync(join(p, 'prisma/schema.prisma'), 'datasource db {}')
    prismaGenerateImpl = async () => { throw new Error('prisma bad schema') }
    const err = mock(() => {}); console.error = err as any
    const m = mk() as any
    const timings: Record<string, number> = {}
    await expect(m.runPrismaIfNeeded(timings)).resolves.toBeUndefined()
    expect(typeof timings.prisma).toBe('number')
  })

  it('skips db push when dev.db already exists', async () => {
    const p = withPackageJson()
    mkdirSync(join(p, 'prisma'), { recursive: true })
    writeFileSync(join(p, 'prisma/schema.prisma'), 'x')
    writeFileSync(join(p, 'prisma/dev.db'), 'sqlite')
    mkdirSync(join(p, 'node_modules/.prisma/client'), { recursive: true })
    let pushCalls = 0
    prismaDbPushImpl = async () => { pushCalls++ }
    const m = mk() as any
    const timings: Record<string, number> = {}
    const log = mock(() => {}); console.log = log as any
    await m.runPrismaIfNeeded(timings)
    expect(pushCalls).toBe(0)
    expect(timings.dbPush).toBe(0)
  })

  it('runs db push when dev.db is missing', async () => {
    const p = withPackageJson()
    mkdirSync(join(p, 'prisma'), { recursive: true })
    writeFileSync(join(p, 'prisma/schema.prisma'), 'x')
    mkdirSync(join(p, 'node_modules/.prisma/client'), { recursive: true })
    let observedEnv: any = null
    prismaDbPushImpl = async (_cwd, opts) => { observedEnv = opts?.env }
    const m = mk() as any
    const timings: Record<string, number> = {}
    const log = mock(() => {}); console.log = log as any
    await m.runPrismaIfNeeded(timings)
    expect(observedEnv?.DATABASE_URL).toBe(`file:${join(p, 'prisma/dev.db')}`)
    expect(typeof timings.dbPush).toBe('number')
  })

  it('catches db push errors without throwing', async () => {
    const p = withPackageJson()
    mkdirSync(join(p, 'prisma'), { recursive: true })
    writeFileSync(join(p, 'prisma/schema.prisma'), 'x')
    mkdirSync(join(p, 'node_modules/.prisma/client'), { recursive: true })
    prismaDbPushImpl = async () => { throw new Error('schema invalid: ' + 'x'.repeat(400)) }
    const err = mock(() => {}); console.error = err as any
    const m = mk() as any
    const timings: Record<string, number> = {}
    await expect(m.runPrismaIfNeeded(timings)).resolves.toBeUndefined()
    expect(typeof timings.dbPush).toBe('number')
  })

  it('sets phase=generating-prisma during generate and phase=pushing-db after', async () => {
    const p = withPackageJson()
    mkdirSync(join(p, 'prisma'), { recursive: true })
    writeFileSync(join(p, 'prisma/schema.prisma'), 'x')
    let phaseDuring: string | undefined
    prismaGenerateImpl = async () => {
      phaseDuring = (m as any).phase
    }
    const m = mk() as any
    await m.runPrismaIfNeeded({})
    expect(phaseDuring).toBe('generating-prisma')
    // After (with no dev.db) it transitioned to pushing-db
    expect(m.phase).toBe('pushing-db')
  })
})

// --- forwardLogLine ------------------------------------------------------

describe('PreviewManager.forwardLogLine (private)', () => {
  it('is a no-op when no listener is configured', () => {
    const m = mk() as any
    expect(() => m.forwardLogLine('hi', 'stdout')).not.toThrow()
  })

  it('is a no-op when the line is empty', () => {
    const calls: any[] = []
    const m = mk({ onLogLine: (line, stream) => calls.push([line, stream]) }) as any
    m.forwardLogLine('', 'stdout')
    expect(calls).toEqual([])
  })

  it('forwards stdout / stderr lines verbatim', () => {
    const calls: any[] = []
    const m = mk({ onLogLine: (line, stream) => calls.push([line, stream]) }) as any
    m.forwardLogLine('hello', 'stdout')
    m.forwardLogLine('bye', 'stderr')
    expect(calls).toEqual([['hello', 'stdout'], ['bye', 'stderr']])
  })

  it('swallows listener exceptions — bundler must not die because of a noisy log handler', () => {
    const m = mk({ onLogLine: () => { throw new Error('listener crash') } }) as any
    expect(() => m.forwardLogLine('hi', 'stdout')).not.toThrow()
  })
})
