// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chrome DevTools Protocol (CDP) WebSocket client.
 *
 * Pure-TS wrapper around a CDP-speaking WebSocket. Provides:
 *
 *   - `send(method, params)` → Promise<result>   — request/response with auto-id
 *   - `on(eventName, handler)` → unsubscribe     — event subscription
 *   - `close(code?, reason?)`                    — graceful shutdown
 *   - `state`                                    — 'connecting' | 'open' | 'closing' | 'closed' | 'error'
 *
 * Design notes
 * ────────────
 * • WebSocket is injected (constructor option) so tests can run without a
 *   network stack and Electron's main can use the global WebSocket (Node 20+
 *   ships it built-in; we fall back to `ws` only if someone overrides via
 *   `wsFactory`).
 * • Every `send()` is correlated by an auto-incrementing numeric id. If the
 *   socket dies before a response arrives, the pending promise rejects with
 *   the close reason — callers never hang.
 * • Events with a 'Method' name (no 'id') are dispatched to subscribers
 *   keyed by method. Unknown methods are not an error — many CDP domains
 *   we don't subscribe to are fired during a session.
 * • A 30 s default per-call timeout — long enough for `Runtime.evaluate` on
 *   chunky expressions, short enough to surface a hung target.
 *
 * Reference: https://chromedevtools.github.io/devtools-protocol/
 */

/** Minimal WebSocket-like surface — matches both the global WebSocket and the `ws` package. */
export interface WebSocketLike {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(event: 'open', cb: () => void): void
  addEventListener(event: 'message', cb: (ev: { data: string | ArrayBufferLike | Blob }) => void): void
  addEventListener(event: 'close', cb: (ev: { code: number; reason: string }) => void): void
  addEventListener(event: 'error', cb: (ev: unknown) => void): void
}

export type WebSocketFactory = (url: string) => WebSocketLike

export type CdpState = 'connecting' | 'open' | 'closing' | 'closed' | 'error'

export interface CdpEvent<P = unknown> {
  method: string
  params: P
}

export type CdpEventHandler<P = unknown> = (ev: CdpEvent<P>) => void

export interface CdpClientOptions {
  url: string
  /** Factory used to construct the underlying socket. Defaults to global WebSocket. */
  wsFactory?: WebSocketFactory
  /** Per-call timeout in ms. Default 30 000. Use 0 to disable. */
  timeoutMs?: number
  /** Logger for diagnostic messages. Default: no-op. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void
}

interface PendingCall {
  resolve(value: unknown): void
  reject(err: Error): void
  timer: ReturnType<typeof setTimeout> | null
  method: string
}

/** Error thrown when CDP reports a domain-level failure. */
export class CdpError extends Error {
  readonly code?: number
  readonly data?: unknown
  constructor(message: string, code?: number, data?: unknown) {
    super(message)
    this.name = 'CdpError'
    this.code = code
    this.data = data
  }
}

/**
 * One-shot CDP client. Reconnection is intentionally NOT built in — when a
 * debug session dies the higher-level DebugSession decides whether to attempt
 * a new attach (typically against a freshly-spawned process).
 */
export class CdpClient {
  readonly url: string
  private readonly timeoutMs: number
  private readonly log: NonNullable<CdpClientOptions['log']>
  private readonly ws: WebSocketLike
  private readonly pending = new Map<number, PendingCall>()
  private readonly eventHandlers = new Map<string, Set<CdpEventHandler>>()
  private readonly globalHandlers = new Set<CdpEventHandler>()
  private readonly closeHandlers = new Set<(reason: string) => void>()
  private nextId = 1
  private _state: CdpState = 'connecting'
  private openPromise: Promise<void>
  private resolveOpen!: () => void
  private rejectOpen!: (e: Error) => void
  private closeReason: string | null = null

  constructor(opts: CdpClientOptions) {
    this.url = opts.url
    this.timeoutMs = opts.timeoutMs ?? 30_000
    this.log = opts.log ?? (() => undefined)

    const factory: WebSocketFactory =
      opts.wsFactory ??
      ((url: string) => {
        if (typeof (globalThis as { WebSocket?: unknown }).WebSocket !== 'function') {
          throw new Error(
            'No global WebSocket available; inject opts.wsFactory (Node < 20 or non-browser test env)'
          )
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return new (globalThis as any).WebSocket(url) as WebSocketLike
      })

    this.openPromise = new Promise<void>((resolve, reject) => {
      this.resolveOpen = resolve
      this.rejectOpen = reject
    })
    // Suppress unhandled-rejection warnings — callers that care will await whenOpen().
    this.openPromise.catch(() => undefined)

    this.ws = factory(this.url)

    this.ws.addEventListener('open', () => {
      this._state = 'open'
      this.resolveOpen()
    })

    this.ws.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : null
      if (raw === null) {
        this.log('warn', 'cdp: non-string message dropped')
        return
      }
      this.handleMessage(raw)
    })

    this.ws.addEventListener('close', (ev) => {
      const wasConnecting = this._state === 'connecting'
      this._state = 'closed'
      this.closeReason = ev.reason || `code ${ev.code}`
      this.failAllPending(`socket closed: ${this.closeReason}`)
      if (wasConnecting) this.rejectOpen(new Error(`cdp: ${this.closeReason}`))
      for (const h of [...this.closeHandlers]) {
        try { h(this.closeReason) } catch (e) { this.log('error', 'cdp: close handler threw', e) }
      }
    })

    this.ws.addEventListener('error', (err) => {
      this.log('error', 'cdp: socket error', err)
      const wasConnecting = this._state === 'connecting'
      this._state = 'error'
      this.failAllPending('socket error')
      if (wasConnecting) this.rejectOpen(new Error('cdp: socket error'))
      for (const h of [...this.closeHandlers]) {
        try { h('socket error') } catch (e) { this.log('error', 'cdp: close handler threw', e) }
      }
    })
  }

  get state(): CdpState { return this._state }

  /** Wait for the socket to open. Resolves immediately if already open. */
  async whenOpen(): Promise<void> {
    if (this._state === 'open') return
    if (this._state === 'closed' || this._state === 'error') {
      const suffix = this.closeReason ? `: ${this.closeReason}` : ""; throw new Error(`cdp: socket already ${this._state}${suffix}`)
    }
    await this.openPromise
  }

  /**
   * Send a CDP command and await its response. Rejects with `CdpError` if v8
   * returns an error envelope, or with `Error` on socket failure / timeout.
   */
  send<R = unknown, P = unknown>(method: string, params?: P): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      if (this._state !== 'open') {
        reject(new Error(`cdp: socket not open (state=${this._state})`))
        return
      }
      const id = this.nextId++
      const timer =
        this.timeoutMs > 0
          ? setTimeout(() => {
              if (this.pending.has(id)) {
                this.pending.delete(id)
                reject(new Error(`cdp: ${method} timed out after ${this.timeoutMs}ms`))
              }
            }, this.timeoutMs)
          : null
      this.pending.set(id, {
        resolve: (v) => resolve(v as R),
        reject,
        timer,
        method,
      })
      try {
        this.ws.send(JSON.stringify({ id, method, params: params ?? {} }))
      } catch (e) {
        // Synchronous send failure — clean up immediately.
        const entry = this.pending.get(id)
        if (entry?.timer) clearTimeout(entry.timer)
        this.pending.delete(id)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  /** Subscribe to a specific CDP event method (e.g. `Debugger.paused`). */
  on<P = unknown>(method: string, handler: CdpEventHandler<P>): () => void {
    let set = this.eventHandlers.get(method)
    if (!set) {
      set = new Set()
      this.eventHandlers.set(method, set)
    }
    set.add(handler as CdpEventHandler)
    return () => {
      set?.delete(handler as CdpEventHandler)
      if (set && set.size === 0) this.eventHandlers.delete(method)
    }
  }

  /** Subscribe to every event regardless of method — useful for diagnostics. */
  onAny(handler: CdpEventHandler): () => void {
    this.globalHandlers.add(handler)
    return () => { this.globalHandlers.delete(handler) }
  }

  /** Subscribe to socket close / error.  Fires exactly once per CdpClient lifetime. */
  onClose(handler: (reason: string) => void): () => void {
    if (this._state === 'closed' || this._state === 'error') {
      // Already closed — fire on next tick so subscribers can't be re-entered synchronously.
      const reason = this.closeReason ?? `state ${this._state}`
      Promise.resolve().then(() => handler(reason))
      return () => undefined
    }
    this.closeHandlers.add(handler)
    return () => { this.closeHandlers.delete(handler) }
  }

  /** Close the socket. Pending calls reject. */
  close(code = 1000, reason = 'client-initiated'): void {
    if (this._state === 'closed' || this._state === 'closing') return
    this._state = 'closing'
    try { this.ws.close(code, reason) } catch { /* swallow */ }
  }

  private handleMessage(raw: string): void {
    let msg: unknown
    try { msg = JSON.parse(raw) } catch {
      this.log('warn', 'cdp: malformed JSON', raw.slice(0, 200))
      return
    }
    if (!msg || typeof msg !== 'object') return
    const m = msg as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } }

    if (typeof m.id === 'number') {
      const pending = this.pending.get(m.id)
      if (!pending) {
        // Late response after timeout — ignore.
        return
      }
      this.pending.delete(m.id)
      if (pending.timer) clearTimeout(pending.timer)
      if (m.error) {
        pending.reject(new CdpError(m.error.message ?? 'cdp error', m.error.code, m.error.data))
      } else {
        pending.resolve(m.result)
      }
      return
    }

    if (typeof m.method === 'string') {
      const ev: CdpEvent = { method: m.method, params: m.params ?? {} }
      const handlers = this.eventHandlers.get(m.method)
      if (handlers) {
        for (const h of [...handlers]) {
          try { h(ev) } catch (e) {
            this.log('error', `cdp: handler for ${m.method} threw`, e)
          }
        }
      }
      for (const h of [...this.globalHandlers]) {
        try { h(ev) } catch (e) {
          this.log('error', 'cdp: global handler threw', e)
        }
      }
    }
  }

  private failAllPending(reason: string): void {
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(new Error(`cdp: ${reason} (during ${p.method})`))
    }
    this.pending.clear()
  }
}
