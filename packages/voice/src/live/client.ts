// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type {
  LiveSessionConfig,
  LiveSessionEvent,
  LiveSessionStartedEvent,
  LiveSessionClosedEvent,
  LiveWebRtcSession,
} from './types.js'

export interface ShogoLiveClientOptions {
  apiUrl: string
  apiKey?: string
  runtimeToken?: string
  fetch?: typeof fetch
  WebSocket?: new (url: string, protocols?: string | string[]) => WebSocket
}

export interface LiveSessionHandlers {
  [eventType: string]: (event: LiveSessionEvent) => void
}

function encodeAudio(audio: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = ''
    for (let i = 0; i < audio.length; i += 0x8000) {
      binary += String.fromCharCode(...audio.subarray(i, i + 0x8000))
    }
    return btoa(binary)
  }
  const BufferImpl = (globalThis as any).Buffer
  if (BufferImpl) return BufferImpl.from(audio).toString('base64')
  throw new Error('Base64 encoding is unavailable in this runtime')
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '')
}

export class LiveSession {
  private readonly handlers = new Map<string, Set<(event: LiveSessionEvent) => void>>()
  private readonly startedPromise: Promise<LiveSessionStartedEvent>
  private resolveStarted!: (event: LiveSessionStartedEvent) => void
  private rejectStarted!: (error: Error) => void
  private closedPromise: Promise<LiveSessionClosedEvent | void>
  private resolveClosed!: (event: LiveSessionClosedEvent | void) => void
  private closed = false

  readonly started: Promise<LiveSessionStartedEvent>
  latestUsageSeconds = 0

  constructor(
    private readonly socket: WebSocket,
    private readonly initialSession?: LiveSessionConfig,
  ) {
    this.startedPromise = new Promise((resolve, reject) => {
      this.resolveStarted = resolve
      this.rejectStarted = reject
    })
    this.started = this.startedPromise
    this.closedPromise = new Promise((resolve) => { this.resolveClosed = resolve })

    socket.addEventListener('message', (message) => {
      const raw = typeof message.data === 'string' ? message.data : ''
      if (!raw) return
      let event: LiveSessionEvent
      try { event = JSON.parse(raw) as LiveSessionEvent } catch { return }

      if (event.type === 'session.started') this.resolveStarted(event as LiveSessionStartedEvent)
      if (event.type === 'session.usage.updated') {
        const seconds = (event as any).usage?.seconds
        if (typeof seconds === 'number') this.latestUsageSeconds = seconds
      }
      if (event.type === 'session.closed') {
        this.closed = true
        this.resolveClosed(event as LiveSessionClosedEvent)
      }
      if (event.type === 'error' && !this.closed) {
        const messageText = String((event as any).error?.message || 'Live session error')
        this.rejectStarted(new Error(messageText))
      }
      for (const handler of this.handlers.get(String(event.type)) ?? []) handler(event)
      for (const handler of this.handlers.get('*') ?? []) handler(event)
    })
    socket.addEventListener('close', () => {
      if (!this.closed) this.resolveClosed()
    })
    socket.addEventListener('error', () => {
      if (!this.closed) this.rejectStarted(new Error('Live session WebSocket error'))
    })
    socket.addEventListener('open', () => {
      if (initialSession) this.send({ type: 'session.start', session: initialSession })
    })
  }

  on(eventType: string, handler: (event: LiveSessionEvent) => void): () => void {
    const handlers = this.handlers.get(eventType) ?? new Set()
    handlers.add(handler)
    this.handlers.set(eventType, handlers)
    return () => handlers.delete(handler)
  }

  send(event: Record<string, unknown>): void {
    if (this.closed) throw new Error('Live session is closed')
    this.socket.send(JSON.stringify(event))
  }

  appendAudio(audio: Uint8Array | string): void {
    this.send({
      type: 'session.input_audio.append',
      audio: typeof audio === 'string' ? audio : encodeAudio(audio),
    })
  }

  async close(timeoutMs = 15_000): Promise<LiveSessionClosedEvent | void> {
    if (this.closed) return
    if (this.socket.readyState === 1) this.send({ type: 'session.close' })
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
    const result = await Promise.race([this.closedPromise, timeout])
    if (!this.closed) this.socket.close()
    return result
  }
}

export class ShogoLiveClient {
  private readonly apiUrl: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly WebSocketImpl: new (url: string, protocols?: string | string[]) => WebSocket

  constructor(options: ShogoLiveClientOptions) {
    if (!!options.apiKey === !!options.runtimeToken) {
      throw new Error('ShogoLiveClient requires exactly one of apiKey or runtimeToken.')
    }
    this.apiUrl = normalizeBaseUrl(options.apiUrl)
    this.token = (options.apiKey ?? options.runtimeToken)!
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.WebSocketImpl = options.WebSocket ?? globalThis.WebSocket
    if (typeof this.fetchImpl !== 'function') throw new Error('fetch is unavailable')
    if (typeof this.WebSocketImpl !== 'function') throw new Error('WebSocket is unavailable')
  }

  private httpUrl(path: string): string {
    return `${this.apiUrl}${path}`
  }

  private wsUrl(path: string): string {
    return this.httpUrl(path).replace(/^http/, 'ws')
  }

  private protocols(): string[] {
    return ['shogo-live', `shogo-insecure-api-key.${this.token}`]
  }

  connect(session: LiveSessionConfig): LiveSession {
    const socket = new this.WebSocketImpl(this.wsUrl('/api/ai/v1/live/sessions'), this.protocols())
    return new LiveSession(socket, session)
  }

  attach(sessionId: string): LiveSession {
    const socket = new this.WebSocketImpl(
      this.wsUrl(`/api/ai/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`),
      this.protocols(),
    )
    return new LiveSession(socket)
  }

  async createWebRtcSession(input: {
    session: LiveSessionConfig
    sdp: string
  }): Promise<LiveWebRtcSession> {
    const response = await this.fetchImpl(this.httpUrl('/api/ai/v1/live/sessions'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session: input.session,
        transport: { type: 'webrtc', sdp: input.sdp },
      }),
    })
    const body = await response.json() as any
    if (!response.ok) {
      throw new Error(body?.error?.message || `Live session creation failed (${response.status})`)
    }
    return body as LiveWebRtcSession
  }
}

export type {
  LiveAudioConfig,
  LiveResponsesDelegation,
  LiveSessionConfig,
  LiveSessionEvent,
  LiveSessionStartedEvent,
  LiveSessionUsageUpdatedEvent,
  LiveSessionClosedEvent,
  LiveErrorEvent,
  LiveWebRtcSession,
} from './types.js'
