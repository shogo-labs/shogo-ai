// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * DesktopPtyClient — IPC-backed counterpart of the WS-backed PtyClient.
 *
 * Same public shape as `apps/mobile/.../terminal/pty-client.ts#PtyClient`
 * so it drops in behind the existing `pty-factory.ts` seam with zero
 * changes to Terminal.tsx, XtermSession, or the React layer.
 *
 * Differences vs the WS client:
 *   - Data plane is a `MessagePort` (transferred from main), not a `WebSocket`.
 *   - Connect = call `bridge.attach(sessionId, sinceSeq)` to obtain the port
 *     + replay metadata. No URL.
 *   - Reconnect on data-port close still uses ?since=lastSeq semantics —
 *     but the "request" is another `bridge.attach()` call, not a URL.
 *   - Suppresses reconnect on the same close-reason set the WS client uses,
 *     plus any control event reporting `session:exit`/`session:reap`.
 *
 * Wire framing is identical (uses `@shogo/pty-core`'s binary protocol).
 * Same DATA / EXIT / TRUNC frames in both directions.
 */

import {
  decodeServerFrame,
  encodeClientData,
  encodeClientAck,
  encodeClientResize,
  encodeClientSignal,
  ServerFrameType,
  type ServerFrame,
  DESKTOP_TERMINAL_CLOSE_REASONS,
  type SessionInfo,
  type SpawnOptions,
} from '@shogo/pty-core'
import {
  getDesktopBridge,
  type MessagePortLike,
  type ShogoDesktopTerminalBridge,
} from './desktop-features'

export type PtyClientState = 'idle' | 'connecting' | 'open' | 'closed' | 'disposed'

export interface DesktopPtyClientOptions {
  sessionId: string
  /** Inject bridge (test only). Defaults to globalThis.shogoDesktopTerminal. */
  bridge?: ShogoDesktopTerminalBridge
  /** Min reconnect delay (ms). Default 100 — IPC is local. */
  minBackoffMs?: number
  /** Max reconnect delay (ms). Default 2000 — IPC is local. */
  maxBackoffMs?: number
  /** Used for reconnect timers; overridable for tests. */
  setTimeout?: (cb: () => void, ms: number) => unknown
  clearTimeout?: (id: unknown) => void
  /** Reasons that should NOT trigger a reconnect. */
  terminalCloseReasons?: ReadonlyArray<string>
}

export type DesktopPtySpawnOptions = SpawnOptions & {
  bridge?: ShogoDesktopTerminalBridge
}

export interface PtyClientListeners {
  onState?: (state: PtyClientState) => void
  onData?: (bytes: Uint8Array) => void
  onExit?: (info: { code: number | null; signal: string | null }) => void
  onTruncated?: () => void
  onError?: (err: Error) => void
}

type Unsubscribe = () => void
type StateListener = (s: PtyClientState) => void
type DataListener = (b: Uint8Array) => void
type ExitListener = (info: { code: number | null; signal: string | null }) => void
type TruncListener = () => void
type ErrorListener = (e: Error) => void

const TEXT_ENC = new TextEncoder()

function transferableBuffer(frame: Uint8Array): ArrayBuffer {
  return frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer
}

export class DesktopPtyClient {
  private readonly sessionId: string
  private readonly bridge: ShogoDesktopTerminalBridge
  private readonly minBackoff: number
  private readonly maxBackoff: number
  private readonly terminalReasons: ReadonlySet<string>
  private readonly setTimeoutFn: (cb: () => void, ms: number) => unknown
  private readonly clearTimeoutFn: (id: unknown) => void

  private stateListeners = new Set<StateListener>()
  private dataListeners = new Set<DataListener>()
  private exitListeners = new Set<ExitListener>()
  private truncListeners = new Set<TruncListener>()
  private errorListeners = new Set<ErrorListener>()

  private port: MessagePortLike | null = null
  private channelId: string | null = null
  private _state: PtyClientState = 'idle'
  private lastSeq = 0
  private retryCount = 0
  private reconnectTimer: unknown = null
  private offEvent: (() => void) | null = null
  /** Locks `connect()` against concurrent attach calls. */
  private connecting = false
  /** Set when a control event (session:exit / session:reap / no-session)
   * tells us reconnect is pointless. */
  private suppressReconnect = false
  /** Bound for `port.removeEventListener`. */
  private readonly handlePortMessage = (ev: { data: ArrayBuffer | Uint8Array }) => {
    const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : ev.data
    const frame = decodeServerFrame(buf)
    if (!frame) return
    this.handleFrame(frame)
  }

  constructor(opts: DesktopPtyClientOptions, initial: PtyClientListeners = {}) {
    this.sessionId = opts.sessionId
    this.bridge = opts.bridge ?? getDesktopBridge()
    this.minBackoff = opts.minBackoffMs ?? 100
    this.maxBackoff = opts.maxBackoffMs ?? 2_000
    this.terminalReasons = new Set(opts.terminalCloseReasons ?? DESKTOP_TERMINAL_CLOSE_REASONS)
    this.setTimeoutFn = opts.setTimeout ?? ((cb, ms) => setTimeout(cb, ms))
    this.clearTimeoutFn = opts.clearTimeout ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>))
    if (initial.onState) this.onState(initial.onState)
    if (initial.onData) this.onData(initial.onData)
    if (initial.onExit) this.onExit(initial.onExit)
    if (initial.onTruncated) this.onTruncated(initial.onTruncated)
    if (initial.onError) this.onError(initial.onError)

    // Subscribe to control events so we learn about exits/reaps that
    // didn't come over the data port (e.g. the host reaped us due to
    // idle timeout — the port closes before any EXIT frame).
    this.offEvent = this.bridge.onEvent((ev) => {
      if ('id' in ev && ev.id !== this.sessionId) return
      switch (ev.kind) {
        case 'session:exit':
          this.suppressReconnect = this.suppressReconnect || this.terminalReasons.has(ev.reason)
          this.emitExit({ code: ev.code, signal: ev.signal })
          this.markClosed()
          break
        case 'session:reap':
          this.suppressReconnect = this.suppressReconnect || this.terminalReasons.has(`pty:${ev.reason}`)
          this.emitExit({ code: null, signal: null })
          this.markClosed()
          break
      }
    })
  }

  get state(): PtyClientState { return this._state }
  get currentSeq(): number { return this.lastSeq }

  onState(cb: StateListener): Unsubscribe {
    this.stateListeners.add(cb)
    return () => this.stateListeners.delete(cb)
  }
  onData(cb: DataListener): Unsubscribe {
    this.dataListeners.add(cb)
    return () => this.dataListeners.delete(cb)
  }
  onExit(cb: ExitListener): Unsubscribe {
    this.exitListeners.add(cb)
    return () => this.exitListeners.delete(cb)
  }
  onTruncated(cb: TruncListener): Unsubscribe {
    this.truncListeners.add(cb)
    return () => this.truncListeners.delete(cb)
  }
  onError(cb: ErrorListener): Unsubscribe {
    this.errorListeners.add(cb)
    return () => this.errorListeners.delete(cb)
  }

  connect(): void {
    if (this._state === 'disposed') return
    if (this._state === 'open' || this._state === 'connecting' || this.connecting) return
    this.cancelReconnect()
    this.setState('connecting')
    this.connecting = true
    void this.doAttach().finally(() => { this.connecting = false })
  }

  private async doAttach(): Promise<void> {
    try {
      const { port, channelId, latestSeq } = await this.bridge.attach(this.sessionId, this.lastSeq)
      if (this._state === 'disposed') {
        try { port.close() } catch { /* swallow */ }
        return
      }
      this.port = port
      this.channelId = channelId
      // The host replays scrollback up to latestSeq via DATA frames on the
      // port BEFORE this point in the protocol (replay-then-subscribe is
      // a server-side invariant — see pty-host.ts § Phase 1). For Phase 2
      // we accept that the replay arrives in the same MessagePort queue.
      port.addEventListener('message', this.handlePortMessage)
      port.start?.()
      this.retryCount = 0
      // We're already up to date through latestSeq (the server will only
      // send seqs > sinceSeq). lastSeq updates as DATA frames arrive.
      void latestSeq
      this.setState('open')
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      this.emitError(e)
      this.markClosed()
      this.scheduleReconnect()
    }
  }

  send(bytes: Uint8Array | string): void {
    if (this._state !== 'open' || !this.port) return
    const payload = typeof bytes === 'string' ? TEXT_ENC.encode(bytes) : bytes
    const frame = encodeClientData(payload)
    this.port.postMessage(transferableBuffer(frame))
  }

  resize(cols: number, rows: number): void {
    if (this._state !== 'open' || !this.port) return
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return
    if (cols < 1 || rows < 1 || cols > 0xffff || rows > 0xffff) return
    const frame = encodeClientResize(cols, rows)
    this.port.postMessage(transferableBuffer(frame))
  }

  signal(sig: 'INT' | 'TERM' | 'KILL'): void {
    if (this._state !== 'open' || !this.port) return
    const frame = encodeClientSignal(sig)
    this.port.postMessage(transferableBuffer(frame))
  }

  dispose(): void {
    if (this._state === 'disposed') return
    this.setState('disposed')
    this.cancelReconnect()
    if (this.offEvent) { try { this.offEvent() } catch { /* swallow */ } this.offEvent = null }
    if (this.port) {
      try { this.port.removeEventListener('message', this.handlePortMessage) } catch { /* swallow */ }
      try { this.port.close() } catch { /* swallow */ }
      this.port = null
    }
    if (this.channelId) {
      void this.bridge.detach(this.sessionId, this.channelId).catch(() => { /* host might be gone */ })
      this.channelId = null
    }
  }

  // ─── internals ─────────────────────────────────────────────────────

  private handleFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case ServerFrameType.DATA: {
        if (frame.seq > this.lastSeq) this.lastSeq = frame.seq
        this.sendAck(this.lastSeq)
        for (const cb of [...this.dataListeners]) {
          try { cb(frame.bytes) } catch { /* swallow */ }
        }
        return
      }
      case ServerFrameType.EXIT: {
        // EXIT frames carry a reason the WS client encodes into a close
        // code; here we surface it via the bridge.onEvent stream instead,
        // but we still emit the user-facing onExit.
        this.suppressReconnect = true
        this.emitExit({ code: frame.code, signal: frame.signal })
        this.markClosed()
        return
      }
      case ServerFrameType.TRUNC: {
        for (const cb of [...this.truncListeners]) {
          try { cb() } catch { /* swallow */ }
        }
        return
      }
    }
  }

  private emitExit(info: { code: number | null; signal: string | null }): void {
    for (const cb of [...this.exitListeners]) {
      try { cb(info) } catch { /* swallow */ }
    }
  }

  private sendAck(seq: number): void {
    if (!this.port || this._state !== 'open') return
    const frame = encodeClientAck(seq)
    try { this.port.postMessage(transferableBuffer(frame)) } catch { /* port closed */ }
  }

  private emitError(e: Error): void {
    for (const cb of [...this.errorListeners]) {
      try { cb(e) } catch { /* swallow */ }
    }
  }

  private setState(s: PtyClientState): void {
    if (this._state === s) return
    this._state = s
    for (const cb of [...this.stateListeners]) {
      try { cb(s) } catch { /* swallow */ }
    }
  }

  private markClosed(): void {
    if (this._state === 'disposed') return
    if (this.port) {
      try { this.port.removeEventListener('message', this.handlePortMessage) } catch { /* swallow */ }
      try { this.port.close() } catch { /* swallow */ }
      this.port = null
    }
    if (this._state !== 'closed') this.setState('closed')
  }

  private scheduleReconnect(): void {
    if (this._state === 'disposed' || this.suppressReconnect) return
    this.cancelReconnect()
    this.retryCount += 1
    const delay = Math.min(this.maxBackoff, this.minBackoff * 2 ** (this.retryCount - 1))
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null
      if (this._state === 'disposed' || this.suppressReconnect) return
      // Reset to idle so connect() proceeds.
      this._state = 'idle'
      this.connect()
    }, delay)
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      this.clearTimeoutFn(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}

/**
 * The factory the renderer-side `pty-factory.ts` calls via lazy import.
 * Signature kept simple — one sessionId, the bridge auto-detected.
 */
export function createDesktopPtyClient(sessionId: string): DesktopPtyClient {
  return new DesktopPtyClient({ sessionId })
}

/**
 * Spawn a pty-host session and return an attach-capable client for it.
 * This is the desktop equivalent of the legacy REST POST + WebSocket setup.
 */
export async function spawnDesktopPtyClient(opts: DesktopPtySpawnOptions): Promise<{
  client: DesktopPtyClient
  session: SessionInfo
}> {
  const { bridge: injectedBridge, ...spawnOpts } = opts
  const bridge = injectedBridge ?? getDesktopBridge()
  const session = await bridge.spawn(spawnOpts)
  return {
    client: new DesktopPtyClient({ sessionId: session.id, bridge }),
    session,
  }
}
