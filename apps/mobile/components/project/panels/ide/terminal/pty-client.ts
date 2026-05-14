// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * PtyClient — thin WebSocket wrapper around the binary PTY protocol.
 *
 * Owns:
 *   - WS lifecycle (open / close / error)
 *   - Outbound encoding (write / resize / signal)
 *   - Inbound decoding + delivery to listeners
 *   - Resume bookkeeping: tracks the highest server seq seen so a
 *     reconnect can request `?since=N` and pick up where it left off
 *   - Exponential-backoff reconnect on unexpected close
 *
 * Does NOT own:
 *   - The session id (caller creates a session via REST first, then
 *     passes the id in)
 *   - xterm rendering (that's xterm-session.ts)
 *
 * State machine:
 *   idle → connecting → open → (closed → connecting → open)* → disposed
 *
 *   - "closed" with code 1000 ("pty:exited") or 4404 ("no-session") =
 *     terminal: don't auto-reconnect.
 *   - any other unexpected close = transient: schedule reconnect.
 */

import {
  ServerFrameType,
  decodeServerFrame,
  encodeClientData,
  encodeClientResize,
  encodeClientSignal,
  type ServerFrame,
} from './pty-protocol'

export type PtyClientState = 'idle' | 'connecting' | 'open' | 'closed' | 'disposed'

export interface PtyClientOptions {
  url: string
  /** Min reconnect delay (ms). Default 250. */
  minBackoffMs?: number
  /** Max reconnect delay (ms). Default 10_000. */
  maxBackoffMs?: number
  /** Stop reconnecting when the close reason matches one of these. */
  terminalCloseReasons?: ReadonlyArray<string>
  /** WS factory; tests pass a fake. Defaults to global WebSocket. */
  wsFactory?: (url: string) => WebSocket
  /** Used for reconnect timers; overridable for tests. */
  setTimeout?: (cb: () => void, ms: number) => unknown
  clearTimeout?: (id: unknown) => void
}

export interface PtyClientListeners {
  onState?: (state: PtyClientState) => void
  /** Fires for every server DATA chunk (after replay too). */
  onData?: (bytes: Uint8Array) => void
  /** Fires once when the server reports a clean exit. */
  onExit?: (info: { code: number | null; signal: string | null }) => void
  /** Fires when the server says it had to drop scrollback on replay. */
  onTruncated?: () => void
  onError?: (err: Error) => void
}

const TERMINAL_CLOSE_REASONS_DEFAULT: ReadonlyArray<string> = [
  'pty:exited',
  'pty:killed',
  'pty:max-age',
  'pty:idle',
  'pty:shutdown',
  'no-session',
]

const TERMINAL_CLOSE_CODES = new Set([4404]) // unknown session

type Unsubscribe = () => void
type StateListener = (s: PtyClientState) => void
type DataListener = (b: Uint8Array) => void
type ExitListener = (info: { code: number | null; signal: string | null }) => void
type TruncListener = () => void
type ErrorListener = (e: Error) => void

export class PtyClient {
  private readonly url: string
  private readonly minBackoff: number
  private readonly maxBackoff: number
  private readonly terminalReasons: ReadonlySet<string>
  private readonly wsFactory: (url: string) => WebSocket
  private readonly setTimeoutFn: (cb: () => void, ms: number) => unknown
  private readonly clearTimeoutFn: (id: unknown) => void

  // Per-event listener Sets so multiple consumers (xterm session + react
  // view + future tooling) can subscribe without clobbering each other.
  private stateListeners = new Set<StateListener>()
  private dataListeners = new Set<DataListener>()
  private exitListeners = new Set<ExitListener>()
  private truncListeners = new Set<TruncListener>()
  private errorListeners = new Set<ErrorListener>()

  private ws: WebSocket | null = null
  private _state: PtyClientState = 'idle'
  private lastSeq = 0
  private retryCount = 0
  private reconnectTimer: unknown = null

  constructor(opts: PtyClientOptions, initial: PtyClientListeners = {}) {
    this.url = opts.url
    this.minBackoff = opts.minBackoffMs ?? 250
    this.maxBackoff = opts.maxBackoffMs ?? 10_000
    this.terminalReasons = new Set(opts.terminalCloseReasons ?? TERMINAL_CLOSE_REASONS_DEFAULT)
    this.wsFactory = opts.wsFactory ?? ((u) => new WebSocket(u))
    this.setTimeoutFn = opts.setTimeout ?? ((cb, ms) => setTimeout(cb, ms))
    this.clearTimeoutFn = opts.clearTimeout ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>))
    if (initial.onState) this.onState(initial.onState)
    if (initial.onData) this.onData(initial.onData)
    if (initial.onExit) this.onExit(initial.onExit)
    if (initial.onTruncated) this.onTruncated(initial.onTruncated)
    if (initial.onError) this.onError(initial.onError)
  }

  get state(): PtyClientState { return this._state }
  /** Latest seq we've received — useful for tests + telemetry. */
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
    if (this._state === 'open' || this._state === 'connecting') return
    this.cancelReconnect()
    this.setState('connecting')
    const url = this.lastSeq > 0
      ? `${this.url}${this.url.includes('?') ? '&' : '?'}since=${this.lastSeq}`
      : this.url
    let ws: WebSocket
    try {
      ws = this.wsFactory(url)
    } catch (err: any) {
      this.emitError(err instanceof Error ? err : new Error(String(err)))
      this.scheduleReconnect()
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.addEventListener('open', () => {
      if (this._state === 'disposed') { try { ws.close() } catch {} ; return }
      this.retryCount = 0
      this.setState('open')
    })
    ws.addEventListener('message', (ev) => this.handleMessage(ev))
    ws.addEventListener('error', (ev) => {
      this.emitError(new Error('pty-client: websocket error'))
      // Don't change state here; the close event always follows.
      void ev
    })
    ws.addEventListener('close', (ev) => this.handleClose(ev.code, ev.reason))
  }

  /** Send raw bytes (keystrokes) to the PTY. No-op when not open. */
  send(bytes: Uint8Array | string): void {
    if (this._state !== 'open' || !this.ws) return
    const payload = typeof bytes === 'string'
      ? new TextEncoder().encode(bytes)
      : bytes
    this.ws.send(encodeClientData(payload))
  }

  resize(cols: number, rows: number): void {
    if (this._state !== 'open' || !this.ws) return
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return
    if (cols < 1 || rows < 1 || cols > 0xffff || rows > 0xffff) return
    this.ws.send(encodeClientResize(cols, rows))
  }

  signal(sig: 'INT' | 'TERM' | 'KILL'): void {
    if (this._state !== 'open' || !this.ws) return
    this.ws.send(encodeClientSignal(sig))
  }

  /** Tear down. Stops reconnects; closes the socket if open. Idempotent. */
  dispose(): void {
    if (this._state === 'disposed') return
    this.setState('disposed')
    this.cancelReconnect()
    if (this.ws) {
      try { this.ws.close(1000, 'client-dispose') } catch {}
      this.ws = null
    }
  }

  // ─── internals ─────────────────────────────────────────────────────

  private setState(s: PtyClientState): void {
    if (this._state === s) return
    this._state = s
    for (const cb of [...this.stateListeners]) {
      try { cb(s) } catch {}
    }
  }

  private emitError(e: Error): void {
    for (const cb of [...this.errorListeners]) {
      try { cb(e) } catch {}
    }
  }

  private handleMessage(ev: MessageEvent): void {
    const data = ev.data
    let buf: Uint8Array
    if (data instanceof ArrayBuffer) buf = new Uint8Array(data)
    else if (data instanceof Uint8Array) buf = data
    else if (typeof data === 'string') {
      // Server should never send text frames in this protocol; ignore.
      return
    } else {
      return
    }
    const frame = decodeServerFrame(buf)
    if (!frame) return
    this.deliver(frame)
  }

  private deliver(frame: ServerFrame): void {
    switch (frame.type) {
      case ServerFrameType.DATA:
        // Track seq for reconnect-replay. Ignore frames from the past
        // (could happen if a transient WS produces overlapping replays).
        if (frame.seq > this.lastSeq) this.lastSeq = frame.seq
        for (const cb of [...this.dataListeners]) {
          try { cb(frame.bytes) } catch {}
        }
        break
      case ServerFrameType.EXIT:
        for (const cb of [...this.exitListeners]) {
          try { cb({ code: frame.code, signal: frame.signal }) } catch {}
        }
        break
      case ServerFrameType.TRUNC:
        for (const cb of [...this.truncListeners]) {
          try { cb() } catch {}
        }
        break
    }
  }

  private handleClose(code: number, reason: string): void {
    this.ws = null
    if (this._state === 'disposed') return
    this.setState('closed')
    if (this.terminalReasons.has(reason) || TERMINAL_CLOSE_CODES.has(code)) {
      // Server says the session is gone for good. Don't retry.
      return
    }
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this._state === 'disposed') return
    const delay = Math.min(
      this.maxBackoff,
      this.minBackoff * Math.pow(2, this.retryCount),
    )
    this.retryCount += 1
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer != null) {
      this.clearTimeoutFn(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}
