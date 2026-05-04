// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

export type PtySignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'EOF'

export type PtyServerFrame =
  | { type: 'ready'; sessionId: string; cwd: string; scrollback?: string; attached: boolean }
  | { type: 'data'; data: string }
  | { type: 'exit'; exitCode: number | null; signal: string | null }
  | { type: 'error'; message: string }
  | { type: 'pong' }

type Handler<T> = (value: T) => void
const CLIENT_BACKPRESSURE_LIMIT_BYTES = 1 * 1024 * 1024
const RECONNECT_BASE_DELAY_MS = 300
const RECONNECT_MAX_DELAY_MS = 5_000
const RECONNECT_MAX_ATTEMPTS = 6

export interface PtyClientOptions {
  url: string
  sessionId?: string
  cols: number
  rows: number
  cwd?: string | null
}

export class PtyClient {
  private readonly url: string
  private readonly cwd?: string | null
  private ws: WebSocket | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private cols: number
  private rows: number
  private sessionId?: string
  private closed = false
  private ready = false

  private readonly dataHandlers = new Set<Handler<string>>()
  private readonly readyHandlers = new Set<Handler<Extract<PtyServerFrame, { type: 'ready' }>>>()
  private readonly exitHandlers = new Set<Handler<Extract<PtyServerFrame, { type: 'exit' }>>>()
  private readonly errorHandlers = new Set<Handler<string>>()
  private readonly closeHandlers = new Set<Handler<void>>()

  constructor(options: PtyClientOptions) {
    this.url = options.url
    this.sessionId = options.sessionId
    this.cols = options.cols
    this.rows = options.rows
    this.cwd = options.cwd
  }

  connect(): void {
    this.closed = false
    this.clearReconnect()
    this.openSocket()
  }

  private openSocket(): void {
    if (this.closed) return
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.onopen = () => {
      this.send({
        type: 'init',
        sessionId: this.sessionId,
        cols: this.cols,
        rows: this.rows,
        cwd: this.cwd ?? undefined,
        shell: 'bash',
      })
      this.startHeartbeat()
    }
    ws.onmessage = (event) => this.handleMessage(event.data)
    ws.onerror = () => {
      // The close event drives reconnect/fallback decisions.
    }
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null
      this.stopHeartbeat()
      this.ready = false
      for (const handler of this.closeHandlers) handler()
      this.scheduleReconnect()
    }
  }

  write(data: string): void {
    if (!this.ready) return
    this.send({ type: 'data', data })
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    if (!this.ready) return
    this.send({ type: 'resize', cols, rows })
  }

  signal(signal: PtySignal): void {
    if (!this.ready) return
    this.send({ type: 'signal', signal })
  }

  close(): void {
    this.closed = true
    this.clearReconnect()
    this.stopHeartbeat()
    this.ws?.close()
    this.ws = null
  }

  getSessionId(): string | undefined {
    return this.sessionId
  }

  onData(handler: Handler<string>): () => void {
    this.dataHandlers.add(handler)
    return () => this.dataHandlers.delete(handler)
  }

  onReady(handler: Handler<Extract<PtyServerFrame, { type: 'ready' }>>): () => void {
    this.readyHandlers.add(handler)
    return () => this.readyHandlers.delete(handler)
  }

  onExit(handler: Handler<Extract<PtyServerFrame, { type: 'exit' }>>): () => void {
    this.exitHandlers.add(handler)
    return () => this.exitHandlers.delete(handler)
  }

  onError(handler: Handler<string>): () => void {
    this.errorHandlers.add(handler)
    return () => this.errorHandlers.delete(handler)
  }

  onClose(handler: Handler<void>): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  private handleMessage(raw: unknown): void {
    let frame: PtyServerFrame
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      this.emitError('Invalid PTY frame')
      return
    }
    if (frame.type === 'ready') {
      this.ready = true
      this.reconnectAttempts = 0
      this.sessionId = frame.sessionId
      for (const handler of this.readyHandlers) handler(frame)
      if (frame.scrollback) for (const handler of this.dataHandlers) handler(frame.scrollback)
    } else if (frame.type === 'data') {
      for (const handler of this.dataHandlers) handler(frame.data)
    } else if (frame.type === 'exit') {
      this.closed = true
      this.clearReconnect()
      this.stopHeartbeat()
      for (const handler of this.exitHandlers) handler(frame)
    } else if (frame.type === 'error') {
      this.emitError(frame.message)
    }
  }

  private send(frame: Record<string, unknown>): void {
    if (this.closed || this.ws?.readyState !== WebSocket.OPEN) return
    if (this.ws.bufferedAmount > CLIENT_BACKPRESSURE_LIMIT_BYTES) {
      this.emitError('PTY client output buffer is full')
      this.close()
      return
    }
    this.ws.send(JSON.stringify(frame))
  }

  private emitError(message: string): void {
    for (const handler of this.errorHandlers) handler(message)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => this.send({ type: 'ping' }), 25_000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      this.emitError('PTY connection closed')
      return
    }
    this.reconnectAttempts += 1
    const exponentialDelay = RECONNECT_BASE_DELAY_MS * 2 ** (this.reconnectAttempts - 1)
    const jitter = Math.floor(Math.random() * RECONNECT_BASE_DELAY_MS)
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, exponentialDelay + jitter)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.openSocket()
    }, delay)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }
}

export function toTerminalPtyWsUrl(apiUrl: string, projectId: string): string {
  const url = new URL(`/api/projects/${encodeURIComponent(projectId)}/terminal/pty`, apiUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}
