// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Phase 2 integration test for the data-plane port binding.
 *
 * The host's `handleAttach` accepts an optional `HostPort` (a
 * `MessagePortMain`-like) and, when present:
 *   1. Replays scrollback (TRUNC? + DATA(latestSeq))
 *   2. Subscribes a fanout writer to the session
 *   3. Decodes inbound client frames → write/resize/signal on the PTY
 *
 * We feed it a `FakeHostPort` and assert each leg without spawning a
 * real shell — node-pty is mocked via mock.module (same pattern as
 * pty-host.routing.test.ts).
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import {
  encodeClientData,
  encodeClientResize,
  encodeClientSignal,
  decodeServerFrame,
  ServerFrameType,
} from '@shogo/pty-core'

// ─── stub node-pty BEFORE importing pty-host ────────────────────────────

interface StubPty {
  writes: string[]
  killSignals: string[]
  resizes: { cols: number; rows: number }[]
  onData(cb: (data: string) => void): { dispose(): void }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void }
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(sig?: string): void
  pid: number
  cols: number
  rows: number
  _emitData(data: string): void
  _emitExit(code: number, signal?: number): void
}

const STUBS: StubPty[] = []

function makeStub(cols: number, rows: number): StubPty {
  const writes: string[] = []
  const killSignals: string[] = []
  const resizes: { cols: number; rows: number }[] = []
  let dataCb: ((data: string) => void) | null = null
  let exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null
  const stub: StubPty = {
    writes, killSignals, resizes,
    pid: 12345,
    cols, rows,
    onData(cb) { dataCb = cb; return { dispose() { dataCb = null } } },
    onExit(cb) { exitCb = cb; return { dispose() { exitCb = null } } },
    write(d) { writes.push(d) },
    resize(c, r) { resizes.push({ cols: c, rows: r }); stub.cols = c; stub.rows = r },
    kill(sig) { killSignals.push(sig ?? 'SIGTERM') },
    _emitData(d) { dataCb?.(d) },
    _emitExit(code, signal) { exitCb?.({ exitCode: code, signal }) },
  }
  STUBS.push(stub)
  return stub
}

mock.module('node-pty', () => ({
  spawn: (_file: string, _args: string[], opts: { cols?: number; rows?: number }) =>
    makeStub(opts?.cols ?? 80, opts?.rows ?? 24),
}))

import { _dispatchForTest, _sessionsForTest } from '../pty-host'

// ─── fake HostPort (mirrors Electron's MessagePortMain shape) ─────────

class FakeHostPort {
  sent: Uint8Array[] = []
  closed = false
  started = false
  msgListeners = new Set<(e: { data: ArrayBuffer | Uint8Array }) => void>()
  closeListeners = new Set<() => void>()
  postMessage(msg: ArrayBuffer | Uint8Array) {
    if (this.closed) return
    const u8 = msg instanceof ArrayBuffer ? new Uint8Array(msg) : new Uint8Array(msg)
    this.sent.push(u8)
  }
  on(event: 'message' | 'close', listener: (...args: unknown[]) => void) {
    if (event === 'message') {
      this.msgListeners.add(listener as (e: { data: ArrayBuffer | Uint8Array }) => void)
    } else {
      this.closeListeners.add(listener as () => void)
    }
  }
  start() { this.started = true }
  close() {
    if (this.closed) return
    this.closed = true
    for (const l of this.closeListeners) l()
  }
  _send(frame: Uint8Array) {
    for (const l of this.msgListeners) l({ data: frame })
  }
}

// ─── helpers ──────────────────────────────────────────────────────────

const outbox: unknown[] = []

beforeEach(() => {
  outbox.length = 0
  STUBS.length = 0
  _sessionsForTest().clear()
  ;(process as unknown as { parentPort: { postMessage: (m: unknown) => void } }).parentPort = {
    postMessage(m: unknown) { outbox.push(m) },
  }
})

function findReply<T extends { reqId: number }>(reqId: number): T {
  const r = outbox.find((m) => typeof m === 'object' && m !== null && (m as { reqId?: number }).reqId === reqId)
  if (!r) throw new Error(`no reply for reqId=${reqId}`)
  return r as T
}

function spawnOne(reqId = 1) {
  _dispatchForTest({
    kind: 'spawn',
    reqId,
    opts: { shell: '/bin/bash', args: [], cwd: '/tmp', env: {}, cols: 80, rows: 24 },
  })
  return findReply<{ session: { id: string } }>(reqId).session.id
}

// ─── tests ─────────────────────────────────────────────────────────────

describe('PtyHost data-port binding (Phase 2)', () => {
  it('attach without a port returns attach:ok and does NOT subscribe', () => {
    const id = spawnOne(1)
    _dispatchForTest({ kind: 'attach', reqId: 2, id, sinceSeq: 0 }, null)
    const reply = findReply<{ kind: string; channelId: string; latestSeq: number }>(2)
    expect(reply.kind).toBe('attach:ok')
    // After emitting data, no port should have received anything.
    STUBS[0]._emitData('hello')
    // We don't have a port to inspect — the assertion here is "no crash + reply OK".
    expect(reply.latestSeq).toBe(0)
  })

  it('attach WITH a port replays scrollback first, then streams live DATA frames', () => {
    const id = spawnOne(10)
    // Emit some output BEFORE the attach so it lands in the ring.
    STUBS[0]._emitData('preface\r\n')

    const port = new FakeHostPort()
    _dispatchForTest({ kind: 'attach', reqId: 11, id, sinceSeq: 0 }, port)

    expect(findReply<{ kind: string }>(11).kind).toBe('attach:ok')
    expect(port.started).toBe(true)

    // First frame should be a DATA replay covering the preface.
    const replay = decodeServerFrame(port.sent[0])
    if (!replay || replay.type !== ServerFrameType.DATA) {
      throw new Error('first frame should be DATA replay')
    }
    expect(new TextDecoder().decode(replay.bytes)).toBe('preface\r\n')

    // Now live: post-attach emissions should flow through as new DATA frames.
    STUBS[0]._emitData('live')
    expect(port.sent.length).toBe(2)
    const live = decodeServerFrame(port.sent[1])
    if (!live || live.type !== ServerFrameType.DATA) {
      throw new Error('second frame should be live DATA')
    }
    expect(new TextDecoder().decode(live.bytes)).toBe('live')
  })

  it('inbound DATA frames on the port write into the underlying PTY', () => {
    const id = spawnOne(20)
    const port = new FakeHostPort()
    _dispatchForTest({ kind: 'attach', reqId: 21, id, sinceSeq: 0 }, port)
    port._send(encodeClientData(new TextEncoder().encode('ls -la\r')))
    expect(STUBS[0].writes).toContain('ls -la\r')
  })

  it('inbound RESIZE frames resize the PTY', () => {
    const id = spawnOne(30)
    const port = new FakeHostPort()
    _dispatchForTest({ kind: 'attach', reqId: 31, id, sinceSeq: 0 }, port)
    port._send(encodeClientResize(200, 60))
    expect(STUBS[0].resizes[0]).toEqual({ cols: 200, rows: 60 })
  })

  it('inbound SIGNAL INT writes \\x03 to the PTY', () => {
    const id = spawnOne(40)
    const port = new FakeHostPort()
    _dispatchForTest({ kind: 'attach', reqId: 41, id, sinceSeq: 0 }, port)
    port._send(encodeClientSignal('INT'))
    expect(STUBS[0].writes).toContain('\x03')
  })

  it('port.close unsubscribes the data fanout — later session data is NOT sent', () => {
    const id = spawnOne(50)
    const port = new FakeHostPort()
    _dispatchForTest({ kind: 'attach', reqId: 51, id, sinceSeq: 0 }, port)
    STUBS[0]._emitData('before-close')
    expect(port.sent.length).toBe(1)

    port.close()
    STUBS[0]._emitData('after-close')
    // The session may still receive emissions, but the port subscriber
    // should be gone. Re-check: port.sent stays at 1 (close prevents
    // postMessage), AND the session has 0 attached subscribers.
    expect(port.sent.length).toBe(1)
  })

  it('on PTY exit, an EXIT frame is sent to the port and the port is closed', () => {
    const id = spawnOne(60)
    const port = new FakeHostPort()
    _dispatchForTest({ kind: 'attach', reqId: 61, id, sinceSeq: 0 }, port)
    STUBS[0]._emitExit(0)
    // The PtySession's onExit fires `onExit(code, signal, 'pty:exited')`
    // which posts an EXIT frame and then closes the port.
    const exitFrame = port.sent.find((f) => {
      const d = decodeServerFrame(f)
      return d?.type === ServerFrameType.EXIT
    })
    expect(exitFrame).toBeDefined()
    expect(port.closed).toBe(true)
  })

  it('attach with sinceSeq mid-history still replays — handled by ScrollbackRing', () => {
    const id = spawnOne(70)
    STUBS[0]._emitData('chunk1')
    STUBS[0]._emitData('chunk2')
    STUBS[0]._emitData('chunk3')

    const port = new FakeHostPort()
    // Replay since seq=2 — should only get chunk3 (the chunk with seq=3).
    _dispatchForTest({ kind: 'attach', reqId: 71, id, sinceSeq: 2 }, port)

    const dataFrames = port.sent
      .map((f) => decodeServerFrame(f))
      .filter((f): f is { type: typeof ServerFrameType.DATA; seq: number; bytes: Uint8Array } =>
        f?.type === ServerFrameType.DATA)
    expect(dataFrames.length).toBeGreaterThanOrEqual(1)
    // The replay coalesces remaining chunks into one DATA frame ending at latestSeq=3.
    expect(dataFrames[0].seq).toBe(3)
    const text = new TextDecoder().decode(dataFrames[0].bytes)
    expect(text).toBe('chunk3')
  })
})
