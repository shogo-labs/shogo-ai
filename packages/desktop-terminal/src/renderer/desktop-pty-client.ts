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
  encodeClientAck,
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
  /**
   * Recipe to re-spawn this session from scratch.
   *
   * The pty-host is a crash-isolated utility process that `PtyHostClient`
   * auto-restarts. After a restart the new host has NONE of the previous
   * sessions, so re-attaching the original `sessionId` fails forever with
   * `no-session`. When `spawnOptions` is supplied the client recovers by
   * spawning a FRESH session on the live host (updating `sessionId`) and
   * attaching to that: exactly how a real terminal host survives a host
   * crash. Omit it for attach-only clients (nothing to re-spawn).
   */
  spawnOptions?: SpawnOptions
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

const TEXT_DEC = new TextDecoder()

function transferableBuffer(frame: Uint8Array): ArrayBuffer {
  return frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer
}

/**
 * Decode a base64 `session:data` payload back into raw bytes. `atob` is
 * available in the Electron renderer (and in the bun test runtime); it maps
 * each base64 octet to a latin1 char whose code point is the original byte.
 */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}

export class DesktopPtyClient {
  private sessionId: string
  private readonly bridge: ShogoDesktopTerminalBridge
  private readonly spawnOptions?: SpawnOptions
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

  /**
   * Replay DATA frames that arrived BEFORE any `onData` listener was
   * attached. Local IPC is fast enough that the pty-host's replay frame
   * (shell prompt + cwd OSC) routinely lands on the renderer's
   * `MessagePort` queue before `XtermView` finishes the dynamic
   * `import('@xterm/xterm')` and subscribes. Without this buffer those
   * bytes are fanned out to an empty Set and lost forever, so the user
   * sees a blinking but empty cell with no prompt and no cwd update.
   *
   * Bounded at `MAX_PENDING_BYTES` so a runaway shell can't grow the
   * renderer heap before the listener attaches. If we exceed the cap,
   * we drop the OLDEST chunks first (newest output is what the user
   * cares about most). Chunks are flushed in FIFO order on first
   * `onData(...)` subscribe and then the buffer is cleared.
   */
  private pendingData: Uint8Array[] = []
  private pendingDataBytes = 0
  private static readonly MAX_PENDING_BYTES = 1 << 20 // 1 MiB

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
  /** True once we've reached `open` at least once. Distinguishes a host
   * restart MID-session (recover by re-spawning) from the very first boot
   * (nothing to recover yet). */
  private everOpened = false
  /** Set when we learn our host-side session no longer exists (host
   * crashed/restarted, or a `no-session` attach error). The next connect
   * attempt re-spawns a fresh session before attaching. */
  private sessionGone = false
  /** Last terminal grid size seen via resize() — re-applied after a
   * (re)attach so a re-spawned shell starts at the correct dimensions. */
  private lastCols = 0
  private lastRows = 0
  private readonly handlePortMessage = (ev: { data: ArrayBuffer | Uint8Array }) => {
    // Defensive: some Electron builds dispatch transient message events
    // with an undefined payload (close/error sentinel). Drop them rather
    // than letting decodeServerFrame crash on `.byteLength`.
    const raw: ArrayBuffer | Uint8Array | undefined = ev?.data
    if (raw == null) return
    const buf = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw
    const frame = decodeServerFrame(buf)
    if (!frame) {
      // eslint-disable-next-line no-console
      console.warn('[shogo-pty-client] decodeServerFrame returned null for', buf.byteLength, 'byte msg')
      return
    }
    this.handleFrame(frame)
  }

  constructor(opts: DesktopPtyClientOptions, initial: PtyClientListeners = {}) {
    this.sessionId = opts.sessionId
    this.bridge = opts.bridge ?? getDesktopBridge()
    this.spawnOptions = opts.spawnOptions
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
      // `host:ready` / `host:beat` / etc. carry no session id and must NOT
      // be filtered by the per-session guard below.
      if ('id' in ev && ev.id !== this.sessionId) return
      switch (ev.kind) {
        case 'session:data':
          // Live PTY output over the control plane (see desktop-protocol.ts).
      // This is the primary data path: the MessageChannelMain data port
      // is not reliably entangled across the utilityProcess <-> renderer
          // boundary, so the host streams bytes here instead.
          this.ingestData(ev.seq, base64ToBytes(ev.dataB64))
          break
        case 'session:trunc':
          this.ingestTrunc()
          break
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
        case 'host:ready':
          // The pty-host (re)started. If we'd already established a session
          // it no longer exists in the new host process, so re-spawn it.
          // Before our first successful attach there is nothing to recover
          // (this is just the initial boot), so we gate on `everOpened`.
          if (
            this._state !== 'disposed' &&
            this.everOpened &&
            !this.suppressReconnect &&
            this.spawnOptions
          ) {
            // eslint-disable-next-line no-console
            console.info('[shogo-pty-client] pty-host restarted - re-spawning session')
            this.sessionGone = true
            this.markClosed()
            this.cancelReconnect()
            this._state = 'idle'
            this.connect()
          }
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
    // First subscriber drains any DATA that arrived during the window
    // between `port.start()` and the React-mounted xterm subscribing.
    // See `pendingData` field comment.
    const isFirstListener = this.dataListeners.size === 0
    this.dataListeners.add(cb)
    if (isFirstListener && this.pendingData.length > 0) {
      const drained = this.pendingData
      this.pendingData = []
      this.pendingDataBytes = 0
      for (const bytes of drained) {
        try { cb(bytes) } catch { /* swallow; listener errors must not poison the buffer */ }
      }
    }
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
      // If a previous attempt learned our session is gone (the host
      // crashed/restarted), spawn a fresh one before attaching. Re-attaching
      // a dead session id can only ever return `no-session`.
      if (this.sessionGone && this.spawnOptions) {
        await this.respawn()
      }
      const { port, channelId, latestSeq } = await this.bridge.attach(this.sessionId, this.lastSeq)
      // eslint-disable-next-line no-console
      console.info(
        '[shogo-pty-client] attach ✓ — got port:', !!port,
        'channelId:', channelId,
        'latestSeq:', latestSeq,
      )
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
      this.everOpened = true
      this.sessionGone = false
      // We're already up to date through latestSeq (the server will only
      // send seqs > sinceSeq). lastSeq updates as DATA frames arrive.
      void latestSeq
      this.setState('open')
      // Re-assert the grid size: a freshly re-spawned shell starts at the
      // dimensions baked into spawnOptions, which may be stale after the
      // user resized the panel. No-op on the very first attach (the surface
      // calls resize() right after mount anyway).
      this.reapplyResize()
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      // A "session is gone" failure (the host crashed/restarted, or reaped
      // the session) is NOT a transient disconnect: re-attaching the same
      // id will fail forever. When we can re-spawn, flag it and let the
      // reconnect timer build a fresh session instead of surfacing a scary
      // error to the user. Otherwise fall back to the plain reconnect path.
      if (this.spawnOptions && this.isSessionGone(e)) {
        // eslint-disable-next-line no-console
        console.warn('[shogo-pty-client] session gone (%s) - will re-spawn on next attempt', e.message)
        this.sessionGone = true
        this.markClosed()
        this.scheduleReconnect()
        return
      }
      // eslint-disable-next-line no-console
      console.error('[shogo-pty-client] attach ✗ failed:', e)
      this.emitError(e)
      this.markClosed()
      this.scheduleReconnect()
    }
  }

  /**
   * Spawn a brand-new host session from `spawnOptions` and adopt its id.
   * Used to recover from a pty-host restart. Resets `lastSeq` because the
   * new session has its own (empty) scrollback; there is nothing to replay
   * from the old, dead session.
   */
  private async respawn(): Promise<void> {
    if (!this.spawnOptions) return
    const session = await this.bridge.spawn(this.spawnOptions)
    this.sessionId = session.id
    this.lastSeq = 0
    this.sessionGone = false
    // eslint-disable-next-line no-console
    console.info('[shogo-pty-client] re-spawned session %s', session.id)
  }

  /**
   * Does this error mean the host-side session no longer exists? Covers the
   * pty-host's own `no-session` reply and the main-process `PtyHostClient`
   * errors raised when the host process died mid-request.
   */
  private isSessionGone(err: Error): boolean {
    const m = err.message || ''
    return (
      m.includes('no-session') ||
      m.includes('unknown session') ||
      m.includes('pty-host exited') ||
      m.includes('pty-host not running') ||
      m.includes('pty-host disposed')
    )
  }

  private reapplyResize(): void {
    if (this.lastCols < 1 || this.lastRows < 1) return
    void this.bridge.resize(this.sessionId, this.lastCols, this.lastRows).catch(() => { /* best-effort */ })
  }

  send(bytes: Uint8Array | string): void {
    if (this._state !== 'open') return
    const text = typeof bytes === 'string' ? bytes : TEXT_DEC.decode(bytes)
    // Use the control-plane write path for input. It is the same reliable
    // IPC route used by preset commands and avoids the Electron MessagePort
    // edge where outbound DATA frames can be accepted but never delivered to
    // the utility-process side. Output still streams over the data port.
    void this.bridge.write(this.sessionId, text).catch((err) => {
      this.emitError(err instanceof Error ? err : new Error(String(err)))
    })
  }

  resize(cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return
    if (cols < 1 || rows < 1 || cols > 0xffff || rows > 0xffff) return
    // Remember the latest dimensions regardless of state so we can re-assert
    // them after a re-spawn (see reapplyResize).
    this.lastCols = cols
    this.lastRows = rows
    if (this._state !== 'open') return
    void this.bridge.resize(this.sessionId, cols, rows).catch(() => { /* best-effort */ })
  }

  signal(sig: 'INT' | 'TERM' | 'KILL'): void {
    if (this._state !== 'open') return
    void this.bridge.signal(this.sessionId, sig).catch((err) => {
      this.emitError(err instanceof Error ? err : new Error(String(err)))
    })
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
    this.pendingData = []
    this.pendingDataBytes = 0
  }

  // ─── internals ─────────────────────────────────────────────────────

  private handleFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case ServerFrameType.DATA: {
        this.ingestData(frame.seq, frame.bytes)
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
        this.ingestTrunc()
        return
      }
    }
  }

  /**
   * Fan a chunk of PTY output out to listeners (or buffer it until the first
   * listener subscribes). Shared by the data-port frame path and the
   * control-plane `session:data` event path so both behave identically.
   */
  private ingestData(seq: number, bytes: Uint8Array): void {
    if (seq > this.lastSeq) this.lastSeq = seq
    this.sendAck(this.lastSeq)
    if (this.dataListeners.size === 0) {
      this.bufferPendingData(bytes)
      return
    }
    for (const cb of [...this.dataListeners]) {
      try { cb(bytes) } catch { /* swallow */ }
    }
  }

  private ingestTrunc(): void {
    for (const cb of [...this.truncListeners]) {
      try { cb() } catch { /* swallow */ }
    }
  }

  private bufferPendingData(bytes: Uint8Array): void {
    this.pendingData.push(bytes)
    this.pendingDataBytes += bytes.byteLength
    // Bound the buffer by dropping oldest chunks. The newest data (likely
    // the live prompt + last command output) is what the user sees
    // first when xterm finally subscribes.
    while (
      this.pendingDataBytes > DesktopPtyClient.MAX_PENDING_BYTES &&
      this.pendingData.length > 1
    ) {
      const dropped = this.pendingData.shift()
      if (dropped) this.pendingDataBytes -= dropped.byteLength
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
    // Hand the client the same spawn recipe so it can self-heal across a
    // pty-host restart (re-spawn instead of forever re-attaching a dead id).
    client: new DesktopPtyClient({ sessionId: session.id, bridge, spawnOptions: spawnOpts }),
    session,
  }
}
