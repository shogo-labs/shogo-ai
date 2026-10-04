// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Streaming live transcript for a desktop recording. Mixes the same 48 kHz
 * PCM the RecordingManager writes to disk (mic is the clock, system audio is
 * mixed in), decimates it to 16 kHz mono Int16 and streams it to the local API
 * as the body of one long chunked POST. The API answers with a coverage
 * summary when the body ends. If streaming isn't available, `LiveFeed` falls
 * back to the chunk uploader (`LiveTranscriber`).
 */
import http from 'http'
import https from 'https'
import { LIVE_SOURCE_RATE } from './live-transcriber'

const DECIMATE = LIVE_SOURCE_RATE / 16000
/** System audio that runs ahead of the mic by more than this is dropped. */
const MAX_SYSTEM_LEAD_SECONDS = 1

export interface LiveSummary {
  complete: boolean
  chunks: number
  seconds: number
}

/** What `LiveFeed` drives: the chunk uploader and the streamer both fit. */
export interface PcmSink {
  feedMic(bytes: Uint8Array): void
  feedSystem(bytes: Uint8Array, channels: number): void
  stop(options?: { discard?: boolean }): void
  finish(timeoutMs?: number): Promise<LiveSummary>
}

/** Mixes mic and system audio and decimates to 16 kHz. Pure: output goes to `emit`. */
export class StreamMixer {
  private system: Int16Array[] = []
  private systemLength = 0
  private carry: number[] = []
  /** Mic seconds consumed, i.e. where the stream is on the recording's timeline. */
  micSamples = 0

  constructor(private readonly emit: (pcm16k: Buffer) => void) {}

  feedMic(bytes: Uint8Array): void {
    if (bytes.byteLength < 2) return
    const mic = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.byteLength & ~1)))
    this.micSamples += mic.length
    const system = this.takeSystem(mic.length)
    const mixed = new Int16Array(mic.length)
    for (let i = 0; i < mic.length; i++) {
      const v = system ? mic[i] * 0.7 + (i < system.length ? system[i] * 0.7 : 0) : mic[i]
      mixed[i] = v >= 32767 ? 32767 : v <= -32768 ? -32768 : Math.round(v)
    }
    this.decimate(mixed)
  }

  /** Interleaved 48 kHz Int16 system audio, downmixed to mono. */
  feedSystem(bytes: Uint8Array, channels: number): void {
    if (channels < 1) return
    const frameBytes = channels * 2
    const frames = Math.floor(bytes.byteLength / frameBytes)
    if (frames === 0) return
    const view = new DataView(bytes.buffer, bytes.byteOffset, frames * frameBytes)
    const mono = new Int16Array(frames)
    for (let i = 0; i < frames; i++) {
      let acc = 0
      for (let c = 0; c < channels; c++) acc += view.getInt16(i * frameBytes + c * 2, true)
      mono[i] = Math.round(acc / channels)
    }
    this.system.push(mono)
    this.systemLength += mono.length
    const limit = MAX_SYSTEM_LEAD_SECONDS * LIVE_SOURCE_RATE
    if (this.systemLength > limit) {
      const all = concat(this.system, this.systemLength)
      const keep = all.subarray(all.length - limit)
      this.system = [keep.slice()]
      this.systemLength = keep.length
    }
  }

  /** Up to `count` buffered system samples, oldest first. */
  private takeSystem(count: number): Int16Array | null {
    if (this.systemLength === 0) return null
    const all = concat(this.system, this.systemLength)
    const used = Math.min(count, all.length)
    const head = all.slice(0, used)
    this.system = used < all.length ? [all.slice(used)] : []
    this.systemLength = all.length - used
    return head
  }

  private decimate(samples: Int16Array): void {
    const input = this.carry.length ? concatArray(this.carry, samples) : samples
    const frames = Math.floor(input.length / DECIMATE)
    this.carry = Array.from(input.subarray(frames * DECIMATE))
    if (frames === 0) return
    const out = Buffer.alloc(frames * 2)
    for (let i = 0; i < frames; i++) {
      let acc = 0
      for (let j = 0; j < DECIMATE; j++) acc += input[i * DECIMATE + j]
      out.writeInt16LE(Math.round(acc / DECIMATE), i * 2)
    }
    this.emit(out)
  }
}

function concat(parts: Int16Array[], length: number): Int16Array {
  if (parts.length === 1) return parts[0]
  const out = new Int16Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function concatArray(head: number[], tail: Int16Array): Int16Array {
  const out = new Int16Array(head.length + tail.length)
  out.set(head, 0)
  out.set(tail, head.length)
  return out
}

export interface StreamerOptions {
  /** `.../api/local/meetings/recordings/:id` */
  draftUrl: string
  headers?: Record<string, string>
  /** The stream died after it had started; the caller falls back to chunks. */
  onBroken(): void
}

/** Streams the mixed audio to `${draftUrl}/audio-stream`. */
export class HttpPcmStreamer implements PcmSink {
  private req: http.ClientRequest | null = null
  private mixer: StreamMixer
  private response: Promise<LiveSummary | null> | null = null
  private ended = false
  private broken = false

  constructor(private readonly options: StreamerOptions) {
    this.mixer = new StreamMixer((pcm) => this.write(pcm))
  }

  /** Seconds of audio mixed so far (mic is the clock). */
  get seconds(): number {
    return this.mixer.micSamples / LIVE_SOURCE_RATE
  }

  /**
   * Ask whether the API can stream (it answers 501 when no recognizer is
   * installed or configured) and open the request. False means use chunks.
   */
  async start(): Promise<boolean> {
    try {
      const probe = await fetch(`${this.options.draftUrl}/stream-ticket`, { method: 'POST', headers: this.options.headers })
      if (!probe.ok) return false
    } catch {
      return false
    }
    const url = new URL(`${this.options.draftUrl}/audio-stream`)
    const transport = url.protocol === 'https:' ? https : http
    const req = transport.request(url, {
      method: 'POST',
      headers: { ...this.options.headers, 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' },
    })
    this.req = req
    this.response = new Promise<LiveSummary | null>((resolve) => {
      req.on('response', (res) => {
        let body = ''
        res.on('data', (d: Buffer) => {
          body += d.toString()
        })
        res.on('end', () => {
          // A reply before we ended the body means the API gave up on the stream.
          if (!this.ended) this.markBroken()
          try {
            const parsed = JSON.parse(body)
            resolve(
              res.statusCode === 200 && parsed?.ok
                ? { complete: parsed.complete === true, chunks: Number(parsed.chunks) || 0, seconds: Number(parsed.seconds) || 0 }
                : null,
            )
          } catch {
            resolve(null)
          }
        })
        res.on('error', () => resolve(null))
      })
      req.on('error', () => {
        if (!this.ended) this.markBroken()
        resolve(null)
      })
    })
    return true
  }

  private markBroken(): void {
    if (this.broken) return
    this.broken = true
    try {
      this.req?.destroy()
    } catch {}
    this.options.onBroken()
  }

  private write(pcm: Buffer): void {
    if (this.ended || this.broken || !this.req) return
    try {
      this.req.write(pcm)
    } catch {
      this.markBroken()
    }
  }

  feedMic(bytes: Uint8Array): void {
    if (!this.ended) this.mixer.feedMic(bytes)
  }

  feedSystem(bytes: Uint8Array, channels: number): void {
    if (!this.ended) this.mixer.feedSystem(bytes, channels)
  }

  stop(options: { discard?: boolean } = {}): void {
    if (this.ended) return
    this.ended = true
    if (options.discard) {
      try {
        this.req?.destroy()
      } catch {}
    } else {
      try {
        this.req?.end()
      } catch {}
    }
  }

  async finish(timeoutMs = 10_000): Promise<LiveSummary> {
    const seconds = this.seconds
    this.stop()
    let timer: ReturnType<typeof setTimeout> | undefined
    const summary = await Promise.race([
      this.response ?? Promise.resolve(null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
    clearTimeout(timer)
    if (!summary) {
      try {
        this.req?.destroy()
      } catch {}
    }
    if (!summary || this.broken) return { complete: false, chunks: 0, seconds }
    return summary
  }
}

/**
 * Feeds PCM to a streamer, or to the chunk uploader when streaming isn't
 * available or breaks. Audio that arrives while the choice is made is held
 * and replayed, so deciding never costs the start of the meeting.
 */
export class LiveFeed implements PcmSink {
  private sink: PcmSink | null = null
  private held: Array<{ mic: true; bytes: Uint8Array } | { mic: false; bytes: Uint8Array; channels: number }> = []
  private streamer: HttpPcmStreamer | null = null
  private streamBroke = false
  private stopped = false

  constructor(
    private readonly makeStreamer: (onBroken: () => void) => HttpPcmStreamer,
    private readonly makeChunker: (startOffsetSeconds: number) => PcmSink,
  ) {}

  /** Decide the path. Resolves once audio is flowing to one of them. */
  async begin(): Promise<'stream' | 'chunks'> {
    const streamer = this.makeStreamer(() => this.fallBack())
    this.streamer = streamer
    const ok = await streamer.start().catch(() => false)
    if (this.stopped) return ok ? 'stream' : 'chunks'
    if (ok) {
      this.attach(streamer)
      return 'stream'
    }
    this.streamer = null
    this.attach(this.makeChunker(0))
    return 'chunks'
  }

  private attach(sink: PcmSink): void {
    this.sink = sink
    const held = this.held
    this.held = []
    for (const item of held) {
      if (item.mic) sink.feedMic(item.bytes)
      else sink.feedSystem(item.bytes, item.channels)
    }
  }

  private fallBack(): void {
    if (this.stopped || !this.streamer) return
    this.streamBroke = true
    const offset = this.streamer.seconds
    this.streamer = null
    this.attach(this.makeChunker(offset))
  }

  feedMic(bytes: Uint8Array): void {
    if (this.sink) this.sink.feedMic(bytes)
    else if (this.held.length < 2000) this.held.push({ mic: true, bytes })
  }

  feedSystem(bytes: Uint8Array, channels: number): void {
    if (this.sink) this.sink.feedSystem(bytes, channels)
    else if (this.held.length < 2000) this.held.push({ mic: false, bytes, channels })
  }

  stop(options: { discard?: boolean } = {}): void {
    this.stopped = true
    this.sink?.stop(options)
  }

  async finish(timeoutMs?: number): Promise<LiveSummary> {
    this.stopped = true
    const summary = await (this.sink?.finish(timeoutMs) ?? Promise.resolve({ complete: false, chunks: 0, seconds: 0 }))
    return this.streamBroke ? { ...summary, complete: false } : summary
  }
}
