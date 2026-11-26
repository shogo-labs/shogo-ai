// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The `EventSource` React Native needs, on top of streaming `fetch` (SHO-580).
 *
 * Why not the old `XMLHttpRequest` transport: RN appends every chunk to one
 * `responseText` string and never trims it, so an hours-long team-chat stream
 * kept the whole session's text in memory and every `substring` over it got
 * slower with age — the JS-thread cost that made the app feel stuck on a slow
 * network. Expo installs its streaming `fetch` as the native global (see
 * `expo/src/winter/runtime.native.ts`), and the app already reads SSE through
 * `response.body.getReader()` (`lib/api.ts`, `importViaFetchSSE`), so this
 * reads chunks as they arrive and hands each one straight to
 * {@link SSEParser}: memory is the unparsed tail, not the transcript.
 *
 * `XMLHttpRequest` is also the reason the old polyfill could not send named
 * events correctly — it never got a chance to dispatch them. Custom headers
 * (the Better Auth cookie on native) work exactly as before.
 *
 * A stream that ends or fails still fires `onerror` with `readyState` CLOSED,
 * because that is the reconnection contract every caller already implements
 * (`team-chat-realtime`, `stream-fallback`, `LiveBrowserView`).
 */
import { SSEParser, type SSEMessage } from './sse-parser'

/** A `fetch` narrow enough to type across bun, RN and the DOM's overloads. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface NativeEventSourceOptions {
  headers?: Record<string, string>
  /** Test seam: the fetch implementation. The app uses the global (expo) one. */
  fetchImpl?: FetchLike
}

export interface NativeSSEEvent {
  type: string
  data?: string
  lastEventId?: string
}

type Listener = (event: NativeSSEEvent) => void

export class NativeEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2

  readonly url: string
  readyState: number = NativeEventSource.CONNECTING
  onopen: Listener | null = null
  onmessage: Listener | null = null
  onerror: Listener | null = null

  private readonly headers: Record<string, string>
  private readonly fetchImpl: FetchLike
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly parser = new SSEParser()
  private controller: AbortController | null = null
  private closed = false

  constructor(url: string, options: NativeEventSourceOptions = {}) {
    this.url = url
    this.headers = options.headers ?? {}
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    void this.connect()
  }

  /** The id a reconnect would resume from. */
  get lastEventId(): string {
    return this.parser.id
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  dispatchEvent(event: NativeSSEEvent): boolean {
    this.emit(event.type, event)
    return true
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.readyState = NativeEventSource.CLOSED
    this.parser.reset()
    this.listeners.clear()
    this.onopen = null
    this.onmessage = null
    this.onerror = null
    try {
      this.controller?.abort()
    } catch {
      // An abort that races a finished stream is not an error.
    }
    this.controller = null
  }

  private async connect(): Promise<void> {
    const controller = new AbortController()
    this.controller = controller
    this.readyState = NativeEventSource.CONNECTING

    try {
      const response = await this.fetchImpl(this.url, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          ...this.headers,
        },
        // Native auth travels in the `Cookie` header, so no cookie jar.
        credentials: 'omit',
        signal: controller.signal,
      })

      if (this.closed) return
      if (!response.ok) {
        this.finish()
        return
      }

      this.readyState = NativeEventSource.OPEN
      this.emit('open', { type: 'open' })

      const body = response.body
      const reader = body?.getReader?.()
      if (!reader) {
        // A server or transport that did not stream: still parse it correctly,
        // just not incrementally.
        await this.parseText(await response.text())
        this.finish()
        return
      }

      const decoder = new TextDecoder()
      for (;;) {
        const { value, done } = await reader.read()
        if (this.closed) return
        if (done) break
        if (value) this.deliver(this.parser.push(decoder.decode(value, { stream: true })))
      }
      if (this.closed) return
      this.deliver(this.parser.push(decoder.decode()))
      this.finish()
    } catch {
      if (this.closed) return
      this.finish()
    }
  }

  private async parseText(text: string): Promise<void> {
    if (this.closed) return
    this.deliver(this.parser.push(text))
  }

  private deliver(messages: SSEMessage[]): void {
    for (const message of messages) {
      if (this.closed) return
      this.emit(message.type, {
        type: message.type,
        data: message.data,
        lastEventId: message.lastEventId,
      })
    }
  }

  private emit(type: string, event: NativeSSEEvent): void {
    if (this.closed) return
    const listeners = this.listeners.get(type)
    if (listeners) {
      for (const listener of [...listeners]) {
        try {
          listener(event)
        } catch (err) {
          console.warn('[EventSource] listener threw:', err)
        }
      }
    }
    if (type === 'message') this.onmessage?.(event)
    else if (type === 'open') this.onopen?.(event)
    else if (type === 'error') this.onerror?.(event)
  }

  /** The stream ended: callers reconnect off `onerror`, as they always have. */
  private finish(): void {
    if (this.closed) return
    this.closed = true
    this.readyState = NativeEventSource.CLOSED
    const onerror = this.onerror
    this.onerror = null
    onerror?.({ type: 'error' })
    // Keep `addEventListener('error')` subscribers served once.
    const errorListenerSet = this.listeners.get('error')
    if (errorListenerSet) {
      for (const listener of [...errorListenerSet]) {
        try {
          listener({ type: 'error' })
        } catch {
          // Nothing useful to do: the connection is over.
        }
      }
    }
  }
}
