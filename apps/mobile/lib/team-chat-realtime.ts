// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One realtime connection per workspace for team chat, shared by every
 * screen that subscribes. WebSocket first (typing/presence go upstream on
 * it); falls back to the SSE event stream when sockets can't connect.
 * Listeners get a `ready` event after every (re)connect and should backfill
 * with `afterSeq` since events are not replayed.
 */
import type { TeamChatEvent } from './team-chat-api'

export type RealtimeState = 'connecting' | 'open' | 'fallback' | 'closed'
type Listener = (event: TeamChatEvent) => void
type StateListener = (state: RealtimeState) => void

interface SocketLike {
  send(data: string): void
  close(): void
  onopen: ((ev?: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev?: unknown) => void) | null
  onerror: ((ev?: unknown) => void) | null
}

interface EventSourceLike {
  close(): void
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev?: unknown) => void) | null
}

export interface RealtimeDeps {
  urls: { ws: string; sse: string }
  createSocket: (url: string) => SocketLike
  createEventSource: (url: string) => EventSourceLike
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (id: unknown) => void
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (id: unknown) => void
}

const PING_INTERVAL_MS = 25_000
const MAX_BACKOFF_MS = 30_000
/** Socket attempts that never reach `ready` before switching to SSE. */
const FALLBACK_AFTER_FAILURES = 2
/** How often to retry the socket while on the SSE fallback. */
const SOCKET_RETRY_WHILE_FALLBACK_MS = 60_000

export class TeamChatConnection {
  private listeners = new Set<Listener>()
  private stateListeners = new Set<StateListener>()
  private socket: SocketLike | null = null
  private source: EventSourceLike | null = null
  private pingTimer: unknown = null
  private retryTimer: unknown = null
  private failures = 0
  private readyOnSocket = false
  private stopped = false
  private _state: RealtimeState = 'closed'
  private presence: 'active' | 'away' = 'active'

  constructor(private deps: RealtimeDeps) {}

  get state(): RealtimeState {
    return this._state
  }

  start(): void {
    this.stopped = false
    this.connectSocket()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    this.teardownSocket()
    this.teardownSource()
    this.setState('closed')
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  sendTyping(conversationId: string, threadRootId: string | null = null): void {
    this.send({ type: 'typing', conversationId, threadRootId })
  }

  setPresence(status: 'active' | 'away'): void {
    this.presence = status
    this.send({ type: 'presence', status })
  }

  private send(frame: Record<string, unknown>): void {
    if (!this.socket || !this.readyOnSocket) return
    try {
      this.socket.send(JSON.stringify(frame))
    } catch {
      // The close handler takes care of reconnecting.
    }
  }

  private emit(event: TeamChatEvent): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event)
      } catch (err) {
        console.error('[TeamChat] listener failed', err)
      }
    }
  }

  private setState(state: RealtimeState): void {
    if (state === this._state) return
    this._state = state
    for (const listener of Array.from(this.stateListeners)) listener(state)
  }

  private handleFrame(raw: unknown): void {
    if (typeof raw !== 'string') return
    let event: TeamChatEvent
    try {
      event = JSON.parse(raw)
    } catch {
      return
    }
    if (!event || typeof (event as { type?: unknown }).type !== 'string') return
    if ((event as { type: string }).type === 'pong') return
    this.emit(event)
  }

  private connectSocket(): void {
    if (this.stopped) return
    this.teardownSocket()
    if (this._state !== 'fallback') this.setState('connecting')
    this.readyOnSocket = false
    let socket: SocketLike
    try {
      socket = this.deps.createSocket(this.deps.urls.ws)
    } catch {
      this.onSocketFailed()
      return
    }
    this.socket = socket
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return
      if (!this.readyOnSocket && typeof ev.data === 'string' && ev.data.includes('"ready"')) {
        this.readyOnSocket = true
        this.failures = 0
        this.teardownSource()
        this.setState('open')
        this.startPing()
        if (this.presence === 'away') this.send({ type: 'presence', status: 'away' })
      }
      this.handleFrame(ev.data)
    }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      this.stopPing()
      if (this.stopped) return
      if (this.readyOnSocket) {
        this.readyOnSocket = false
        this.scheduleSocketRetry(this.backoff())
      } else {
        this.onSocketFailed()
      }
    }
    socket.onerror = () => {
      // onclose follows; nothing to do here.
    }
  }

  private onSocketFailed(): void {
    this.failures++
    if (this.failures >= FALLBACK_AFTER_FAILURES && !this.source) this.startFallback()
    this.scheduleSocketRetry(this.source ? SOCKET_RETRY_WHILE_FALLBACK_MS : this.backoff())
  }

  private backoff(): number {
    return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.failures, 5))
  }

  private scheduleSocketRetry(ms: number): void {
    if (this.stopped) return
    const clear = this.deps.clearTimeout ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>))
    const set = this.deps.setTimeout ?? ((fn: () => void, t: number) => setTimeout(fn, t))
    if (this.retryTimer) clear(this.retryTimer)
    this.retryTimer = set(() => {
      this.retryTimer = null
      this.connectSocket()
    }, ms)
  }

  private startFallback(): void {
    this.teardownSource()
    let source: EventSourceLike
    try {
      source = this.deps.createEventSource(this.deps.urls.sse)
    } catch {
      return
    }
    this.source = source
    this.setState('fallback')
    source.onmessage = (ev) => {
      if (this.source === source) this.handleFrame(ev.data)
    }
    source.onerror = () => {
      // EventSource reconnects on its own; its `ready` frame triggers a backfill.
    }
  }

  private startPing(): void {
    this.stopPing()
    const set = this.deps.setInterval ?? ((fn: () => void, t: number) => setInterval(fn, t))
    this.pingTimer = set(() => this.send({ type: 'ping', t: Date.now() }), PING_INTERVAL_MS)
  }

  private stopPing(): void {
    if (!this.pingTimer) return
    const clear = this.deps.clearInterval ?? ((id: unknown) => clearInterval(id as ReturnType<typeof setInterval>))
    clear(this.pingTimer)
    this.pingTimer = null
  }

  private clearTimers(): void {
    this.stopPing()
    if (this.retryTimer) {
      const clear = this.deps.clearTimeout ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>))
      clear(this.retryTimer)
      this.retryTimer = null
    }
  }

  private teardownSocket(): void {
    const socket = this.socket
    this.socket = null
    this.readyOnSocket = false
    if (!socket) return
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
    try {
      socket.close()
    } catch {
      // Already closed.
    }
  }

  private teardownSource(): void {
    const source = this.source
    this.source = null
    if (!source) return
    source.onmessage = source.onerror = null
    source.close()
  }
}
