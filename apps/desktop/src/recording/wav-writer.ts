// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Streaming WAV writer for Int16 PCM. Used by RecordingManager to persist
 * the renderer-supplied mic stream and the shogo-sysaudio system stream.
 *
 * Writes a 44-byte canonical RIFF header up-front with size fields zeroed,
 * appends PCM frames as they arrive, and rewrites the size fields
 * periodically (every ~5 s) so a crash mid-recording leaves a valid-ish
 * WAV instead of a truncated one. A final header rewrite happens on
 * `finalize()`.
 */
import { openSync, writeSync, closeSync, fsyncSync, fstatSync } from 'fs'

export interface WavWriterOptions {
  path: string
  sampleRate: number
  channels: number
  bitsPerSample?: number
  /** How often the header is rewritten while the file is open. 0 disables. */
  flushHeaderIntervalMs?: number
}

const DEFAULT_BITS = 16
const DEFAULT_FLUSH_INTERVAL = 5_000
const WAV_HEADER_SIZE = 44

export class WavWriter {
  private readonly fd: number
  private readonly path: string
  private readonly sampleRate: number
  private readonly channels: number
  private readonly bitsPerSample: number
  private dataBytes = 0
  private closed = false
  private readonly flushTimer: NodeJS.Timeout | null = null

  constructor(opts: WavWriterOptions) {
    this.path = opts.path
    this.sampleRate = opts.sampleRate
    this.channels = opts.channels
    this.bitsPerSample = opts.bitsPerSample ?? DEFAULT_BITS

    if (this.bitsPerSample !== 16) {
      throw new Error(`WavWriter currently only supports 16-bit PCM (got ${this.bitsPerSample})`)
    }

    this.fd = openSync(this.path, 'w')
    writeSync(this.fd, this.buildHeader(0), 0, WAV_HEADER_SIZE, 0)

    const interval = opts.flushHeaderIntervalMs ?? DEFAULT_FLUSH_INTERVAL
    if (interval > 0) {
      this.flushTimer = setInterval(() => this.flushHeader(), interval)
      this.flushTimer.unref?.()
    }
  }

  /** Append PCM bytes. Accepts Buffer or any Int16/Uint8-typed array view. */
  write(chunk: Buffer | Uint8Array): void {
    if (this.closed) return
    if (chunk.length === 0) return
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    writeSync(this.fd, buf, 0, buf.length)
    this.dataBytes += buf.length
  }

  /** Finalise the header with the true data size and close the file. */
  finalize(): { path: string; dataBytes: number; durationSeconds: number } {
    if (this.closed) {
      return {
        path: this.path,
        dataBytes: this.dataBytes,
        durationSeconds: this.durationSeconds(),
      }
    }
    if (this.flushTimer) clearInterval(this.flushTimer)
    this.flushHeader()
    try { fsyncSync(this.fd) } catch { /* best-effort */ }
    try { closeSync(this.fd) } catch { /* best-effort */ }
    this.closed = true
    return {
      path: this.path,
      dataBytes: this.dataBytes,
      durationSeconds: this.durationSeconds(),
    }
  }

  /** Whether the underlying file handle is still open. */
  get isOpen(): boolean { return !this.closed }

  /** Current PCM byte count. */
  get bytesWritten(): number { return this.dataBytes }

  /** Current audio duration based on bytes written. */
  durationSeconds(): number {
    const bytesPerSample = (this.bitsPerSample / 8) * this.channels
    if (bytesPerSample === 0 || this.sampleRate === 0) return 0
    const totalFrames = this.dataBytes / bytesPerSample
    return totalFrames / this.sampleRate
  }

  private flushHeader(): void {
    if (this.closed) return
    try {
      // Sanity: if the on-disk size is ahead of our counter (unlikely unless
      // someone else is writing to the fd), trust the stat value so the
      // header reflects reality.
      const stat = fstatSync(this.fd)
      const dataSize = Math.max(0, stat.size - WAV_HEADER_SIZE)
      this.dataBytes = dataSize
      writeSync(this.fd, this.buildHeader(dataSize), 0, WAV_HEADER_SIZE, 0)
    } catch {
      // Best-effort — a transient EBUSY here is not fatal; next flush retries.
    }
  }

  private buildHeader(dataSize: number): Buffer {
    const buf = Buffer.alloc(WAV_HEADER_SIZE)
    const byteRate = this.sampleRate * this.channels * (this.bitsPerSample / 8)
    const blockAlign = this.channels * (this.bitsPerSample / 8)

    buf.write('RIFF', 0, 'ascii')
    buf.writeUInt32LE(36 + dataSize, 4)
    buf.write('WAVE', 8, 'ascii')
    buf.write('fmt ', 12, 'ascii')
    buf.writeUInt32LE(16, 16) // fmt chunk size
    buf.writeUInt16LE(1, 20) // PCM
    buf.writeUInt16LE(this.channels, 22)
    buf.writeUInt32LE(this.sampleRate, 24)
    buf.writeUInt32LE(byteRate, 28)
    buf.writeUInt16LE(blockAlign, 32)
    buf.writeUInt16LE(this.bitsPerSample, 34)
    buf.write('data', 36, 'ascii')
    buf.writeUInt32LE(dataSize, 40)
    return buf
  }
}
