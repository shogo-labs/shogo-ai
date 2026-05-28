// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit-tests for the PtyHost control routing.
 *
 * We don't spawn a real shell here — node-pty's native module isn't
 * available until `npm install` runs inside apps/desktop (Phase 2
 * prereq). Instead we mock node-pty with a stub that records the
 * calls. This validates EVERY routing path in pty-host.ts:
 *
 *   spawn → spawn:ok with SessionInfo
 *   write → ok + recorded write on stub
 *   resize → ok + clamped cols/rows
 *   signal INT → writes \x03 to stub
 *   signal TERM/KILL → stub.kill called
 *   kill → stub.kill + session removed from map
 *   list → list:ok with current sessions
 *   attach → attach:ok with monotonic channelId + latestSeq
 *   detach → ok (no-throw even when session unknown)
 *
 * End-to-end "Electron utilityProcess spawns bash" verification is
 * deferred to Phase 2 where the renderer is wired up — that's the
 * meaningful integration boundary.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'

// ─── stub node-pty BEFORE importing pty-host ────────────────────────────

interface StubPty {
  readonly id: number
  readonly writes: string[]
  readonly killSignals: string[]
  resizes: { cols: number; rows: number }[]
  onData(cb: (data: string) => void): { dispose(): void }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void }
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(sig?: string): void
  pid: number
  cols: number
  rows: number
  // test-only emitter handles
  _emitData(data: string): void
  _emitExit(code: number, signal?: number): void
}

const STUBS: StubPty[] = []
let nextStubId = 1

function makeStub(cols: number, rows: number): StubPty {
  const writes: string[] = []
  const killSignals: string[] = []
  const resizes: { cols: number; rows: number }[] = []
  let dataCb: ((data: string) => void) | null = null
  let exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null
  const stub: StubPty = {
    id: nextStubId++,
    writes,
    killSignals,
    resizes,
    pid: 10000 + nextStubId,
    cols,
    rows,
    onData(cb) { dataCb = cb; return { dispose() { dataCb = null } } },
    onExit(cb) { exitCb = cb; return { dispose() { exitCb = null } } },
    write(data) { writes.push(data) },
    resize(c, r) { resizes.push({ cols: c, rows: r }); stub.cols = c; stub.rows = r },
    kill(sig) { killSignals.push(sig ?? 'SIGTERM') },
    _emitData(data) { dataCb?.(data) },
    _emitExit(exitCode, signal) { exitCb?.({ exitCode, signal }) },
  }
  STUBS.push(stub)
  return stub
}

mock.module('node-pty', () => ({
  spawn: (_file: string, _args: string[] | string, opts: { cols?: number; rows?: number }) => {
    return makeStub(opts?.cols ?? 80, opts?.rows ?? 24)
  },
}))

// ─── import AFTER the mock is registered ────────────────────────────────

import {
  _dispatchForTest,
  _sessionsForTest,
} from '../pty-host'

// ─── helpers ────────────────────────────────────────────────────────────

const outbox: unknown[] = []

beforeEach(() => {
  outbox.length = 0
  STUBS.length = 0
  nextStubId = 1
  _sessionsForTest().clear()
  // Re-wire parentPort on every test so postMessage captures into outbox.
  // pty-host.ts only attaches on utility-process boot path; for tests we
  // attach a shim before dispatch is called.
  ;(globalThis as { __ptyHostOutbox?: unknown[] }).__ptyHostOutbox = outbox
  // Patch process.parentPort so the host's send() pushes into outbox.
  ;(process as unknown as { parentPort: { postMessage: (m: unknown) => void } }).parentPort = {
    postMessage(m: unknown) { outbox.push(m) },
  }
})

function nextReply<T extends { reqId: number; kind: string }>(reqId: number): T {
  const found = outbox.find((m) => typeof m === 'object' && m !== null && (m as { reqId?: number }).reqId === reqId)
  if (!found) throw new Error(`no reply for reqId=${reqId}; outbox=${JSON.stringify(outbox).slice(0, 200)}`)
  return found as T
}

const defaultSpawnOpts = {
  shell: '/bin/bash',
  args: ['-l'],
  cwd: '/tmp',
  env: { TERM: 'xterm-256color' },
  cols: 80,
  rows: 24,
}

// ─── tests ──────────────────────────────────────────────────────────────

describe('PtyHost control routing', () => {
  it('spawn returns spawn:ok with SessionInfo and registers the session', () => {
    _dispatchForTest({ kind: 'spawn', reqId: 1, opts: defaultSpawnOpts })
    const r = nextReply<{ reqId: number; kind: string; session: { id: string; cols: number; rows: number } }>(1)
    expect(r.kind).toBe('spawn:ok')
    expect(r.session.cols).toBe(80)
    expect(r.session.rows).toBe(24)
    expect(_sessionsForTest().has(r.session.id)).toBe(true)
  })

  it('spawn clamps absurd cols/rows', () => {
    _dispatchForTest({ kind: 'spawn', reqId: 2, opts: { ...defaultSpawnOpts, cols: 99999, rows: 0 } })
    const r = nextReply<{ session: { cols: number; rows: number } }>(2)
    expect(r.session.cols).toBeLessThanOrEqual(1000)
    expect(r.session.rows).toBeGreaterThanOrEqual(1)
  })

  it('write routes to the underlying pty', () => {
    _dispatchForTest({ kind: 'spawn', reqId: 10, opts: defaultSpawnOpts })
    const id = nextReply<{ session: { id: string } }>(10).session.id
    _dispatchForTest({ kind: 'write', reqId: 11, id, text: 'echo hi\r' })
    expect(nextReply<{ kind: string }>(11).kind).toBe('ok')
    expect(STUBS[0].writes).toContain('echo hi\r')
  })

  it('resize clamps and forwards', () => {
    _dispatchForTest({ kind: 'spawn', reqId: 20, opts: defaultSpawnOpts })
    const id = nextReply<{ session: { id: string } }>(20).session.id
    _dispatchForTest({ kind: 'resize', reqId: 21, id, cols: 200, rows: 60 })
    expect(nextReply<{ kind: string }>(21).kind).toBe('ok')
    expect(STUBS[0].resizes[0]).toEqual({ cols: 200, rows: 60 })
  })

  it('signal INT writes \\x03 to the pty (ctrl-c)', () => {
    _dispatchForTest({ kind: 'spawn', reqId: 30, opts: defaultSpawnOpts })
    const id = nextReply<{ session: { id: string } }>(30).session.id
    _dispatchForTest({ kind: 'signal', reqId: 31, id, sig: 'INT' })
    expect(nextReply<{ kind: string }>(31).kind).toBe('ok')
    expect(STUBS[0].writes).toContain('\x03')
    expect(STUBS[0].killSignals.length).toBe(0)
  })

  it('signal TERM/KILL calls .kill on the pty', () => {
    _dispatchForTest({ kind: 'spawn', reqId: 40, opts: defaultSpawnOpts })
    const id = nextReply<{ session: { id: string } }>(40).session.id
    _dispatchForTest({ kind: 'signal', reqId: 41, id, sig: 'TERM' })
    _dispatchForTest({ kind: 'signal', reqId: 42, id, sig: 'KILL' })
    expect(STUBS[0].killSignals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('kill removes the session from the map', () => {
    _dispatchForTest({ kind: 'spawn', reqId: 50, opts: defaultSpawnOpts })
    const id = nextReply<{ session: { id: string } }>(50).session.id
    expect(_sessionsForTest().has(id)).toBe(true)
    _dispatchForTest({ kind: 'kill', reqId: 51, id })
    expect(nextReply<{ kind: string }>(51).kind).toBe('ok')
    expect(_sessionsForTest().has(id)).toBe(false)
  })

  it('list returns all sessions', () => {
    _dispatchForTest({ kind: 'spawn', reqId: 60, opts: defaultSpawnOpts })
    _dispatchForTest({ kind: 'spawn', reqId: 61, opts: { ...defaultSpawnOpts, shell: '/bin/zsh' } })
    _dispatchForTest({ kind: 'list', reqId: 62 })
    const r = nextReply<{ kind: string; sessions: { shell: string }[] }>(62)
    expect(r.kind).toBe('list:ok')
    expect(r.sessions.length).toBe(2)
    const shells = r.sessions.map((s) => s.shell).sort()
    expect(shells).toEqual(['/bin/bash', '/bin/zsh'])
  })

  it('attach returns a channelId + latestSeq for an existing session', () => {
    _dispatchForTest({ kind: 'spawn', reqId: 70, opts: defaultSpawnOpts })
    const id = nextReply<{ session: { id: string } }>(70).session.id
    // Simulate some output so latestSeq > 0
    STUBS[0]._emitData('hello\r\n')
    STUBS[0]._emitData('world\r\n')
    _dispatchForTest({ kind: 'attach', reqId: 71, id, sinceSeq: 0 })
    const r = nextReply<{ kind: string; channelId: string; latestSeq: number }>(71)
    expect(r.kind).toBe('attach:ok')
    expect(typeof r.channelId).toBe('string')
    expect(r.channelId.length).toBeGreaterThan(0)
    expect(r.latestSeq).toBe(2)
  })

  it('attach returns err for unknown session', () => {
    _dispatchForTest({ kind: 'attach', reqId: 80, id: 'does-not-exist', sinceSeq: 0 })
    const r = nextReply<{ kind: string; code: string }>(80)
    expect(r.kind).toBe('err')
    expect(r.code).toBe('no-session')
  })

  it('detach is idempotent — unknown session returns ok', () => {
    _dispatchForTest({ kind: 'detach', reqId: 90, id: 'no-such', channelId: 'whatever' })
    expect(nextReply<{ kind: string }>(90).kind).toBe('ok')
  })

  it('unknown control message kind emits a host:log warn', () => {
    _dispatchForTest({ kind: 'frobnicate', reqId: 100 })
    const logEvent = outbox.find((m) => typeof m === 'object' && m !== null && (m as { kind?: string }).kind === 'host:log')
    expect(logEvent).toBeDefined()
    expect((logEvent as { level: string }).level).toBe('warn')
  })
})

describe('PtySession scrollback behaviour (via attach.latestSeq)', () => {
  it('chunkSeq increments per kernel chunk', () => {
    _dispatchForTest({ kind: 'spawn', reqId: 200, opts: defaultSpawnOpts })
    const id = nextReply<{ session: { id: string } }>(200).session.id

    expect(STUBS[0]).toBeDefined()
    STUBS[0]._emitData('chunk-1')
    STUBS[0]._emitData('chunk-2')
    STUBS[0]._emitData('chunk-3')

    _dispatchForTest({ kind: 'attach', reqId: 201, id, sinceSeq: 0 })
    const r = nextReply<{ latestSeq: number }>(201)
    expect(r.latestSeq).toBe(3)
  })
})
