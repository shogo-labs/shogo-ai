// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Client for the live-transcript audio socket. The recorder sends 16 kHz mono
 * Int16 frames; the server answers with `partial` text (words still being
 * said) and `final` segments as they settle, and a `done` summary after
 * `finish()`. Reconnects with a fresh ticket if the socket drops mid-recording.
 */

export interface StreamTicket {
  ticket: string
  path: string
  backend: string
}

export interface StreamSegment {
  start: number
  end: number
  text: string
}

export interface StreamHandlers {
  onPartial?(message: { itemId: string; text: string; start: number }): void
  onFinal?(message: { itemId: string; segment: StreamSegment }): void
  onStatus?(message: { state: 'ok' | 'error'; message?: string }): void
  /** The stream can't continue (recognizer died, reconnects exhausted). */
  onFatal?(message: string): void
}

export interface StreamSummary {
  complete: boolean
  chunks: number
  seconds: number
}

export interface LiveStreamOptions {
  getTicket(): Promise<StreamTicket>
  /** `ws://` or `wss://` origin of the API. */
  wsBase: string
  handlers?: StreamHandlers
  connectTimeoutMs?: number
  maxReconnects?: number
  WebSocketImpl?: any
}

/** Audio queued while the socket is down, in samples (30 s at 16 kHz). */
const MAX_QUEUED_SAMPLES = 16000 * 30

export function toWsBase(httpBase: string): string {
  return httpBase.replace(/\/+$/, '').replace(/^http/i, 'ws')
}

export class LiveStreamClient {
  /** Audio handed to `sendPcm` so far, in seconds. Also where a reconnect resumes. */
  get secondsSent(): number {
    return this.sentSamples / 16000
  }

  private socket: any = null
  private sentSamples = 0
  private queue: Int16Array[] = []
  private queuedSamples = 0
  private lost = false
  private finishing = false
  private aborted = false
  private dead = false
  private reconnecting = false
  private doneWaiters: Array<(summary: StreamSummary | null) => void> = []
  private summary: StreamSummary | null = null

  private constructor(private readonly options: LiveStreamOptions) {}

  /**
   * Connect, or resolve null when streaming isn't available (the caller falls
   * back to chunk upload). Never rejects.
   */
  static async connect(options: LiveStreamOptions): Promise<LiveStreamClient | null> {
    const client = new LiveStreamClient(options)
    try {
      await client.open(0, options.connectTimeoutMs ?? 6000)
      return client
    } catch {
      client.abort()
      return null
    }
  }

  private ws(): any {
    return this.options.WebSocketImpl ?? (globalThis as any).WebSocket
  }

  private async open(offsetSeconds: number, timeoutMs: number): Promise<void> {
    const ticket = await this.options.getTicket()
    const WS = this.ws()
    if (!WS) throw new Error('WebSocket is not available')
    const url = `${this.options.wsBase}${ticket.path}?ticket=${encodeURIComponent(ticket.ticket)}&offset=${offsetSeconds}`
    await new Promise<void>((resolve, reject) => {
      const socket = new WS(url)
      socket.binaryType = 'arraybuffer'
      let ready = false
      const timer = setTimeout(() => {
        if (ready) return
        try { socket.close() } catch {}
        reject(new Error('Timed out connecting to live transcription'))
      }, timeoutMs)
      socket.onmessage = (event: any) => {
        let message: any
        try {
          message = JSON.parse(typeof event.data === 'string' ? event.data : '')
        } catch {
          return
        }
        if (message?.type === 'ready') {
          ready = true
          clearTimeout(timer)
          this.socket = socket
          resolve()
          return
        }
        if (message?.type === 'error' && !ready) {
          clearTimeout(timer)
          reject(new Error(String(message.message ?? 'Live transcription is unavailable')))
          return
        }
        this.onMessage(message)
      }
      socket.onerror = () => {
        if (!ready) {
          clearTimeout(timer)
          reject(new Error('Could not connect to live transcription'))
        }
      }
      socket.onclose = () => {
        clearTimeout(timer)
        if (!ready) return reject(new Error('Live transcription closed'))
        if (this.socket === socket) this.socket = null
        this.onClosed()
      }
    })
    this.flushQueue()
  }

  private onMessage(message: any): void {
    const h = this.options.handlers
    switch (message?.type) {
      case 'partial':
        h?.onPartial?.({ itemId: String(message.itemId), text: String(message.text ?? ''), start: Number(message.start) || 0 })
        break
      case 'final':
        if (message.segment) h?.onFinal?.({ itemId: String(message.itemId), segment: message.segment })
        break
      case 'status':
        h?.onStatus?.({ state: message.state === 'error' ? 'error' : 'ok', message: message.message })
        break
      case 'error':
        // A non-fatal error means some audio was not transcribed.
        this.lost = true
        h?.onStatus?.({ state: 'error', message: String(message.message ?? '') })
        if (message.fatal) this.fatal(String(message.message ?? 'Live transcription stopped'))
        break
      case 'done':
        this.summary = {
          complete: message.complete === true && !this.lost,
          chunks: Number(message.chunks) || 0,
          seconds: Number(message.seconds) || 0,
        }
        this.resolveDone(this.summary)
        break
    }
  }

  private resolveDone(summary: StreamSummary | null): void {
    const waiters = this.doneWaiters
    this.doneWaiters = []
    for (const w of waiters) w(summary)
  }

  private fatal(message: string): void {
    if (this.dead) return
    this.dead = true
    this.lost = true
    this.queue = []
    this.queuedSamples = 0
    this.options.handlers?.onFatal?.(message)
    this.resolveDone(null)
  }

  private onClosed(): void {
    if (this.aborted || this.summary || this.dead) return
    if (this.finishing) {
      this.lost = true
      this.resolveDone(null)
      return
    }
    void this.reconnect()
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return
    this.reconnecting = true
    const max = this.options.maxReconnects ?? 3
    try {
      for (let attempt = 0; attempt < max && !this.aborted && !this.dead; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt))
        if (this.aborted || this.dead) return
        try {
          // Resume the timeline where the audio stopped being delivered.
          await this.open(Math.max(0, this.secondsSent - this.queuedSamples / 16000), 6000)
          return
        } catch {}
      }
      this.fatal('Live transcription disconnected.')
    } finally {
      this.reconnecting = false
    }
  }

  private flushQueue(): void {
    const socket = this.socket
    if (!socket) return
    const frames = this.queue
    this.queue = []
    this.queuedSamples = 0
    for (const frame of frames) this.sendFrame(socket, frame)
  }

  private sendFrame(socket: any, frame: Int16Array): void {
    try {
      socket.send(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength))
    } catch {
      this.lost = true
    }
  }

  sendPcm(frame: Int16Array): void {
    if (this.aborted || this.dead || this.finishing || frame.length === 0) return
    this.sentSamples += frame.length
    const socket = this.socket
    if (socket) return this.sendFrame(socket, frame)
    // Disconnected: hold audio for the reconnect, within limits.
    this.queue.push(frame)
    this.queuedSamples += frame.length
    while (this.queuedSamples > MAX_QUEUED_SAMPLES && this.queue.length > 1) {
      this.queuedSamples -= this.queue.shift()!.length
      this.lost = true
    }
  }

  /** Flush the recognizer and wait for the server's coverage summary. */
  async finish(timeoutMs = 10_000): Promise<StreamSummary> {
    const fallback = (): StreamSummary => ({ complete: false, chunks: 0, seconds: this.secondsSent })
    if (this.aborted || this.dead) return fallback()
    if (this.summary) return this.summary
    this.finishing = true
    const socket = this.socket
    if (!socket) {
      // Give an in-flight reconnect a moment to finish before giving up.
      this.abort()
      return fallback()
    }
    try {
      socket.send(JSON.stringify({ type: 'finish' }))
    } catch {
      this.abort()
      return fallback()
    }
    const summary = await new Promise<StreamSummary | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs)
      this.doneWaiters.push((s) => {
        clearTimeout(timer)
        resolve(s)
      })
    })
    this.abort()
    return summary ?? fallback()
  }

  abort(): void {
    this.aborted = true
    this.queue = []
    this.queuedSamples = 0
    const socket = this.socket
    this.socket = null
    try {
      socket?.close()
    } catch {}
    this.resolveDone(null)
  }
}
