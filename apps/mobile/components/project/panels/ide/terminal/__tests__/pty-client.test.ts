// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for PtyClient. Uses an in-memory FakeWebSocket so we can drive
 * the state machine deterministically (open/message/close at exact moments)
 * and inspect everything sent over the wire.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { PtyClient, type PtyClientState } from '../pty-client'
import {
  ClientFrameType,
  ServerFrameType,
  decodeServerFrame,
} from '../pty-protocol'

class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3
  binaryType: 'arraybuffer' | string = 'blob'
  readyState = 0
  url: string
  sent: Uint8Array[] = []
  closeCalls: Array<{ code?: number; reason?: string }> = []
  private listeners = new Map<string, Set<(ev: any) => void>>()

  constructor(url: string) { this.url = url }

  addEventListener(name: string, fn: (ev: any) => void): void {
    let set = this.listeners.get(name)
    if (!set) { set = new Set(); this.listeners.set(name, set) }
    set.add(fn)
  }
  removeEventListener(name: string, fn: (ev: any) => void): void {
    this.listeners.get(name)?.delete(fn)
  }
  send(payload: Uint8Array | string | ArrayBuffer): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('not open')
    if (typeof payload === 'string') this.sent.push(new TextEncoder().encode(payload))
    else if (payload instanceof Uint8Array) this.sent.push(payload)
    else this.sent.push(new Uint8Array(payload))
  }
  close(code = 1000, reason = ''): void {
    this.closeCalls.push({ code, reason })
    this.readyState = FakeWebSocket.CLOSED
    this.fire('close', { code, reason })
  }

  // ── test helpers ─────────────────────────────────────────────────
  fireOpen(): void { this.readyState = FakeWebSocket.OPEN; this.fire('open', {}) }
  fireMessage(payload: Uint8Array): void {
    this.fire('message', { data: payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) })
  }
  fireClose(code: number, reason: string): void {
    this.readyState = FakeWebSocket.CLOSED
    this.fire('close', { code, reason })
  }
  fireError(): void { this.fire('error', {}) }

  private fire(name: string, ev: any): void {
    const set = this.listeners.get(name)
    if (!set) return
    for (const fn of [...set]) {
      try { fn(ev) } catch {}
    }
  }
}

let createdSockets: FakeWebSocket[] = []
let scheduledTimers: Array<{ cb: () => void; ms: number; cancelled: boolean }> = []

function makeFactory(): (url: string) => WebSocket {
  return (url: string) => {
    const ws = new FakeWebSocket(url)
    createdSockets.push(ws)
    return ws as unknown as WebSocket
  }
}
function fakeSetTimeout(cb: () => void, ms: number): unknown {
  const t = { cb, ms, cancelled: false }
  scheduledTimers.push(t)
  return t
}
function fakeClearTimeout(id: unknown): void {
  const t = id as { cancelled: boolean }
  if (t) t.cancelled = true
}
function runTimers(): void {
  const due = scheduledTimers.filter((t) => !t.cancelled)
  scheduledTimers = []
  for (const t of due) t.cb()
}

beforeEach(() => {
  createdSockets = []
  scheduledTimers = []
})
afterEach(() => {
  // nothing
})

function makeClient(extra: Partial<ConstructorParameters<typeof PtyClient>[0]> = {}) {
  const states: PtyClientState[] = []
  const data: string[] = []
  let exit: { code: number | null; signal: string | null } | null = null
  let truncated = false
  const errors: string[] = []
  const client = new PtyClient(
    {
      url: 'ws://test/ws',
      minBackoffMs: 10,
      maxBackoffMs: 100,
      wsFactory: makeFactory(),
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout,
      ...extra,
    },
    {
      onState: (s) => states.push(s),
      onData: (b) => data.push(new TextDecoder().decode(b)),
      onExit: (e) => { exit = e },
      onTruncated: () => { truncated = true },
      onError: (e) => errors.push(e.message),
    },
  )
  return {
    client, states, data,
    get exit() { return exit },
    get truncated() { return truncated },
    errors,
  }
}

describe('PtyClient — state machine', () => {
  test('connect transitions idle → connecting → open', () => {
    const r = makeClient()
    r.client.connect()
    expect(r.states).toEqual(['connecting'])
    createdSockets[0].fireOpen()
    expect(r.states).toEqual(['connecting', 'open'])
    expect(r.client.state).toBe('open')
  })

  test('connect is no-op when already open or connecting', () => {
    const r = makeClient()
    r.client.connect()
    r.client.connect() // still connecting
    expect(createdSockets).toHaveLength(1)
    createdSockets[0].fireOpen()
    r.client.connect() // already open
    expect(createdSockets).toHaveLength(1)
  })

  test('dispose closes the socket and prevents further connects', () => {
    const r = makeClient()
    r.client.connect()
    createdSockets[0].fireOpen()
    r.client.dispose()
    expect(r.client.state).toBe('disposed')
    expect(createdSockets[0].closeCalls).toHaveLength(1)
    r.client.connect()
    expect(createdSockets).toHaveLength(1) // didn't spawn another
  })
})

describe('PtyClient — outbound frames', () => {
  test('send() emits a DATA frame with the typed payload', () => {
    const r = makeClient()
    r.client.connect(); createdSockets[0].fireOpen()
    r.client.send('hi')
    const frame = createdSockets[0].sent[0]
    expect(frame[0]).toBe(ClientFrameType.DATA)
    expect(new TextDecoder().decode(frame.subarray(1))).toBe('hi')
  })

  test('send() before open is a no-op', () => {
    const r = makeClient()
    r.client.send('hi')
    expect(createdSockets).toHaveLength(0)
  })

  test('resize() emits big-endian u16 cols/rows', () => {
    const r = makeClient()
    r.client.connect(); createdSockets[0].fireOpen()
    r.client.resize(120, 40)
    const f = createdSockets[0].sent[0]
    expect(f[0]).toBe(ClientFrameType.RESIZE)
    expect(Array.from(f.subarray(1))).toEqual([0x00, 0x78, 0x00, 0x28])
  })

  test('resize() rejects out-of-range / non-integer values', () => {
    const r = makeClient()
    r.client.connect(); createdSockets[0].fireOpen()
    r.client.resize(0, 24)
    r.client.resize(80, 70_000)
    r.client.resize(80.5, 24)
    expect(createdSockets[0].sent).toHaveLength(0)
  })

  test('signal() emits a SIGNAL frame with the chosen signal name', () => {
    const r = makeClient()
    r.client.connect(); createdSockets[0].fireOpen()
    r.client.signal('INT')
    const f = createdSockets[0].sent[0]
    expect(f[0]).toBe(ClientFrameType.SIGNAL)
    expect(new TextDecoder().decode(f.subarray(1))).toBe('INT')
  })
})

describe('PtyClient — inbound frames', () => {
  test('DATA frames go to onData with bytes only (seq stripped)', () => {
    const r = makeClient()
    r.client.connect(); createdSockets[0].fireOpen()
    // Build a server DATA frame for seq=5, "hello"
    const enc = new TextEncoder().encode('hello')
    const buf = new Uint8Array(5 + enc.byteLength)
    buf[0] = ServerFrameType.DATA
    buf[1] = 0; buf[2] = 0; buf[3] = 0; buf[4] = 5
    buf.set(enc, 5)
    createdSockets[0].fireMessage(buf)
    expect(r.data).toEqual(['hello'])
    expect(r.client.currentSeq).toBe(5)
  })

  test('EXIT frames go to onExit', () => {
    const r = makeClient()
    r.client.connect(); createdSockets[0].fireOpen()
    const json = new TextEncoder().encode('{"code":42,"signal":null}')
    const buf = new Uint8Array(1 + json.byteLength)
    buf[0] = ServerFrameType.EXIT
    buf.set(json, 1)
    createdSockets[0].fireMessage(buf)
    expect(r.exit).toEqual({ code: 42, signal: null })
  })

  test('TRUNC frames go to onTruncated', () => {
    const r = makeClient()
    r.client.connect(); createdSockets[0].fireOpen()
    createdSockets[0].fireMessage(new Uint8Array([ServerFrameType.TRUNC]))
    expect(r.truncated).toBe(true)
  })

  test('text-frame messages are silently ignored (binary-only protocol)', () => {
    const r = makeClient()
    r.client.connect(); createdSockets[0].fireOpen()
    createdSockets[0].fireMessage(new Uint8Array([0xff]))
    expect(r.data).toHaveLength(0)
  })

  test('out-of-order DATA frames do not lower currentSeq', () => {
    const r = makeClient()
    r.client.connect(); createdSockets[0].fireOpen()
    const mk = (seq: number, body: string): Uint8Array => {
      const enc = new TextEncoder().encode(body)
      const buf = new Uint8Array(5 + enc.byteLength)
      buf[0] = ServerFrameType.DATA
      buf[1] = (seq >>> 24) & 0xff
      buf[2] = (seq >>> 16) & 0xff
      buf[3] = (seq >>> 8) & 0xff
      buf[4] = seq & 0xff
      buf.set(enc, 5)
      return buf
    }
    createdSockets[0].fireMessage(mk(10, 'a'))
    createdSockets[0].fireMessage(mk(7, 'b'))
    expect(r.client.currentSeq).toBe(10)
  })
})

describe('PtyClient — reconnect / replay', () => {
  test('unexpected close schedules a reconnect with ?since=lastSeq', () => {
    const r = makeClient()
    r.client.connect(); createdSockets[0].fireOpen()
    // Receive seq=99 then drop
    const enc = new TextEncoder().encode('x')
    const buf = new Uint8Array(5 + enc.byteLength)
    buf[0] = ServerFrameType.DATA
    buf[1] = 0; buf[2] = 0; buf[3] = 0; buf[4] = 99
    buf.set(enc, 5)
    createdSockets[0].fireMessage(buf)
    createdSockets[0].fireClose(1006, 'transport-glitch')
    expect(r.client.state).toBe('closed')
    expect(scheduledTimers).toHaveLength(1)
    runTimers()
    expect(createdSockets).toHaveLength(2)
    expect(createdSockets[1].url).toBe('ws://test/ws?since=99')
  })

  test('terminal close reasons do NOT schedule reconnect', () => {
    for (const reason of ['pty:exited', 'pty:killed', 'pty:idle', 'pty:max-age', 'pty:shutdown', 'no-session']) {
      const r = makeClient()
      r.client.connect(); createdSockets[0].fireOpen()
      createdSockets[0].fireClose(1000, reason)
      expect(scheduledTimers).toHaveLength(0)
      r.client.dispose()
      // reset for next iteration
      createdSockets = []
      scheduledTimers = []
    }
  })

  test('terminal code 4404 (unknown session) does not reconnect', () => {
    const r = makeClient()
    r.client.connect(); createdSockets[0].fireOpen()
    createdSockets[0].fireClose(4404, 'no-session')
    expect(scheduledTimers).toHaveLength(0)
  })

  test('exponential backoff (10, 20, 40, 80, 100, 100, ...) when reconnects keep failing', () => {
    const r = makeClient()
    r.client.connect()
    // Fail the FIRST connect attempt before it ever opens; this counts as
    // retry #0 → backoff = minBackoff. Then each reconnect also fails
    // before opening, so retryCount monotonically increases.
    const delays: number[] = []
    for (let i = 0; i < 6; i++) {
      const ws = createdSockets[createdSockets.length - 1]
      ws.fireClose(1006, 'transport-glitch')
      const t = scheduledTimers[scheduledTimers.length - 1]
      delays.push(t.ms)
      runTimers()
    }
    expect(delays.slice(0, 4)).toEqual([10, 20, 40, 80])
    expect(delays[4]).toBe(100) // capped at maxBackoffMs
    expect(delays[5]).toBe(100)
  })

  test('successful reopen resets the retry counter', () => {
    const r = makeClient()
    r.client.connect(); createdSockets[0].fireOpen()
    // Bounce twice
    createdSockets[0].fireClose(1006, 'glitch')
    runTimers()
    createdSockets[1].fireClose(1006, 'glitch')
    runTimers()
    // Retry count should be 2 → next delay = 40
    createdSockets[2].fireOpen() // success → counter resets
    createdSockets[2].fireClose(1006, 'glitch')
    expect(scheduledTimers[scheduledTimers.length - 1].ms).toBe(10)
  })

  test('dispose cancels any pending reconnect', () => {
    const r = makeClient()
    r.client.connect(); createdSockets[0].fireOpen()
    createdSockets[0].fireClose(1006, 'glitch')
    expect(scheduledTimers[0].cancelled).toBe(false)
    r.client.dispose()
    expect(scheduledTimers[0].cancelled).toBe(true)
  })
})

describe('PtyClient — error surface', () => {
  test('factory throw → onError + scheduled reconnect', () => {
    const r = makeClient({
      wsFactory: () => { throw new Error('CSP blocked') },
    })
    r.client.connect()
    expect(r.errors).toEqual(['CSP blocked'])
    expect(scheduledTimers).toHaveLength(1)
  })

  test('ws error event surfaces to onError', () => {
    const r = makeClient()
    r.client.connect()
    createdSockets[0].fireError()
    expect(r.errors).toEqual(['pty-client: websocket error'])
  })
})
