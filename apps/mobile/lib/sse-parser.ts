// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A spec-correct, bounded-buffer Server-Sent Events parser (SHO-580).
 *
 * The old stand-in in `polyfills.ts` parsed by re-joining every `data:` line
 * with no separator, ignored `id:` and `event:`, and mangled a `\r\n` stream.
 * It also lived on top of `XMLHttpRequest`, whose `responseText` only ever
 * grows: an hours-long team-chat stream kept every byte it had ever received in
 * one JS string, so `substring` and the parser itself got slower with age.
 *
 * This parser keeps only the tail it has not parsed yet — memory is flat no
 * matter how long the connection lives — and follows the event-stream format:
 * multi-line `data:` joined with `\n`, `id:` tracked as the last event id,
 * named events dispatched by type, comments ignored, and CR / CRLF accepted.
 *
 * A block that never terminates is a broken stream, not a big event: past
 * `MAX_SSE_BUFFER_CHARS` the buffer is dropped rather than held, so a hostile
 * or broken server cannot grow the JS heap without bound.
 */

/** The largest unterminated block worth holding. Real events are kilobytes. */
export const MAX_SSE_BUFFER_CHARS = 1024 * 1024

export interface SSEMessage {
  /** `message` unless the block carried an `event:` field. */
  type: string
  data: string
  /** The `id:` the block carried, or the last one seen before it. */
  lastEventId: string
}

export class SSEParser {
  private buffer = ''
  /** A trailing `\r` is held back: the `\n` that may follow arrives next chunk. */
  private pendingCR = false
  private dataLines: string[] = []
  private eventType = ''
  private lastEventId = ''
  /** Blocks dropped because the buffer passed its cap. */
  private droppedBlocks = 0

  /** Characters held between chunks — the reason memory stays flat. */
  get buffered(): number {
    return this.buffer.length
  }

  /** Blocks dropped for exceeding {@link MAX_SSE_BUFFER_CHARS}. */
  get dropped(): number {
    return this.droppedBlocks
  }

  /** The id a reconnect should send as `Last-Event-ID`. */
  get id(): string {
    return this.lastEventId
  }

  /**
   * Feed one decoded chunk. Returns every event it completed, in order, once.
   */
  push(chunk: string): SSEMessage[] {
    if (chunk) {
      let text = this.pendingCR ? `\r${chunk}` : chunk
      this.pendingCR = false
      if (text.endsWith('\r')) {
        text = text.slice(0, -1)
        this.pendingCR = true
      }
      this.buffer = (this.buffer + text).replace(/\r\n?/g, '\n')
    }

    const out: SSEMessage[] = []
    for (;;) {
      const boundary = this.buffer.indexOf('\n\n')
      if (boundary === -1) break
      const block = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 2)
      const message = this.consumeBlock(block)
      if (message) out.push(message)
    }

    if (this.buffer.length > MAX_SSE_BUFFER_CHARS) {
      this.buffer = ''
      this.dataLines = []
      this.eventType = ''
      this.droppedBlocks += 1
    }

    return out
  }

  /** Forget the unparsed tail and any half-built event (a new connection). */
  reset(): void {
    this.buffer = ''
    this.pendingCR = false
    this.dataLines = []
    this.eventType = ''
  }

  private consumeBlock(block: string): SSEMessage | null {
    for (const line of block.split('\n')) {
      if (!line) continue
      // A line starting with `:` is a comment (keep-alives are written this way).
      if (line.charCodeAt(0) === 58) continue
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)

      switch (field) {
        case 'data':
          this.dataLines.push(value)
          break
        case 'event':
          this.eventType = value
          break
        case 'id':
          if (!value.includes('\0')) this.lastEventId = value
          break
        default:
          // `retry:` and unknown fields are the reconnection policy's business,
          // which callers own (`team-chat-realtime`, `stream-fallback`).
          break
      }
    }

    const data = this.dataLines.join('\n')
    const type = this.eventType || 'message'
    this.dataLines = []
    this.eventType = ''
    // Per the format, a block with no data is not dispatched — a lone
    // `event:` name or a keep-alive comment produces nothing.
    if (!data) return null
    return { type, data, lastEventId: this.lastEventId }
  }
}
