// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Greenfield sweep for three never-loaded shogo-worker libs:
 *   api-discovery.ts, process-manager.ts, preflight.ts
 * Shared mocks: node:fs (controllable), node:child_process (fake spawn),
 * ./paths, ./transport.
 */
import { describe, test, expect, beforeEach, afterEach, mock, afterAll } from 'bun:test'
import { EventEmitter } from 'node:events'

// ── controllable node:fs ──────────────────────────────────────────────────────
let existsMap: Record<string, boolean> = {}
let existsPredicate: ((p: string) => boolean) | null = null
let pidFileContent: string | null = null
const fsWrites: Array<{ path: string; data: string }> = []
const fsUnlinks: string[] = []
let unlinkThrows = false

mock.module('node:fs', () => ({
  existsSync: (p: string) => {
    const s = String(p)
    if (existsPredicate) return existsPredicate(s)
    if (s in existsMap) return existsMap[s]
    // PID file existence keyed off pidFileContent
    if (s.endsWith('worker.pid')) return pidFileContent !== null
    return false
  },
  readFileSync: (p: string) => {
    if (String(p).endsWith('worker.pid')) return pidFileContent ?? ''
    return ''
  },
  writeFileSync: (p: string, data: string) => { fsWrites.push({ path: String(p), data: String(data) }) },
  unlinkSync: (p: string) => { if (unlinkThrows) throw new Error('ENOENT'); fsUnlinks.push(String(p)) },
  openSync: () => 7,
}))

// ── fake child_process.spawn ──────────────────────────────────────────────────
let spawnPid: number | undefined = 4242
let lastSpawn: { cmd: string; args: string[]; opts: any; child: any } | null = null
class FakeChild extends EventEmitter {
  pid: number | undefined
  killed: string | null = null
  unrefed = false
  constructor(pid: number | undefined) { super(); this.pid = pid }
  kill(sig: string) { this.killed = sig }
  unref() { this.unrefed = true }
}
mock.module('node:child_process', () => ({
  spawn: (cmd: string, args: string[], opts: any) => {
    const child = new FakeChild(spawnPid)
    lastSpawn = { cmd, args, opts, child }
    return child
  },
}))

// ── ./paths ───────────────────────────────────────────────────────────────────
let ensureHomeCalls = 0
mock.module('../paths.ts', () => ({
  PID_FILE: '/home/.shogo/worker.pid',
  WORKER_LOG: '/home/.shogo/logs/worker.log',
  WORKER_ERR: '/home/.shogo/logs/worker.err.log',
  ensureHome: () => { ensureHomeCalls++ },
}))

// ── ./transport (for preflight) ────────────────────────────────────────────────
// Delegate to the REAL transport by default so sibling files that import the
// genuine module (e.g. worker-transport-greenfield.test.ts) are not shadowed by
// this file's process-global mock. Individual tests below override the impls.
const _realTransport = require('../transport')
const _defaultAllowlist = _realTransport.deriveAllowlist
const _defaultProbeProxy = _realTransport.probeProxy
let allowlistImpl: (cloudUrl: string) => any[] = _defaultAllowlist
let probeProxyImpl: (...a: any[]) => Promise<{ ok: boolean; detail?: string }> = _defaultProbeProxy
mock.module('../transport.ts', () => ({
  ..._realTransport,
  deriveAllowlist: (u: string) => allowlistImpl(u),
  probeProxy: (...a: any[]) => probeProxyImpl(...a),
}))

import { findApiEntry } from '../api-discovery'
import { readPid, isRunning, clearPid, spawnWorker, installShutdownHooks, stopWorker } from '../process-manager'
import { makeChecks, runPreflight, type Check } from '../preflight'

beforeEach(() => {
  existsMap = {}; pidFileContent = null; unlinkThrows = false
  fsWrites.length = 0; fsUnlinks.length = 0
  spawnPid = 4242; lastSpawn = null; ensureHomeCalls = 0
  existsPredicate = null
})

function mockExists(fn: (p: string) => boolean) { existsPredicate = fn }

// ════════════════════════════════════════════════════════════════════════════
describe('api-discovery.findApiEntry', () => {
  test('prefers bundled dist entry (node runner) when present', () => {
    mockExists((p) => p.endsWith('entry.js'))
    const r = findApiEntry()
    expect(r.mode).toBe('bundled')
    expect(r.runner).toBe('node')
    expect(r.entry).toContain('entry.js')
  })
  test('falls back to monorepo entry (bun runner)', () => {
    mockExists((p) => p.endsWith('entry.ts'))
    const r = findApiEntry()
    expect(r.mode).toBe('monorepo')
    expect(r.runner).toBe('bun')
    expect(r.entry).toContain('entry.ts')
  })
  test('throws when neither entry exists', () => {
    mockExists(() => false)
    expect(() => findApiEntry()).toThrow('Cannot locate apps/api entry')
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('process-manager', () => {
  test('readPid returns null when no pid file, parses int when present', () => {
    pidFileContent = null
    expect(readPid()).toBe(null)
    pidFileContent = '  12345 \n'
    expect(readPid()).toBe(12345)
    pidFileContent = 'not-a-number'
    expect(readPid()).toBe(null)
  })

  test('isRunning reflects process.kill(pid,0)', () => {
    const realKill = process.kill
    ;(process as any).kill = (_pid: number, _sig: number) => true
    expect(isRunning(999)).toBe(true)
    ;(process as any).kill = () => { throw new Error('ESRCH') }
    expect(isRunning(999)).toBe(false)
    process.kill = realKill
  })

  test('clearPid swallows unlink errors', () => {
    unlinkThrows = true
    expect(() => clearPid()).not.toThrow()
    unlinkThrows = false
    clearPid()
    expect(fsUnlinks).toContain('/home/.shogo/worker.pid')
  })

  test('spawnWorker spawns, writes pid file, returns pid', () => {
    const realKill = process.kill
    ;(process as any).kill = () => { throw new Error('ESRCH') } // no existing process
    pidFileContent = null
    const { pid, child } = spawnWorker({ entry: '/e.ts', runner: 'bun', env: {}, cwd: '/w' })
    expect(pid).toBe(4242)
    expect(ensureHomeCalls).toBe(1)
    expect(lastSpawn!.cmd).toBe('bun')
    expect(fsWrites.some((w) => w.path.endsWith('worker.pid') && w.data === '4242')).toBe(true)
    expect((child as any).unrefed).toBe(false)
    process.kill = realKill
  })

  test('spawnWorker detached unrefs the child + inheritStdio path', () => {
    const realKill = process.kill
    ;(process as any).kill = () => { throw new Error('ESRCH') }
    pidFileContent = null
    const { child } = spawnWorker({ entry: '/e', runner: 'node', env: {}, cwd: '/w', detach: true, inheritStdio: true })
    expect((child as any).unrefed).toBe(true)
    expect(lastSpawn!.opts.detached).toBe(true)
    process.kill = realKill
  })

  test('spawnWorker throws when a live worker already holds the pid file', () => {
    const realKill = process.kill
    pidFileContent = '777'
    ;(process as any).kill = () => true // existing pid is alive
    expect(() => spawnWorker({ entry: '/e', runner: 'bun', env: {}, cwd: '/w' })).toThrow('already running')
    process.kill = realKill
  })

  test('spawnWorker clears a stale pid file then spawns', () => {
    const realKill = process.kill
    pidFileContent = '888'
    let calls = 0
    ;(process as any).kill = () => { calls++; throw new Error('ESRCH') } // stale
    const { pid } = spawnWorker({ entry: '/e', runner: 'bun', env: {}, cwd: '/w' })
    expect(pid).toBe(4242)
    expect(fsUnlinks).toContain('/home/.shogo/worker.pid') // stale cleared
    process.kill = realKill
  })

  test('spawnWorker throws when spawn yields no pid', () => {
    const realKill = process.kill
    ;(process as any).kill = () => { throw new Error('ESRCH') }
    spawnPid = undefined
    pidFileContent = null
    expect(() => spawnWorker({ entry: '/e', runner: 'bun', env: {}, cwd: '/w' })).toThrow('Failed to spawn')
    process.kill = realKill
  })

  test('stopWorker: null when no pid; clears stale; kills live', () => {
    const realKill = process.kill
    pidFileContent = null
    expect(stopWorker().killedPid).toBe(null)
    // stale
    pidFileContent = '321'
    ;(process as any).kill = (_p: number, sig: any) => { if (sig === 0) throw new Error('ESRCH'); return true }
    expect(stopWorker().killedPid).toBe(null)
    expect(fsUnlinks).toContain('/home/.shogo/worker.pid')
    // live
    pidFileContent = '654'
    ;(process as any).kill = () => true
    expect(stopWorker('SIGKILL').killedPid).toBe(654)
    process.kill = realKill
  })

  test('installShutdownHooks forwards signal to child + clears pid; child exit triggers process.exit', () => {
    const realKill = process.kill
    const realExit = process.exit
    const onceHandlers: Record<string, Function> = {}
    const realOnce = process.once
    ;(process as any).once = (evt: string, fn: Function) => { onceHandlers[evt] = fn; return process }
    let exitCode: number | undefined
    ;(process as any).exit = (c?: number) => { exitCode = c; throw new Error('__exit__') }

    const child = new FakeChild(111)
    installShutdownHooks(child as any)
    // trigger SIGINT
    onceHandlers['SIGINT']?.()
    expect(child.killed).toBe('SIGINT')
    expect(fsUnlinks).toContain('/home/.shogo/worker.pid')
    // second invocation is a no-op (shutdownStarted guard)
    onceHandlers['SIGTERM']?.()
    // child 'exit' with a code → process.exit(code)
    expect(() => child.emit('exit', 3, null)).toThrow('__exit__')
    expect(exitCode).toBe(3)

    process.once = realOnce; process.exit = realExit; process.kill = realKill
  })

  test('installShutdownHooks exit handler with signal maps to 128+n', () => {
    const realExit = process.exit
    const onceHandlers: Record<string, Function> = {}
    const realOnce = process.once
    ;(process as any).once = (evt: string, fn: Function) => { onceHandlers[evt] = fn; return process }
    let exitCode: number | undefined
    ;(process as any).exit = (c?: number) => { exitCode = c; throw new Error('__exit__') }
    const child = new FakeChild(222)
    installShutdownHooks(child as any)
    expect(() => child.emit('exit', null, 'SIGTERM')).toThrow('__exit__')
    expect(exitCode).toBe(128 + 15)
    // 'exit' process handler clears pid when no shutdown started
    onceHandlers['exit']?.()
    process.once = realOnce; process.exit = realExit
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('preflight', () => {
  const baseOpts = { cloudUrl: 'https://api.shogo.dev', apiKey: 'K', workerDir: '/worker' }
  const ORIGINAL_FETCH = globalThis.fetch
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH })

  test('makeChecks: node-version + worker-dir + allowlist + api-key checks; proxy added when set', async () => {
    existsMap = { '/worker': true }
    const checks = makeChecks(baseOpts)
    const names = checks.map((c) => c.name)
    expect(names[0]).toContain('Runtime')
    expect(names.some((n) => n.includes('Worker directory'))).toBe(true)
    expect(names.some((n) => n.includes('Reach api.shogo.dev'))).toBe(true)
    expect(names.some((n) => n.includes('API key valid'))).toBe(true)
    expect(names.some((n) => n.includes('Proxy'))).toBe(false)

    const withProxy = makeChecks({ ...baseOpts, proxy: { url: 'http://proxy:3128' } as any })
    expect(withProxy.some((c) => c.name.includes('Proxy reachable (proxy:3128)'))).toBe(true)
  })

  test('node-version check passes on >=20, worker-dir reflects existsSync', async () => {
    existsMap = { '/worker': true }
    const checks = makeChecks(baseOpts)
    const node = await checks[0].run()
    expect(node.ok).toBe(true) // test runner is node>=20
    const dirOk = await checks[1].run()
    expect(dirOk.ok).toBe(true)
    existsMap = { '/worker': false }
    const dirBad = await makeChecks(baseOpts)[1].run()
    expect(dirBad.ok).toBe(false)
    expect(dirBad.detail).toContain('does not exist')
  })

  test('allowlist health probe: ok, no-response, and abort/error paths', async () => {
    existsMap = { '/worker': true }
    // ok
    globalThis.fetch = (async () => ({ status: 200 })) as any
    let checks = makeChecks(baseOpts)
    const reach = checks.find((c) => c.name.includes('Reach api.shogo.dev'))!
    expect(await reach.run()).toMatchObject({ ok: true, detail: 'HTTP 200' })
    // no response (fetch resolves null via .catch)
    globalThis.fetch = (async () => { throw new Error('conn refused') }) as any
    checks = makeChecks(baseOpts)
    const reach2 = checks.find((c) => c.name.includes('Reach api.shogo.dev'))!
    expect((await reach2.run()).ok).toBe(false)
  })

  test('api-key check: 401 rejected, ok, and thrown error', async () => {
    existsMap = { '/worker': true }
    globalThis.fetch = (async () => ({ status: 401, ok: false })) as any
    let key = makeChecks(baseOpts).find((c) => c.name.includes('API key'))!
    expect(await key.run()).toMatchObject({ ok: false })
    globalThis.fetch = (async () => ({ status: 200, ok: true })) as any
    key = makeChecks(baseOpts).find((c) => c.name.includes('API key'))!
    expect(await key.run()).toMatchObject({ ok: true })
    globalThis.fetch = (async () => ({ status: 500, ok: false })) as any
    key = makeChecks(baseOpts).find((c) => c.name.includes('API key'))!
    expect((await key.run()).ok).toBe(false)
    globalThis.fetch = (async () => { throw new Error('network') }) as any
    key = makeChecks(baseOpts).find((c) => c.name.includes('API key'))!
    expect(await key.run()).toMatchObject({ ok: false, detail: 'network' })
  })

  test('proxy check delegates to probeProxy', async () => {
    existsMap = { '/worker': true }
    probeProxyImpl = async () => ({ ok: false, detail: 'proxy down' })
    const checks = makeChecks({ ...baseOpts, proxy: { url: 'http://p:1' } as any })
    const proxy = checks.find((c) => c.name.includes('Proxy'))!
    expect(await proxy.run()).toMatchObject({ ok: false, detail: 'proxy down' })
    probeProxyImpl = _defaultProbeProxy
  })

  test('makeChecks safeHost falls back to raw on bad proxy URL', () => {
    const checks = makeChecks({ ...baseOpts, proxy: { url: 'not a url' } as any })
    expect(checks.some((c) => c.name.includes('not a url'))).toBe(true)
  })

  test('runPreflight: all-pass returns true', async () => {
    const checks: Check[] = [
      { name: 'a', criticality: 'fatal', run: async () => ({ ok: true, detail: 'd' }) },
      { name: 'b', criticality: 'graceful', run: async () => ({ ok: true }) },
    ]
    expect(await runPreflight(checks)).toBe(true)
  })

  test('runPreflight: graceful failure still returns true', async () => {
    const checks: Check[] = [
      { name: 'a', criticality: 'fatal', run: async () => ({ ok: true }) },
      { name: 'b', criticality: 'graceful', run: async () => ({ ok: false, detail: 'optional down' }) },
    ]
    expect(await runPreflight(checks)).toBe(true)
  })

  test('runPreflight: fatal failure returns false', async () => {
    const checks: Check[] = [
      { name: 'a', criticality: 'fatal', run: async () => ({ ok: false, detail: 'boom' }) },
    ]
    expect(await runPreflight(checks)).toBe(false)
  })
})

afterAll(() => {
  mock.restore()
})
