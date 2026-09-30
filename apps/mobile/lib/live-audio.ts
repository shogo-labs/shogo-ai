// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Browser-side live transcription capture. Taps the recording's MediaStream,
 * cuts ~8 s chunks at the quietest moment (so words aren't split across
 * chunks), resamples to 16 kHz mono WAV and hands each chunk to `onChunk`
 * one at a time. The full-file transcription after stop replaces the
 * preview these chunks produce.
 */

export const LIVE_SAMPLE_RATE = 16000
export const LIVE_MIN_CHUNK_SECONDS = 6
export const LIVE_TARGET_CHUNK_SECONDS = 8
export const LIVE_MAX_CHUNK_SECONDS = 12
/** Below this RMS the chunk is treated as silence and not sent (Whisper hallucinates on silence). */
export const LIVE_SILENCE_RMS = 0.004

export interface LiveChunk {
  wav: Blob
  /** Seconds from the start of the recording. */
  start: number
  seq: number
}

/**
 * Index to cut `samples` at: the centre of the quietest 100 ms window between
 * the minimum and maximum chunk length. Returns 0 when not enough audio is
 * buffered yet. A forced cut takes everything that fits in one chunk.
 */
export function pickCutIndex(samples: Float32Array, sampleRate: number, force = false): number {
  const min = Math.floor(LIVE_MIN_CHUNK_SECONDS * sampleRate)
  const target = Math.floor(LIVE_TARGET_CHUNK_SECONDS * sampleRate)
  const max = Math.floor(LIVE_MAX_CHUNK_SECONDS * sampleRate)
  if (samples.length < (force ? 1 : target)) return 0
  if (force && samples.length <= max) return samples.length
  const end = Math.min(samples.length, max)
  const window = Math.max(1, Math.floor(sampleRate / 10))
  let bestIndex = end
  let bestEnergy = Infinity
  for (let startIdx = min; startIdx + window <= end; startIdx += window) {
    let energy = 0
    for (let i = startIdx; i < startIdx + window; i++) energy += samples[i] * samples[i]
    if (energy < bestEnergy) {
      bestEnergy = energy
      bestIndex = startIdx + Math.floor(window / 2)
    }
  }
  return bestIndex
}

export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

/** Linear-interpolation resample to 16 kHz. Good enough for speech recognition. */
export function resampleTo16k(samples: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate === LIVE_SAMPLE_RATE) return samples
  const ratio = sampleRate / LIVE_SAMPLE_RATE
  const length = Math.max(1, Math.floor(samples.length / ratio))
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const pos = i * ratio
    const idx = Math.floor(pos)
    const frac = pos - idx
    const a = samples[idx] ?? 0
    const b = samples[idx + 1] ?? a
    out[i] = a + (b - a) * frac
  }
  return out
}

export function encodeWav16(samples: Float32Array, sampleRate = LIVE_SAMPLE_RATE): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buffer
}

export interface LiveSummary {
  /** Every chunk with speech was transcribed: none dropped, none failed. */
  complete: boolean
  /** Chunks the server acknowledged. */
  chunks: number
  /** Audio covered by the capture, silence included. */
  seconds: number
}

export interface LiveCapture {
  /**
   * Stop capturing. Sends the buffered tail unless `discard` is set and
   * resolves once it's acknowledged (or `timeoutMs` passes).
   */
  stop(options?: { discard?: boolean; timeoutMs?: number }): Promise<LiveSummary>
}

/**
 * Start chunking `stream`. `onChunk` calls are serialized; if the server is
 * slower than real time, chunks queue (bounded) rather than overlap. A
 * rejected `onChunk` marks the capture incomplete.
 */
export function startLiveCapture(stream: MediaStream, onChunk: (chunk: LiveChunk) => Promise<void>): LiveCapture | null {
  const Ctx = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext
  if (!Ctx) return null
  const ctx: AudioContext = new Ctx()
  const source = ctx.createMediaStreamSource(stream)
  // ScriptProcessor is deprecated but needs no separate worklet module, which
  // Metro can't serve as a standalone file.
  const processor = ctx.createScriptProcessor(4096, 1, 1)
  const sampleRate = ctx.sampleRate
  let pending: Float32Array[] = []
  let pendingLength = 0
  let consumed = 0
  let seq = 0
  let stopped = false
  const queue: LiveChunk[] = []
  let sending: Promise<void> | null = null
  let acked = 0
  let lost = false

  const sendQueued = async () => {
    while (queue.length > 0) {
      const next = queue.shift()!
      try {
        await onChunk(next)
        acked++
      } catch {
        lost = true
      }
    }
  }
  const drain = (): Promise<void> => {
    sending ??= sendQueued().finally(() => {
      sending = null
      if (queue.length) void drain()
    })
    return sending
  }
  const settle = async () => {
    while (sending || queue.length) await drain()
  }

  const flatten = () => {
    const all = new Float32Array(pendingLength)
    let offset = 0
    for (const part of pending) {
      all.set(part, offset)
      offset += part.length
    }
    return all
  }

  const emit = (force: boolean) => {
    if (pendingLength === 0) return
    const all = flatten()
    const cut = pickCutIndex(all, sampleRate, force)
    if (cut <= 0) return
    const head = all.subarray(0, cut)
    const rest = all.slice(cut)
    const start = consumed / sampleRate
    consumed += cut
    pending = rest.length ? [rest] : []
    pendingLength = rest.length
    const chunkSeq = seq++
    // The final tail can be short; mid-recording slivers are too short to transcribe well.
    if (rms(head) < LIVE_SILENCE_RMS || head.length < (force ? sampleRate / 4 : sampleRate)) return
    queue.push({ wav: new Blob([encodeWav16(resampleTo16k(head, sampleRate))], { type: 'audio/wav' }), start, seq: chunkSeq })
    // Keep at most ~30 s of backlog; a stalled server shouldn't grow memory forever.
    while (queue.length > 4) {
      queue.shift()
      lost = true
    }
    void drain()
  }

  processor.onaudioprocess = (event) => {
    if (stopped) return
    const input = event.inputBuffer.getChannelData(0)
    pending.push(new Float32Array(input))
    pendingLength += input.length
    if (pendingLength >= LIVE_TARGET_CHUNK_SECONDS * sampleRate) emit(false)
  }
  source.connect(processor)
  processor.connect(ctx.destination)
  // Created after an await (getUserMedia), so it can start suspended.
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {})

  let finished: Promise<LiveSummary> | null = null
  return {
    stop(options) {
      if (finished) return finished
      stopped = true
      try {
        processor.disconnect()
        source.disconnect()
      } catch {}
      if (options?.discard) {
        queue.length = 0
        lost = true
      } else {
        while (pendingLength > 0) emit(true)
      }
      void ctx.close().catch(() => {})
      const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), options?.timeoutMs ?? 10_000))
      finished = Promise.race([settle().then(() => 'done' as const), timeout]).then((outcome) => ({
        complete: outcome === 'done' && !lost,
        chunks: acked,
        seconds: consumed / sampleRate,
      }))
      return finished
    },
  }
}
