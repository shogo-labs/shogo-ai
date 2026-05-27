// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for DesktopPtyClient — the IPC-port-backed counterpart to PtyClient.
 *
 * We stub `shogoDesktopTerminal` with a fake bridge whose `attach()`
 * returns a `FakePort`. The test drives both sides:
 *   - Server-side: push DATA / EXIT / TRUNC frames into the port to verify
 *     the client surfaces them via onData / onExit / onTruncated.
 *   - Client-side: call send/resize/signal and decode what the port saw.
 *
 * Mirrors the assertions structure of the WS-backed PtyClient tests so
 * Terminal.tsx can trust both transports interchangeably.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import {
  ClientFrameType,
  decodeClientFrame,
  encodeServerData,
  encodeServerExit,
  encodeServerTrunc,
} from '@shogo/pty-core'
import {
  DesktopPtyClient,
  type DesktopPtyClientOptions,
} from '../desktop-pty-client'
import type {
  ControlEvent,
  ShogoDesktopTerminalBridge,
  MessagePortLike,
} from '../desktop-features'

// ─── fake MessagePort ──────────────────────────────────────────────────

class FakePort implements MessagePortLike {
  sent: Uint8Array[] = []
  closed = false
  started = false
  listeners = new Set<(ev: { data: ArrayBuffer | Uint8Array }) => void>()
  postMessage(message: ArrayBuffer | Uint8Array) {
    if (this.closed) return
    const u8 = message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(message)
    this.sent.push(u8)
  }
  addEventListener(_t: 'message', l: (ev: { data: ArrayBuffer | Uint8Array }) => void) {
    this.listeners.add(l)
  }
  removeEventListener(_t: 'message', l: (ev: { data: ArrayBuffer | Uint8Array }) => void) {
    this.listeners.delete(l)
  }
  start() { this.started = true }
  close() { this.closed = true; this.listeners.clear() }
  // Test helper: simulate the host pushing a frame to the renderer.
  _deliver(frame: Uint8Array) {
    for (const l of this.listeners) l({ data: frame })
  }
}

// ─── fake bridge ───────────────────────────────────────────────────────

interface FakeBridge extends ShogoDesktopTerminalBridge {
  ports: FakePort[]
  attachCalls: { id: string; sinceSeq: number }[]
  detachCalls: { id: string; channelId: string }[]
  eventListeners: ((ev: ControlEvent) => void)[]
  _fire(ev: ControlEvent): void
  _failNextAttach: Error | null
}

function makeBridge(): FakeBridge {
  const ports: FakePort[] = []
  const attachCalls: { id: string; sinceSeq: number }[] = []
  const detachCalls: { id: string; channelId: string }[] = []
  const eventListeners: ((ev: ControlEvent) => void)[] = []
  const bridge: FakeBridge = {
    spawn: async () => { throw new Error('spawn not used in this suite') },
    write: async () => {},
    resize: async () => {},
    signal: async () => {},
    kill: async () => {},
    list: async () => [],
    async attach(id, sinceSeq) {
      attachCalls.push({ id, sinceSeq })
      if (bridge._failNextAttach) {
        const err = bridge._failNextAttach
        bridge._failNextAttach = null
        throw err
      }
      const port = new FakePort()
      ports.push(port)
      return { port, channelId: `ch-${ports.length}`, latestSeq: sinceSeq }
    },
    async detach(id, channelId) { detachCalls.push({ id, channelId }) },
    onEvent(cb) {
      eventListeners.push(cb)
      return () => {
        const i = eventListeners.indexOf(cb)
        if (i >= 0) eventListeners.splice(i, 1)
      }
    },
    ports,
    attachCalls,
    detachCalls,
    eventListeners,
    _failNextAttach: null,
    _fire(ev) { for (const l of [...eventListeners]) l(ev) },
  }
  return bridge
}

// ─── helpers ───────────────────────────────────────────────────────────

function makeClient(bridge: FakeBridge, overrides: Partial<DesktopPtyClientOptions> = {}) {
  return new DesktopPtyClient({
    sessionId: 'sess-1',
    bridge,
    minBackoffMs: 1,
    maxBackoffMs: 4,
    setTimeout: ((cb: () => void) => { Promise.resolve().then(cb); return 0 }) as DesktopPtyClientOptions['setTimeout'],
    clearTimeout: (() => {}) as DesktopPtyClientOptions['clearTimeout'],
    ...overrides,
  })
}

async function flush(ms = 0): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

// ─── tests ─────────────────────────────────────────────────────────────

describe('DesktopPtyClient', () => {
  let bridge: FakeBridge
  beforeEach(() => { bridge = makeBridge() })

  it('connect → attach is called with sinceSeq=0 first time, transitions to open', async () => {
    const states: string[] = []
    const c = makeClient(bridge)
    c.onState((s) => states.push(s))
    c.connect()
    await flush()
    expect(bridge.attachCalls).toEqual([{ id: 'sess-1', sinceSeq: 0 }])
    expect(states).toContain('connecting')
    expect(states).toContain('open')
    expect(c.state).toBe('open')
    expect(bridge.ports[0].started).toBe(true)
  })

  it('onData fires for inbound DATA frames and lastSeq tracks the highest seq', async () => {
    const c = makeClient(bridge)
    const chunks: Uint8Array[] = []
    c.onData((b) => chunks.push(b))
    c.connect()
    await flush()
    bridge.ports[0]._deliver(encodeServerData(1, new TextEncoder().encode('hello')))
    bridge.ports[0]._deliver(encodeServerData(2, new TextEncoder().encode(' world')))
    expect(chunks.length).toBe(2)
    expect(new TextDecoder().decode(chunks[0])).toBe('hello')
    expect(new TextDecoder().decode(chunks[1])).toBe(' world')
    expect(c.currentSeq).toBe(2)
  })

  it('onTruncated fires on TRUNC frame', async () => {
    const c = makeClient(bridge)
    let trunced = 0
    c.onTruncated(() => { trunced++ })
    c.connect()
    await flush()
    bridge.ports[0]._deliver(encodeServerTrunc())
    expect(trunced).toBe(1)
  })

  it('EXIT frame surfaces onExit, marks closed, suppresses reconnect', async () => {
    const c = makeClient(bridge)
    const exits: { code: number | null; signal: string | null }[] = []
    c.onExit((info) => exits.push(info))
    c.connect()
    await flush()
    bridge.ports[0]._deliver(encodeServerExit(0, null, 'pty:exited'))
    expect(exits).toEqual([{ code: 0, signal: null }])
    expect(c.state).toBe('closed')
    expect(bridge.ports[0].closed).toBe(true)
    // Wait to confirm no reconnect attempt occurred.
    await flush(10)
    expect(bridge.attachCalls.length).toBe(1)
  })

  it('send / resize / signal encode the right client frames', async () => {
    const c = makeClient(bridge)
    c.connect()
    await flush()
    c.send('echo hi\r')
    c.resize(120, 40)
    c.signal('INT')
    const port = bridge.ports[0]
    expect(port.sent.length).toBe(3)
    const f1 = decodeClientFrame(port.sent[0])
    const f2 = decodeClientFrame(port.sent[1])
    const f3 = decodeClientFrame(port.sent[2])
    expect(f1?.type).toBe(ClientFrameType.DATA)
    if (f1?.type === ClientFrameType.DATA) {
      expect(new TextDecoder().decode(f1.bytes)).toBe('echo hi\r')
    }
    expect(f2?.type).toBe(ClientFrameType.RESIZE)
    if (f2?.type === ClientFrameType.RESIZE) {
      expect(f2.cols).toBe(120)
      expect(f2.rows).toBe(40)
    }
    expect(f3?.type).toBe(ClientFrameType.SIGNAL)
    if (f3?.type === ClientFrameType.SIGNAL) {
      expect(f3.signal).toBe('INT')
    }
  })

  it('writes are dropped when not in open state', async () => {
    const c = makeClient(bridge)
    // never connect
    c.send('zzz')
    c.resize(1, 1)
    c.signal('INT')
    expect(bridge.ports.length).toBe(0)
  })

  it('reconnect carries lastSeq as sinceSeq on second attach', async () => {
    const c = makeClient(bridge)
    c.connect()
    await flush()
    expect(c.currentSeq).toBe(0)
    bridge.ports[0]._deliver(encodeServerData(7, new Uint8Array([0x41])))
    expect(c.currentSeq).toBe(7)
    bridge.ports[0]._deliver(encodeServerData(12, new Uint8Array([0x42])))
    expect(c.currentSeq).toBe(12)
    // Out-of-order DATA must NOT regress lastSeq — invariant the WS
    // client relies on for reconnect-with-since correctness.
    bridge.ports[0]._deliver(encodeServerData(5, new Uint8Array([0x43])))
    expect(c.currentSeq).toBe(12)
    expect(bridge.attachCalls[0].sinceSeq).toBe(0)
  })

  it('control event session:exit suppresses reconnect even before EXIT frame', async () => {
    const c = makeClient(bridge)
    const exits: { code: number | null; signal: string | null }[] = []
    c.onExit((info) => exits.push(info))
    c.connect()
    await flush()
    // Host reaps the session — control event fires before any EXIT frame.
    bridge._fire({
      kind: 'session:exit',
      id: 'sess-1',
      code: null,
      signal: null,
      reason: 'pty:idle',
    })
    expect(exits).toEqual([{ code: null, signal: null }])
    expect(c.state).toBe('closed')
    await flush(10)
    // No second attach.
    expect(bridge.attachCalls.length).toBe(1)
  })

  it('control event for a DIFFERENT session is ignored', async () => {
    const c = makeClient(bridge)
    const exits: unknown[] = []
    c.onExit((info) => exits.push(info))
    c.connect()
    await flush()
    bridge._fire({
      kind: 'session:exit',
      id: 'some-other-session',
      code: 0,
      signal: null,
      reason: 'pty:exited',
    })
    expect(exits.length).toBe(0)
    expect(c.state).toBe('open')
  })

  it('attach failure schedules a reconnect with exponential backoff', async () => {
    bridge._failNextAttach = new Error('attach failed')
    let lastTimeout = -1
    const c = makeClient(bridge, {
      setTimeout: ((cb: () => void, ms: number) => {
        lastTimeout = ms
        // Don't auto-fire — just record the delay.
        return 0
      }) as DesktopPtyClientOptions['setTimeout'],
    })
    const errors: Error[] = []
    c.onError((e) => errors.push(e))
    c.connect()
    await flush()
    expect(errors.length).toBe(1)
    expect(errors[0].message).toContain('attach failed')
    expect(c.state).toBe('closed')
    expect(lastTimeout).toBeGreaterThan(0)
  })

  it('dispose closes the port, unsubscribes events, calls bridge.detach', async () => {
    const c = makeClient(bridge)
    c.connect()
    await flush()
    expect(bridge.eventListeners.length).toBe(1)
    c.dispose()
    expect(c.state).toBe('disposed')
    expect(bridge.ports[0].closed).toBe(true)
    expect(bridge.eventListeners.length).toBe(0)
    await flush()
    expect(bridge.detachCalls).toEqual([{ id: 'sess-1', channelId: 'ch-1' }])
  })

  it('dispose is idempotent', async () => {
    const c = makeClient(bridge)
    c.connect()
    await flush()
    c.dispose()
    c.dispose()
    c.dispose()
    expect(c.state).toBe('disposed')
  })

  it('two simultaneous connect() calls are deduped', async () => {
    const c = makeClient(bridge)
    c.connect()
    c.connect()
    c.connect()
    await flush()
    expect(bridge.attachCalls.length).toBe(1)
  })
})
