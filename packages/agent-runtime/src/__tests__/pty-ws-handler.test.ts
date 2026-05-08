// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the PTY WS handler triplet. Uses a fake `MinimalWs` so we
 * don't need to spin up a real Bun.serve. The contract under test:
 *
 *   - open() attaches to the manager, replays scrollback (with optional
 *     TRUNC), then subscribes to live data
 *   - message() decodes the binary frame and routes to the right session
 *     method (write / resize / signal)
 *   - close() detaches and clears subscriptions
 *   - manager-driven reap closes the WS with a "pty:<reason>" close reason
 *
 * Real PtySession spawning is covered by pty-session.test.ts; here we
 * inject a fake session via PtySessionManager's `spawnSession` hook.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { PtySessionManager } from '../pty-session-manager'
import type { ExitInfo, PtySession, PtySpawnOptions } from '../pty-session'
import {
  ClientFrameType,
  ServerFrameType,
  decodeServerFrame,
  encodeClientData,
  encodeClientResize,
  encodeClientSignal,
} from '../pty-protocol'
import { createPtyWsHandlers, type MinimalWs, type WsData } from '../pty-ws-handler'

class FakePtySession {
  cwd = '/tmp'
  cols = 80
  rows = 24
  scrollbackBytes = 0
  isExited = false
  exitInfo: ExitInfo | null = null
  pid = 1
  diagnostics = { shell: 'fake' }
  lastActivity = 0
  latestSeq = 0
  scrollbackSize = 0
  disposed = false
  writes: Uint8Array[] = []
  resizes: Array<[number, number]> = []
  signals: string[] = []

  private dataCbs = new Set<(c: { seq: number; bytes: Uint8Array }) => void>()
  private exitCb: ((info: ExitInfo) => void) | null = null
  private replay: { bytes: Uint8Array; latestSeq: number; truncated: boolean } = {
    bytes: new Uint8Array(0), latestSeq: 0, truncated: false,
  }

  constructor(_opts: PtySpawnOptions) {}

  setReplay(r: { bytes: Uint8Array; latestSeq: number; truncated: boolean }): void {
    this.replay = r
  }

  emit(seq: number, bytes: Uint8Array): void {
    for (const cb of this.dataCbs) cb({ seq, bytes })
  }

  fireExit(info: ExitInfo = { code: 0, signal: null }): void {
    this.isExited = true
    this.exitInfo = info
    this.exitCb?.(info)
  }

  write(b: Uint8Array | string): void {
    if (typeof b === 'string') this.writes.push(new TextEncoder().encode(b))
    else this.writes.push(b)
  }
  resize(c: number, r: number): void { this.resizes.push([c, r]); this.cols = c; this.rows = r }
  signal(s: 'INT' | 'TERM' | 'KILL'): void { this.signals.push(s) }
  onData(cb: (c: { seq: number; bytes: Uint8Array }) => void): () => void {
    this.dataCbs.add(cb)
    return () => this.dataCbs.delete(cb)
  }
  onExit(cb: (info: ExitInfo) => void): () => void {
    this.exitCb = cb
    return () => { this.exitCb = null }
  }
  replaySince(_s: number): { bytes: Uint8Array; latestSeq: number; truncated: boolean } {
    return this.replay
  }
  dispose(): void { this.disposed = true }
}

class FakeWs implements MinimalWs<WsData> {
  data: WsData
  sent: Uint8Array[] = []
  closed: { code?: number; reason?: string } | null = null
  constructor(data: WsData) { this.data = data }
  send(payload: Uint8Array): number { this.sent.push(payload); return payload.byteLength }
  close(code?: number, reason?: string): void { this.closed = { code, reason } }
}

function makeRig() {
  const fakes: FakePtySession[] = []
  const manager = new PtySessionManager({
    workspaceDir: '/tmp/ws',
    sweepIntervalMs: 0,
    spawnSession: (opts) => {
      const f = new FakePtySession(opts)
      fakes.push(f)
      return f as unknown as PtySession
    },
  })
  const handlers = createPtyWsHandlers()
  return { manager, handlers, fakes }
}

function wsFor(manager: PtySessionManager, sessionId: string, since = 0): FakeWs {
  return new FakeWs({ manager, sessionId, since })
}

let rigs: ReturnType<typeof makeRig>[] = []
afterEach(() => {
  for (const r of rigs) {
    r.handlers.dispose()
    r.manager.shutdown()
  }
  rigs = []
})
function rig(): ReturnType<typeof makeRig> {
  const r = makeRig()
  rigs.push(r)
  return r
}

describe('createPtyWsHandlers — open', () => {
  test('attaches, replays scrollback, then subscribes to live data', () => {
    const { manager, handlers, fakes } = rig()
    const rec = manager.create()
    fakes[0].setReplay({
      bytes: new TextEncoder().encode('replay-bytes'),
      latestSeq: 7,
      truncated: false,
    })
    const ws = wsFor(manager, rec.id)
    handlers.open(ws)

    expect(ws.sent).toHaveLength(1)
    const frame = decodeServerFrame(ws.sent[0])
    expect(frame?.type).toBe(ServerFrameType.DATA)
    if (frame?.type !== ServerFrameType.DATA) throw new Error('unreachable')
    expect(frame.seq).toBe(7)
    expect(new TextDecoder().decode(frame.bytes)).toBe('replay-bytes')

    // Subsequent live data should be sent through.
    fakes[0].emit(8, new TextEncoder().encode('live'))
    expect(ws.sent).toHaveLength(2)
    const live = decodeServerFrame(ws.sent[1])
    if (live?.type !== ServerFrameType.DATA) throw new Error('unreachable')
    expect(live.seq).toBe(8)
    expect(new TextDecoder().decode(live.bytes)).toBe('live')
  })

  test('emits TRUNC frame before replay when scrollback was truncated', () => {
    const { manager, handlers, fakes } = rig()
    const rec = manager.create()
    fakes[0].setReplay({
      bytes: new TextEncoder().encode('partial'),
      latestSeq: 100,
      truncated: true,
    })
    const ws = wsFor(manager, rec.id, 50)
    handlers.open(ws)

    expect(ws.sent.length).toBeGreaterThanOrEqual(2)
    const first = decodeServerFrame(ws.sent[0])
    expect(first?.type).toBe(ServerFrameType.TRUNC)
    const second = decodeServerFrame(ws.sent[1])
    expect(second?.type).toBe(ServerFrameType.DATA)
  })

  test('skips empty replay (no DATA frame, no subscribe gap)', () => {
    const { manager, handlers, fakes } = rig()
    const rec = manager.create()
    // default replay is empty
    const ws = wsFor(manager, rec.id, 99)
    handlers.open(ws)
    expect(ws.sent).toHaveLength(0)

    fakes[0].emit(100, new TextEncoder().encode('live'))
    expect(ws.sent).toHaveLength(1)
  })

  test('closes WS with 4404 when session is unknown', () => {
    const { manager, handlers } = rig()
    const ws = wsFor(manager, 'no-such-session')
    handlers.open(ws)
    expect(ws.closed?.code).toBe(4404)
    expect(ws.data.detached).toBe(true)
  })
})

describe('createPtyWsHandlers — message', () => {
  test('DATA frame writes to the session', () => {
    const { manager, handlers, fakes } = rig()
    const rec = manager.create()
    const ws = wsFor(manager, rec.id)
    handlers.open(ws)

    handlers.message(ws, encodeClientData(new TextEncoder().encode('hello')))
    expect(fakes[0].writes).toHaveLength(1)
    expect(new TextDecoder().decode(fakes[0].writes[0])).toBe('hello')
  })

  test('RESIZE frame resizes the session, clamped to 1..1000', () => {
    const { manager, handlers, fakes } = rig()
    const rec = manager.create()
    const ws = wsFor(manager, rec.id)
    handlers.open(ws)

    handlers.message(ws, encodeClientResize(120, 40))
    expect(fakes[0].resizes).toEqual([[120, 40]])

    // Out-of-range gets clamped.
    handlers.message(ws, encodeClientResize(0, 9999))
    expect(fakes[0].resizes[1]).toEqual([1, 1000])
  })

  test('SIGNAL frame routes through to session.signal', () => {
    const { manager, handlers, fakes } = rig()
    const rec = manager.create()
    const ws = wsFor(manager, rec.id)
    handlers.open(ws)

    handlers.message(ws, encodeClientSignal('INT'))
    handlers.message(ws, encodeClientSignal('TERM'))
    expect(fakes[0].signals).toEqual(['INT', 'TERM'])
  })

  test('malformed binary frame is silently dropped', () => {
    const { manager, handlers, fakes } = rig()
    const rec = manager.create()
    const ws = wsFor(manager, rec.id)
    handlers.open(ws)
    handlers.message(ws, new Uint8Array([0xff, 0x00, 0x00]))
    expect(fakes[0].writes).toHaveLength(0)
  })

  test('text-frame messages are ignored (binary-only protocol)', () => {
    const { manager, handlers, fakes } = rig()
    const rec = manager.create()
    const ws = wsFor(manager, rec.id)
    handlers.open(ws)
    handlers.message(ws, 'hello as text')
    expect(fakes[0].writes).toHaveLength(0)
  })

  test('messages after the session vanished are dropped, not crashing', () => {
    const { manager, handlers, fakes } = rig()
    const rec = manager.create()
    const ws = wsFor(manager, rec.id)
    handlers.open(ws)
    manager.kill(rec.id) // takes the session out from under us
    expect(() =>
      handlers.message(ws, encodeClientData(new TextEncoder().encode('post-mortem'))),
    ).not.toThrow()
    expect(fakes[0].writes).toHaveLength(0)
  })
})

describe('createPtyWsHandlers — close + reap', () => {
  test('close detaches and clears subscriptions', () => {
    const { manager, handlers, fakes } = rig()
    const rec = manager.create()
    const ws = wsFor(manager, rec.id)
    handlers.open(ws)
    expect(manager.list()[0].attached).toBe(1)

    handlers.close(ws)
    expect(manager.list()[0].attached).toBe(0)

    // After close, live data should not be forwarded.
    fakes[0].emit(99, new TextEncoder().encode('after-close'))
    expect(ws.sent).toHaveLength(0)
  })

  test('reap closes the WS with a "pty:<reason>" reason', async () => {
    const { manager, handlers } = rig()
    const rec = manager.create()
    const ws = wsFor(manager, rec.id)
    handlers.open(ws)

    manager.kill(rec.id) // → reap with reason "killed"
    // Mark-detached is sync (so the per-WS close handler skips), but the
    // actual ws.close is deferred a microtask so any pending EXIT-frame
    // sends drain first. Wait for it.
    expect(ws.data.detached).toBe(true)
    await new Promise((r) => queueMicrotask(() => r(undefined)))
    expect(ws.closed?.reason).toBe('pty:killed')

    // close() called after a reap-driven close should be a no-op (no
    // double-detach against an already-gone session).
    expect(() => handlers.close(ws)).not.toThrow()
  })

  test('shutdown reap uses code 1001 (going away)', async () => {
    const { manager, handlers } = rig()
    const rec = manager.create()
    const ws = wsFor(manager, rec.id)
    handlers.open(ws)
    manager.shutdown()
    await new Promise((r) => queueMicrotask(() => r(undefined)))
    expect(ws.closed?.code).toBe(1001)
    expect(ws.closed?.reason).toBe('pty:shutdown')
  })

  test('exit emits an EXIT frame to the WS', () => {
    const { manager, handlers, fakes } = rig()
    const rec = manager.create()
    const ws = wsFor(manager, rec.id)
    handlers.open(ws)

    fakes[0].fireExit({ code: 42, signal: null })
    const exitFrame = ws.sent.find((b) => b[0] === ServerFrameType.EXIT)
    expect(exitFrame).toBeDefined()
    if (!exitFrame) throw new Error('unreachable')
    const decoded = decodeServerFrame(exitFrame)
    if (decoded?.type !== ServerFrameType.EXIT) throw new Error('unreachable')
    expect(decoded.code).toBe(42)
  })
})

void ClientFrameType
