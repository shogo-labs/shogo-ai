// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Live transcript feed for a desktop recording. Buffers the same 48 kHz Int16
 * PCM the RecordingManager writes to disk, mixes mic and system audio, cuts
 * ~8 s chunks at the quietest moment, downsamples to 16 kHz mono WAV and
 * POSTs them to the local API one at a time. The API transcribes each chunk
 * into the recording's draft meeting; the full-file pass after stop replaces
 * it.
 */

export const LIVE_SOURCE_RATE = 48000
const TARGET_RATE = 16000
const DECIMATE = LIVE_SOURCE_RATE / TARGET_RATE
const MIN_SECONDS = 6
const TARGET_SECONDS = 8
const MAX_SECONDS = 12
/** Int16 RMS below which a chunk is silence (Whisper hallucinates on silence). */
const SILENCE_RMS = 130
/** System audio that runs ahead of the mic by more than this is dropped. */
const MAX_SYSTEM_LEAD_SECONDS = 1
const MAX_QUEUE = 4

export interface LiveChunkPost {
  (chunk: { wav: Buffer; start: number; seq: number }): Promise<{ ok: boolean; status: number }>
}

export class LiveTranscriber {
  private mic: Int16Array[] = []
  private micLength = 0
  private system: Int16Array[] = []
  private systemLength = 0
  private consumed = 0
  private seq = 0
  private queue: { wav: Buffer; start: number; seq: number }[] = []
  private sending: Promise<void> | null = null
  private stopped = false
  private acked = 0
  /** A chunk with speech was dropped or failed, so the live transcript has a gap. */
  private lost = false

  /** `startOffsetSeconds`: where this audio sits on the recording's timeline (non-zero when it takes over from a stream). */
  constructor(private readonly post: LiveChunkPost, startOffsetSeconds = 0) {
    this.consumed = Math.round(startOffsetSeconds * LIVE_SOURCE_RATE)
  }

  /** Mono 48 kHz Int16 from the microphone. The mic is the timeline's clock. */
  feedMic(bytes: Uint8Array): void {
    if (this.stopped || bytes.byteLength < 2) return
    const samples = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.byteLength & ~1)))
    this.mic.push(samples)
    this.micLength += samples.length
    if (this.micLength >= TARGET_SECONDS * LIVE_SOURCE_RATE) this.emit(false)
  }

  /** Interleaved 48 kHz Int16 system audio, downmixed to mono here. */
  feedSystem(bytes: Uint8Array, channels: number): void {
    if (this.stopped || channels < 1) return
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
    const lead = this.systemLength - this.micLength
    if (lead > MAX_SYSTEM_LEAD_SECONDS * LIVE_SOURCE_RATE) {
      const all = concat(this.system, this.systemLength)
      const keep = all.subarray(lead - MAX_SYSTEM_LEAD_SECONDS * LIVE_SOURCE_RATE)
      this.system = [keep.slice()]
      this.systemLength = keep.length
    }
  }

  /** Stop feeding. The buffered tail is sent unless `discard`. */
  stop(options: { discard?: boolean } = {}): void {
    if (this.stopped) return
    if (options.discard) {
      this.queue = []
      this.lost = true
    } else {
      while (this.micLength > 0) this.emit(true)
    }
    this.stopped = true
  }

  /**
   * Send the tail and wait for every queued chunk. `complete` means the live
   * transcript covers the recording with no gaps, so the final pass can reuse it.
   */
  async finish(timeoutMs = 8000): Promise<{ complete: boolean; chunks: number; seconds: number }> {
    this.stop()
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = async () => {
      while (this.sending || this.queue.length) await this.drain()
    }
    const timedOut = await Promise.race([
      settle().then(() => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), timeoutMs) }),
    ])
    clearTimeout(timer)
    return { complete: !timedOut && !this.lost, chunks: this.acked, seconds: this.consumed / LIVE_SOURCE_RATE }
  }

  private emit(force: boolean): void {
    if (this.micLength === 0) return
    const mic = concat(this.mic, this.micLength)
    const cut = pickCutIndex(mic, force)
    if (cut <= 0) return
    const system = concat(this.system, this.systemLength)
    const head = mixInto(mic.subarray(0, cut), system.subarray(0, Math.min(cut, system.length)))
    const start = this.consumed / LIVE_SOURCE_RATE
    this.consumed += cut
    this.mic = cut < mic.length ? [mic.slice(cut)] : []
    this.micLength = mic.length - cut
    const systemUsed = Math.min(cut, system.length)
    this.system = systemUsed < system.length ? [system.slice(systemUsed)] : []
    this.systemLength = system.length - systemUsed
    const seq = this.seq++
    // The final tail can be short; mid-recording slivers are too short to transcribe well.
    if (head.length < (force ? LIVE_SOURCE_RATE / 4 : LIVE_SOURCE_RATE) || rms(head) < SILENCE_RMS) return
    this.queue.push({ wav: encodeWav16k(head), start, seq })
    while (this.queue.length > MAX_QUEUE) {
      this.queue.shift()
      this.lost = true
    }
    void this.drain()
  }

  private drain(): Promise<void> {
    this.sending ??= this.sendQueued().finally(() => {
      this.sending = null
      if (this.queue.length) void this.drain()
    })
    return this.sending
  }

  private async sendQueued(): Promise<void> {
    while (this.queue.length > 0) {
      const next = this.queue.shift()!
      let result = await this.post(next).catch(() => ({ ok: false, status: 0 }))
      // 429: the API was busy saving another write. The chunk is still good.
      for (let retry = 0; retry < 2 && result.status === 429; retry++) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (retry + 1)))
        result = await this.post(next).catch(() => ({ ok: false, status: 0 }))
      }
      if (result.ok) {
        this.acked++
        continue
      }
      this.lost = true
      // 409: the recording already finished. 503: no transcription backend,
      // so every later chunk would fail the same way.
      if (result.status === 409 || result.status === 503) {
        this.queue = []
        this.stopped = true
      }
    }
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

function mixInto(mic: Int16Array, system: Int16Array): Int16Array {
  if (system.length === 0) return mic
  const out = new Int16Array(mic.length)
  for (let i = 0; i < mic.length; i++) {
    const v = mic[i] * 0.7 + (i < system.length ? system[i] * 0.7 : 0)
    out[i] = v >= 32767 ? 32767 : v <= -32768 ? -32768 : Math.round(v)
  }
  return out
}

export function pickCutIndex(samples: Int16Array, force: boolean, sampleRate = LIVE_SOURCE_RATE): number {
  const min = MIN_SECONDS * sampleRate
  const target = TARGET_SECONDS * sampleRate
  const max = MAX_SECONDS * sampleRate
  if (samples.length < (force ? 1 : target)) return 0
  // A forced cut takes everything that fits in one chunk.
  if (force && samples.length <= max) return samples.length
  const end = Math.min(samples.length, max)
  const window = Math.floor(sampleRate / 10)
  let best = end
  let bestEnergy = Infinity
  for (let start = min; start + window <= end; start += window) {
    let energy = 0
    for (let i = start; i < start + window; i++) energy += samples[i] * samples[i]
    if (energy < bestEnergy) {
      bestEnergy = energy
      best = start + Math.floor(window / 2)
    }
  }
  return best
}

export function rms(samples: Int16Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

/** Box-filter decimation 48 kHz -> 16 kHz, wrapped in a canonical WAV header. */
export function encodeWav16k(samples: Int16Array): Buffer {
  const frames = Math.floor(samples.length / DECIMATE)
  const buf = Buffer.alloc(44 + frames * 2)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + frames * 2, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(TARGET_RATE, 24)
  buf.writeUInt32LE(TARGET_RATE * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(frames * 2, 40)
  for (let i = 0; i < frames; i++) {
    let acc = 0
    for (let j = 0; j < DECIMATE; j++) acc += samples[i * DECIMATE + j]
    buf.writeInt16LE(Math.round(acc / DECIMATE), 44 + i * 2)
  }
  return buf
}
