// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for PtySessionManager. Uses a fake PtySession so we don't pay
 * the cost of spawning real shells (which the pty-session.test.ts already
 * covers). The contract under test here is purely lifecycle bookkeeping:
 * create / attach / detach / reap, with a virtual clock.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { PtySessionManager, type ManagerOptions, type ReapReason } from '../pty-session-manager'
import type { ExitInfo, PtySpawnOptions, PtySession } from '../pty-session'

class FakePtySession {
  cwd: string
  cols: number
  rows: number
  scrollbackBytes: number
  isExited = false
  exitInfo: ExitInfo | null = null
  pid: number | undefined = 99999
  diagnostics = { shell: 'fake' }
  lastActivity: number
  latestSeq = 0
  scrollbackSize = 0
  disposed = false
  private exitCb: ((info: ExitInfo) => void) | null = null
  private clock: () => number

  constructor(opts: PtySpawnOptions, clock: () => number) {
    this.cwd = opts.cwd
    this.cols = opts.cols
    this.rows = opts.rows
    this.scrollbackBytes = opts.scrollbackBytes ?? 0
    this.clock = clock
    this.lastActivity = clock()
  }

  write(_b: Uint8Array | string): void { this.lastActivity = this.clock() }
  resize(c: number, r: number): void { this.cols = c; this.rows = r }
  signal(_s: 'INT' | 'TERM' | 'KILL'): void {}
  onData(_cb: (chunk: { seq: number; bytes: Uint8Array }) => void): () => void { return () => {} }
  onExit(cb: (info: ExitInfo) => void): () => void {
    this.exitCb = cb
    if (this.isExited && this.exitInfo) {
      const info = this.exitInfo
      queueMicrotask(() => cb(info))
    }
    return () => { this.exitCb = null }
  }
  replaySince(_s: number): { bytes: Uint8Array; latestSeq: number; truncated: boolean } {
    return { bytes: new Uint8Array(0), latestSeq: 0, truncated: false }
  }
  dispose(): void { this.disposed = true }

  /** Test helper — simulate the underlying shell exiting on its own. */
  fireExit(info: ExitInfo = { code: 0, signal: null }): void {
    this.isExited = true
    this.exitInfo = info
    this.exitCb?.(info)
  }
}

function makeManager(overrides: Partial<ManagerOptions> = {}) {
  let clock = 0
  const advance = (ms: number) => { clock += ms }
  const fakes: FakePtySession[] = []
  const mgr = new PtySessionManager({
    workspaceDir: '/tmp/ws',
    sweepIntervalMs: 0, // tests drive sweep() manually
    now: () => clock,
    spawnSession: (opts: PtySpawnOptions) => {
      const fake = new FakePtySession(opts, () => clock)
      fakes.push(fake)
      return fake as unknown as PtySession
    },
    ...overrides,
  })
  return { mgr, advance, fakes, clock: () => clock }
}

let openManagers: PtySessionManager[] = []
afterEach(() => {
  for (const m of openManagers) m.shutdown()
  openManagers = []
})

function track(mgr: PtySessionManager): PtySessionManager {
  openManagers.push(mgr)
  return mgr
}

describe('PtySessionManager — basics', () => {
  test('create returns a session and lists it', () => {
    const { mgr } = makeManager()
    track(mgr)
    const rec = mgr.create({ cols: 100, rows: 30 })
    expect(rec.id).toMatch(/^t/)
    expect(rec.session.cwd).toBe('/tmp/ws')
    expect(rec.session.cols).toBe(100)
    expect(mgr.list()).toHaveLength(1)
    expect(mgr.list()[0].id).toBe(rec.id)
  })

  test('create defaults cwd to workspaceDir, cols/rows to 80x24', () => {
    const { mgr } = makeManager()
    track(mgr)
    const rec = mgr.create()
    expect(rec.session.cwd).toBe('/tmp/ws')
    expect(rec.session.cols).toBe(80)
    expect(rec.session.rows).toBe(24)
  })

  test('create respects per-workspace maxSessions', () => {
    const { mgr } = makeManager({ maxSessions: 2 })
    track(mgr)
    mgr.create()
    mgr.create()
    expect(() => mgr.create()).toThrow(/max-sessions-reached/)
    expect(mgr.list()).toHaveLength(2)
  })

  test('get returns null for unknown id', () => {
    const { mgr } = makeManager()
    track(mgr)
    expect(mgr.get('nope')).toBeNull()
  })

  test('kill removes session and emits reap with reason "killed"', () => {
    const { mgr, fakes } = makeManager()
    track(mgr)
    const rec = mgr.create()
    const reaped: Array<[string, ReapReason]> = []
    mgr.onReap((id, reason) => reaped.push([id, reason]))
    mgr.kill(rec.id)
    expect(mgr.list()).toHaveLength(0)
    expect(fakes[0].disposed).toBe(true)
    expect(reaped).toEqual([[rec.id, 'killed']])
  })

  test('kill on unknown id is a no-op', () => {
    const { mgr } = makeManager()
    track(mgr)
    expect(() => mgr.kill('nope')).not.toThrow()
  })
})

describe('PtySessionManager — attach / detach', () => {
  test('attach returns the session and clears detachedAt', () => {
    const { mgr } = makeManager()
    track(mgr)
    const rec = mgr.create()
    const got = mgr.attach(rec.id)
    expect(got).toBe(rec.session)
    expect(mgr.list()[0].attached).toBe(1)
  })

  test('attach returns null when session already exited', () => {
    const { mgr, fakes } = makeManager()
    track(mgr)
    const rec = mgr.create()
    fakes[0].fireExit({ code: 0, signal: null })
    expect(mgr.attach(rec.id)).toBeNull()
  })

  test('detach drops attached count; multi-attach round-trips', () => {
    const { mgr } = makeManager()
    track(mgr)
    const rec = mgr.create()
    mgr.attach(rec.id)
    mgr.attach(rec.id)
    expect(mgr.list()[0].attached).toBe(2)
    mgr.detach(rec.id)
    expect(mgr.list()[0].attached).toBe(1)
    mgr.detach(rec.id)
    expect(mgr.list()[0].attached).toBe(0)
    mgr.detach(rec.id) // floors at 0, no underflow
    expect(mgr.list()[0].attached).toBe(0)
  })
})

describe('PtySessionManager — sweep / reap policies', () => {
  test('detach grace period reaps an unattached session', () => {
    const { mgr, advance } = makeManager({ gracePeriodMs: 1000 })
    track(mgr)
    const rec = mgr.create()
    const reaped: Array<[string, ReapReason]> = []
    mgr.onReap((id, reason) => reaped.push([id, reason]))

    // Born detached. Just inside the grace window — not yet.
    advance(500)
    mgr.sweep()
    expect(mgr.list()).toHaveLength(1)

    advance(700) // total 1200, past 1000
    mgr.sweep()
    expect(mgr.list()).toHaveLength(0)
    expect(reaped).toEqual([[rec.id, 'detach-grace']])
  })

  test('attach within grace period prevents reap', () => {
    const { mgr, advance } = makeManager({ gracePeriodMs: 1000 })
    track(mgr)
    const rec = mgr.create()
    advance(500)
    mgr.attach(rec.id)
    advance(2000)
    mgr.sweep()
    expect(mgr.list()).toHaveLength(1)
  })

  test('idle timeout reaps even an attached session with no input', () => {
    const { mgr, advance } = makeManager({ idleTimeoutMs: 1000, gracePeriodMs: 999_999 })
    track(mgr)
    const rec = mgr.create()
    mgr.attach(rec.id)
    advance(1500)
    mgr.sweep()
    expect(mgr.list()).toHaveLength(0)
    // Make sure the reason was idle, not detach-grace.
    const reaped: Array<[string, ReapReason]> = []
    const mgr2Result = makeManager({ idleTimeoutMs: 1000, gracePeriodMs: 999_999 })
    track(mgr2Result.mgr)
    const r2 = mgr2Result.mgr.create()
    mgr2Result.mgr.attach(r2.id)
    mgr2Result.mgr.onReap((id, reason) => reaped.push([id, reason]))
    mgr2Result.advance(1500)
    mgr2Result.mgr.sweep()
    expect(reaped).toEqual([[r2.id, 'idle']])
    void rec
  })

  test('write() resets idle clock', () => {
    const { mgr, advance, fakes } = makeManager({
      idleTimeoutMs: 1000, gracePeriodMs: 999_999,
    })
    track(mgr)
    const rec = mgr.create()
    mgr.attach(rec.id)

    advance(800)
    fakes[0].write(new Uint8Array([0x61])) // simulates user keystroke; bumps lastActivity
    advance(800) // 1600 total since create, 800 since last activity → still under idle
    mgr.sweep()
    expect(mgr.list()).toHaveLength(1)

    advance(500) // 1300 since last activity → over idle
    mgr.sweep()
    expect(mgr.list()).toHaveLength(0)
  })

  test('max-age reaps a still-active session', () => {
    const { mgr, advance, fakes } = makeManager({
      maxAgeMs: 2000, idleTimeoutMs: 999_999, gracePeriodMs: 999_999,
    })
    track(mgr)
    const rec = mgr.create()
    mgr.attach(rec.id)
    const reaped: Array<[string, ReapReason]> = []
    mgr.onReap((id, reason) => reaped.push([id, reason]))
    // Stay active to defeat the idle clock.
    for (let i = 0; i < 5; i++) {
      advance(450)
      fakes[0].write(new Uint8Array([0x61]))
    }
    // Total elapsed ~2250ms > 2000ms maxAge → reap
    mgr.sweep()
    expect(mgr.list()).toHaveLength(0)
    expect(reaped).toEqual([[rec.id, 'max-age']])
  })

  test('exited session is reaped on its own (via onExit hook), no sweep needed', () => {
    const { mgr, fakes } = makeManager()
    track(mgr)
    const rec = mgr.create()
    const reaped: Array<[string, ReapReason]> = []
    mgr.onReap((id, reason) => reaped.push([id, reason]))
    fakes[0].fireExit({ code: 0, signal: null })
    expect(mgr.list()).toHaveLength(0)
    expect(reaped).toEqual([[rec.id, 'exited']])
  })

  test('shutdown reaps all and clears the sweeper', () => {
    const { mgr, fakes } = makeManager()
    track(mgr)
    mgr.create()
    mgr.create()
    const reaped: Array<[string, ReapReason]> = []
    mgr.onReap((_id, reason) => reaped.push([_id, reason]))
    mgr.shutdown()
    expect(mgr.list()).toHaveLength(0)
    expect(fakes.every((f) => f.disposed)).toBe(true)
    expect(reaped.map((r) => r[1])).toEqual(['shutdown', 'shutdown'])
  })
})
