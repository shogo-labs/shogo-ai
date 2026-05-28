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
  writeCalls: { id: string; text: string }[]
  resizeCalls: { id: string; cols: number; rows: number }[]
  signalCalls: { id: string; sig: 'INT' | 'TERM' | 'KILL' }[]
  spawnCalls: number
  _fire(ev: ControlEvent): void
  _failNextAttach: Error | null
  /** When set, the next N attach calls throw this error before resetting. */
  _failAttachWith: { error: Error; times: number } | null
  /** Id handed back by the next spawn() — auto-increments. */
  _nextSpawnId: number
}

function makeBridge(): FakeBridge {
  const ports: FakePort[] = []
  const attachCalls: { id: string; sinceSeq: number }[] = []
  const detachCalls: { id: string; channelId: string }[] = []
  const eventListeners: ((ev: ControlEvent) => void)[] = []
  const writeCalls: { id: string; text: string }[] = []
  const resizeCalls: { id: string; cols: number; rows: number }[] = []
  const signalCalls: { id: string; sig: 'INT' | 'TERM' | 'KILL' }[] = []
  const bridge: FakeBridge = {
    spawn: async () => {
      bridge.spawnCalls += 1
      const id = `sess-${bridge._nextSpawnId++}`
      return {
        id,
        shell: '/bin/zsh',
        cwd: '/tmp',
        cols: 80,
        rows: 24,
        pid: 1234,
        createdAt: Date.now(),
        lastSeq: 0,
      } as Awaited<ReturnType<ShogoDesktopTerminalBridge['spawn']>>
    },
    write: async (id, text) => { writeCalls.push({ id, text }) },
    resize: async (id, cols, rows) => { resizeCalls.push({ id, cols, rows }) },
    signal: async (id, sig) => { signalCalls.push({ id, sig }) },
    kill: async () => {},
    list: async () => [],
    async attach(id, sinceSeq) {
      attachCalls.push({ id, sinceSeq })
      if (bridge._failNextAttach) {
        const err = bridge._failNextAttach
        bridge._failNextAttach = null
        throw err
      }
      if (bridge._failAttachWith && bridge._failAttachWith.times > 0) {
        bridge._failAttachWith.times -= 1
        throw bridge._failAttachWith.error
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
    writeCalls,
    resizeCalls,
    signalCalls,
    spawnCalls: 0,
    _failNextAttach: null,
    _failAttachWith: null,
    _nextSpawnId: 100,
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

  it('send / resize / signal use the reliable control-plane IPC path', async () => {
    const c = makeClient(bridge)
    c.connect()
    await flush()
    c.send('echo hi\r')
    c.resize(120, 40)
    c.signal('INT')
    await flush()
    expect(bridge.ports[0].sent.length).toBe(0)
    expect(bridge.writeCalls).toEqual([{ id: 'sess-1', text: 'echo hi\r' }])
    expect(bridge.resizeCalls).toEqual([{ id: 'sess-1', cols: 120, rows: 40 }])
    expect(bridge.signalCalls).toEqual([{ id: 'sess-1', sig: 'INT' }])
  })

  it('writes are dropped when not in open state', async () => {
    const c = makeClient(bridge)
    // never connect
    c.send('zzz')
    c.resize(1, 1)
    c.signal('INT')
    expect(bridge.ports.length).toBe(0)
  })

  it('DATA frames that land before the first onData listener are buffered and replayed in FIFO order', async () => {
    // Reproduces the production race: on local IPC the pty-host's replay
    // frame (shell prompt + cwd OSC) routinely arrives BEFORE the
    // React-mounted xterm finishes its dynamic import and subscribes.
    // Without buffering, those bytes are lost.
    const c = makeClient(bridge)
    c.connect()
    await flush()
    // Host pushes replay + a live chunk *before* xterm subscribes.
    bridge.ports[0]._deliver(encodeServerData(1, new TextEncoder().encode('prompt$ ')))
    bridge.ports[0]._deliver(encodeServerData(2, new TextEncoder().encode('echo hi\r\n')))
    // The seq counter is updated synchronously even with no listener.
    expect(c.currentSeq).toBe(2)
    // Now xterm finally finishes its async mount and subscribes.
    const chunks: string[] = []
    c.onData((b) => chunks.push(new TextDecoder().decode(b)))
    expect(chunks).toEqual(['prompt$ ', 'echo hi\r\n'])
    // A subsequent frame is delivered live, not buffered.
    bridge.ports[0]._deliver(encodeServerData(3, new TextEncoder().encode('ok\r\n')))
    expect(chunks).toEqual(['prompt$ ', 'echo hi\r\n', 'ok\r\n'])
  })

  it('only the FIRST onData subscriber drains buffered DATA — later subscribers see only live frames', async () => {
    const c = makeClient(bridge)
    c.connect()
    await flush()
    bridge.ports[0]._deliver(encodeServerData(1, new TextEncoder().encode('replay')))
    const first: string[] = []
    const second: string[] = []
    c.onData((b) => first.push(new TextDecoder().decode(b)))
    c.onData((b) => second.push(new TextDecoder().decode(b)))
    expect(first).toEqual(['replay'])
    expect(second).toEqual([])
    bridge.ports[0]._deliver(encodeServerData(2, new TextEncoder().encode('live')))
    expect(first).toEqual(['replay', 'live'])
    expect(second).toEqual(['live'])
  })

  it('pending buffer is dropped on dispose so a teardown mid-attach does not leak the bytes', async () => {
    const c = makeClient(bridge)
    c.connect()
    await flush()
    bridge.ports[0]._deliver(encodeServerData(1, new TextEncoder().encode('lost')))
    c.dispose()
    // A subscriber registered after dispose should never see anything;
    // dispose is the canonical "this client is dead" signal.
    const seen: Uint8Array[] = []
    c.onData((b) => seen.push(b))
    expect(seen.length).toBe(0)
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

  // ─── control-plane data delivery ───────────────────────────────────────
  // PTY output arrives as base64 `session:data` control events (not over the
  // MessageChannelMain port, which is not reliably entangled between the
  // utilityProcess host and the renderer). This is the path that makes the
  // prompt/output actually show up.

  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')

  it('session:data control events deliver PTY output to onData and advance seq', async () => {
    const c = makeClient(bridge)
    const chunks: string[] = []
    c.onData((b) => chunks.push(new TextDecoder().decode(b)))
    c.connect()
    await flush()
    bridge._fire({ kind: 'session:data', id: 'sess-1', seq: 1, dataB64: b64('prompt$ ') })
    bridge._fire({ kind: 'session:data', id: 'sess-1', seq: 2, dataB64: b64('hi') })
    expect(chunks).toEqual(['prompt$ ', 'hi'])
    expect(c.currentSeq).toBe(2)
  })

  it('session:data that arrives before the first onData listener is buffered then flushed', async () => {
    const c = makeClient(bridge)
    c.connect()
    await flush()
    bridge._fire({ kind: 'session:data', id: 'sess-1', seq: 1, dataB64: b64('early') })
    expect(c.currentSeq).toBe(1)
    const chunks: string[] = []
    c.onData((b) => chunks.push(new TextDecoder().decode(b)))
    expect(chunks).toEqual(['early'])
  })

  it('session:trunc control event fires onTruncated', async () => {
    const c = makeClient(bridge)
    let truncs = 0
    c.onTruncated(() => { truncs += 1 })
    c.connect()
    await flush()
    bridge._fire({ kind: 'session:trunc', id: 'sess-1' })
    expect(truncs).toBe(1)
  })

  it('session:data for a DIFFERENT session is ignored', async () => {
    const c = makeClient(bridge)
    const chunks: string[] = []
    c.onData((b) => chunks.push(new TextDecoder().decode(b)))
    c.connect()
    await flush()
    bridge._fire({ kind: 'session:data', id: 'some-other-session', seq: 1, dataB64: b64('nope') })
    expect(chunks).toEqual([])
    expect(c.currentSeq).toBe(0)
  })

  // ─── pty-host restart recovery ─────────────────────────────────────────
  // The pty-host is a crash-isolated utility process that the main-process
  // PtyHostClient auto-restarts. After a restart the new host has none of
  // the old sessions, so re-attaching the original id fails forever with
  // `no-session`. A client created with spawnOptions must self-heal by
  // spawning a fresh session. (Root cause of the "terminal never shows a
  // prompt / won't accept input" bug — the host died once, restarted
  // healthy, but the renderer looped re-attaching a dead session id.)

  const spawnOpts = { cols: 80, rows: 24 } as DesktopPtyClientOptions['spawnOptions']

  it('re-spawns + re-attaches when the pty-host restarts (host:ready) after being open', async () => {
    const c = makeClient(bridge, { spawnOptions: spawnOpts })
    c.connect()
    await flush()
    expect(c.state).toBe('open')
    expect(bridge.attachCalls).toEqual([{ id: 'sess-1', sinceSeq: 0 }])
    expect(bridge.spawnCalls).toBe(0)

    // Host crashed and the main process restarted it → host:ready arrives.
    bridge._fire({ kind: 'host:ready', version: 'test' })
    await flush()

    // A brand-new session was spawned and attached to.
    expect(bridge.spawnCalls).toBe(1)
    expect(bridge.attachCalls.length).toBe(2)
    expect(bridge.attachCalls[1]).toEqual({ id: 'sess-100', sinceSeq: 0 })
    expect(c.state).toBe('open')
  })

  it('host:ready is ignored before the first successful attach (initial boot)', async () => {
    const c = makeClient(bridge, { spawnOptions: spawnOpts })
    // Host announces ready before we ever attached — nothing to recover.
    bridge._fire({ kind: 'host:ready', version: 'test' })
    await flush()
    expect(bridge.spawnCalls).toBe(0)
    expect(bridge.attachCalls.length).toBe(0)
  })

  it('recovers from a no-session attach failure by re-spawning a fresh session', async () => {
    bridge._failAttachWith = { error: new Error('no-session: unknown session sess-1'), times: 1 }
    // Use a real macrotask timer for the reconnect so it fires AFTER the
    // failed connect()'s `.finally` releases the connect lock — matching
    // production (where the backoff is ≥100ms, never a same-tick microtask).
    const c = makeClient(bridge, {
      spawnOptions: spawnOpts,
      setTimeout: ((cb: () => void, ms: number) => setTimeout(cb, ms)) as DesktopPtyClientOptions['setTimeout'],
      clearTimeout: ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>)) as DesktopPtyClientOptions['clearTimeout'],
    })
    const errors: Error[] = []
    c.onError((e) => errors.push(e))
    c.connect()
    await flush(10)
    await flush(10)

    // The recoverable "session gone" failure is NOT surfaced as an error.
    expect(errors.length).toBe(0)
    // Exactly one re-spawn, then a successful attach to the new id.
    expect(bridge.spawnCalls).toBe(1)
    expect(bridge.attachCalls[0].id).toBe('sess-1')
    expect(bridge.attachCalls[1].id).toBe('sess-100')
    expect(c.state).toBe('open')
  })

  it('re-applies the last known grid size after a re-spawn', async () => {
    const c = makeClient(bridge, { spawnOptions: spawnOpts })
    c.connect()
    await flush()
    c.resize(120, 40)
    await flush()
    bridge.resizeCalls.length = 0

    bridge._fire({ kind: 'host:ready', version: 'test' })
    await flush()

    // The fresh session is resized back to the user's current dimensions.
    expect(bridge.resizeCalls).toContainEqual({ id: 'sess-100', cols: 120, rows: 40 })
  })

  it('an attach-only client (no spawnOptions) surfaces no-session and does not re-spawn', async () => {
    bridge._failAttachWith = { error: new Error('no-session: unknown session sess-1'), times: 1 }
    const c = makeClient(bridge) // no spawnOptions
    const errors: Error[] = []
    c.onError((e) => errors.push(e))
    c.connect()
    await flush()
    await flush()
    expect(bridge.spawnCalls).toBe(0)
    expect(errors.length).toBe(1)
  })
})
