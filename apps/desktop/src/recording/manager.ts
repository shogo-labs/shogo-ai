// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Main-process recording orchestrator.
 *
 * Responsibilities
 * ----------------
 * - Maintain the current recording session (id, directory, WAV writers).
 * - Write mic PCM supplied by the renderer to `mic.wav`.
 * - On macOS, spawn the `shogo-sysaudio` Swift helper and tee its PCM into
 *   `system.wav`. Windows system audio is captured in the renderer via
 *   `getDisplayMedia` and arrives through the same IPC channel as mic.
 * - On `stopSession`, optionally post-hoc mix the two files into a single
 *   `audio.wav` so downstream consumers (Meeting row, transcription) keep
 *   seeing one audio path.
 *
 * The manager is intentionally dumb about IPC — `recording.ts` wires it to
 * `ipcMain` and to the renderer.
 */
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, openSync, readSync, closeSync, statSync, fstatSync } from 'fs'
import path from 'path'
import { WavWriter } from './wav-writer'

export interface SessionInfo {
  id: string
  dir: string
  micPath: string
  systemPath: string | null
  primaryPath: string
  platform: NodeJS.Platform
  captureSystemAudio: boolean
  startedAt: number
}

export interface PcmMeta {
  sampleRate: number
  channels: number
  bitsPerSample: number
  frames: number
}

export interface RecordingManagerOptions {
  /** Base directory for session subdirectories. Usually `userData/data/recordings`. */
  recordingsDir: string
  /** Absolute path to the shogo-sysaudio binary (macOS only). */
  sysAudioBinary: string | null
  /** Fired on significant lifecycle milestones so the main-process code can
   *  forward them to the renderer / log them. */
  onEvent?: (event: RecordingEvent) => void
}

export type RecordingEvent =
  | { type: 'session-started'; session: SessionInfo }
  | { type: 'session-stopped'; session: SessionInfo; duration: number; micBytes: number; systemBytes: number; mixedCreated: boolean }
  | { type: 'session-aborted'; id: string; reason: string }
  | { type: 'source-ready'; source: 'mic' | 'system'; sampleRate: number; channels: number }
  | { type: 'source-error'; source: 'mic' | 'system'; message: string }
  | { type: 'warning'; message: string }

interface ActiveRecording extends SessionInfo {
  micWriter: WavWriter
  systemWriter: WavWriter | null
  sysProc: ChildProcess | null
  sysStderrBuf: string
  micMeta: PcmMeta | null
  systemMeta: PcmMeta | null
  sysStarted: boolean
}

export class RecordingManager {
  private readonly opts: RecordingManagerOptions
  private current: ActiveRecording | null = null

  constructor(opts: RecordingManagerOptions) {
    this.opts = opts
  }

  isRecording(): boolean {
    return this.current !== null
  }

  status(): { isRecording: boolean; id: string | null; audioPath: string | null; duration: number } {
    if (!this.current) {
      return { isRecording: false, id: null, audioPath: null, duration: 0 }
    }
    return {
      isRecording: true,
      id: this.current.id,
      audioPath: this.current.primaryPath,
      duration: Math.floor((Date.now() - this.current.startedAt) / 1000),
    }
  }

  async startSession(platform: NodeJS.Platform): Promise<SessionInfo> {
    if (this.current) throw new Error('already recording')

    const id = generateSessionId()
    const dir = path.join(this.opts.recordingsDir, id)
    mkdirSync(dir, { recursive: true })

    const micPath = path.join(dir, 'mic.wav')
    const captureSystemAudio = platform === 'win32' || (platform === 'darwin' && !!this.opts.sysAudioBinary)
    const systemPath = captureSystemAudio ? path.join(dir, 'system.wav') : null

    // mic is always mono/48k/int16 from the renderer worklet.
    const micWriter = new WavWriter({
      path: micPath,
      sampleRate: 48000,
      channels: 1,
      bitsPerSample: 16,
    })
    // System is stereo/48k/int16 on both OSes (shogo-sysaudio + Chromium loopback).
    const systemWriter = systemPath
      ? new WavWriter({ path: systemPath, sampleRate: 48000, channels: 2, bitsPerSample: 16 })
      : null

    const session: ActiveRecording = {
      id,
      dir,
      micPath,
      systemPath,
      primaryPath: micPath, // overwritten on stop if a mix is produced
      platform,
      captureSystemAudio,
      startedAt: Date.now(),
      micWriter,
      systemWriter,
      sysProc: null,
      sysStderrBuf: '',
      micMeta: null,
      systemMeta: null,
      sysStarted: false,
    }

    if (platform === 'darwin' && this.opts.sysAudioBinary && systemWriter) {
      try {
        session.sysProc = this.spawnSysAudio(session, systemWriter)
      } catch (err) {
        this.emit({ type: 'warning', message: `shogo-sysaudio spawn failed: ${(err as Error).message}` })
      }
    }

    this.current = session
    this.emit({ type: 'session-started', session: toSessionInfo(session) })
    return toSessionInfo(session)
  }

  /** Called by the IPC layer for every PCM chunk arriving from the renderer. */
  writePcm(sessionId: string, source: 'mic' | 'system', buffer: ArrayBuffer, meta: PcmMeta): void {
    const current = this.current
    if (!current || current.id !== sessionId) return

    if (source === 'mic') {
      if (!current.micMeta) {
        current.micMeta = meta
        this.emit({ type: 'source-ready', source: 'mic', sampleRate: meta.sampleRate, channels: meta.channels })
      }
      current.micWriter.write(new Uint8Array(buffer))
      return
    }

    // Windows: system audio routed through renderer. Mac: ignored — handled
    // by shogo-sysaudio child.
    if (current.platform !== 'win32') return
    if (!current.systemWriter) return
    if (!current.systemMeta) {
      current.systemMeta = meta
      this.emit({ type: 'source-ready', source: 'system', sampleRate: meta.sampleRate, channels: meta.channels })
    }
    current.systemWriter.write(new Uint8Array(buffer))
  }

  abortSession(sessionId: string, reason: string): void {
    const current = this.current
    if (!current || current.id !== sessionId) return
    try { current.micWriter.finalize() } catch { /* ignore */ }
    try { current.systemWriter?.finalize() } catch { /* ignore */ }
    if (current.sysProc && !current.sysProc.killed) {
      try { current.sysProc.stdin?.write('quit\n') } catch { /* ignore */ }
      try { current.sysProc.kill('SIGTERM') } catch { /* ignore */ }
    }
    this.current = null
    this.emit({ type: 'session-aborted', id: sessionId, reason })
  }

  async stopSession(): Promise<{ id: string; audioPath: string; duration: number } | null> {
    const current = this.current
    if (!current) return null
    this.current = null

    // Stop the sysaudio child first so it drains before we close writers.
    if (current.sysProc && !current.sysProc.killed) {
      try { current.sysProc.stdin?.write('stop\n') } catch { /* ignore */ }
      await waitForSysProcExit(current.sysProc, 1_500)
      try { current.sysProc.stdin?.write('quit\n') } catch { /* ignore */ }
      await waitForSysProcExit(current.sysProc, 1_500)
      if (!current.sysProc.killed) {
        try { current.sysProc.kill('SIGTERM') } catch { /* ignore */ }
      }
    }

    const micResult = current.micWriter.finalize()
    const systemResult = current.systemWriter?.finalize() ?? null

    let primaryPath = current.micPath
    let mixedCreated = false
    if (systemResult && systemResult.dataBytes > 0 && micResult.dataBytes > 0) {
      const mixedPath = path.join(current.dir, 'audio.wav')
      try {
        mixMonoStereo16k(micResult.path, systemResult.path, mixedPath)
        primaryPath = mixedPath
        mixedCreated = true
      } catch (err) {
        this.emit({ type: 'warning', message: `post-hoc mix failed: ${(err as Error).message}` })
      }
    } else if (systemResult && systemResult.dataBytes > 0 && micResult.dataBytes === 0) {
      // Mic was empty; prefer the system-only stream as fallback.
      primaryPath = systemResult.path
    }

    const duration = Math.max(1, Math.floor((Date.now() - current.startedAt) / 1000))

    this.emit({
      type: 'session-stopped',
      session: { ...toSessionInfo(current), primaryPath },
      duration,
      micBytes: micResult.dataBytes,
      systemBytes: systemResult?.dataBytes ?? 0,
      mixedCreated,
    })

    return { id: current.id, audioPath: primaryPath, duration }
  }

  private spawnSysAudio(session: ActiveRecording, writer: WavWriter): ChildProcess {
    if (!this.opts.sysAudioBinary) throw new Error('shogo-sysaudio binary path not configured')

    const proc = spawn(this.opts.sysAudioBinary, [], { stdio: ['pipe', 'pipe', 'pipe'] })

    proc.stdout?.on('data', (data: Buffer) => {
      if (!this.current || this.current.id !== session.id) return
      writer.write(data)
    })

    proc.stderr?.on('data', (data: Buffer) => {
      session.sysStderrBuf += data.toString('utf8')
      let nl: number
      while ((nl = session.sysStderrBuf.indexOf('\n')) !== -1) {
        const line = session.sysStderrBuf.slice(0, nl).trim()
        session.sysStderrBuf = session.sysStderrBuf.slice(nl + 1)
        if (!line) continue
        try {
          const evt = JSON.parse(line) as { type: string; message?: string; sampleRate?: number; channels?: number }
          if (evt.type === 'ready') {
            try { proc.stdin?.write('start\n') } catch { /* ignore */ }
          } else if (evt.type === 'started') {
            session.sysStarted = true
            session.systemMeta = {
              sampleRate: evt.sampleRate ?? 48000,
              channels: evt.channels ?? 2,
              bitsPerSample: 16,
              frames: 0,
            }
            this.emit({
              type: 'source-ready',
              source: 'system',
              sampleRate: session.systemMeta.sampleRate,
              channels: session.systemMeta.channels,
            })
          } else if (evt.type === 'error') {
            this.emit({ type: 'source-error', source: 'system', message: evt.message ?? 'unknown error' })
          } else if (evt.type === 'warning') {
            this.emit({ type: 'warning', message: `shogo-sysaudio: ${evt.message ?? ''}` })
          }
        } catch {
          // Non-JSON noise; ignore.
        }
      }
    })

    proc.on('error', (err) => {
      this.emit({ type: 'source-error', source: 'system', message: `shogo-sysaudio: ${err.message}` })
    })

    proc.on('exit', (code, signal) => {
      if (this.current && this.current.id === session.id && !this.current.sysStarted) {
        this.emit({
          type: 'source-error',
          source: 'system',
          message: `shogo-sysaudio exited before ready (code=${code} signal=${signal})`,
        })
      }
    })

    return proc
  }

  private emit(event: RecordingEvent): void {
    try { this.opts.onEvent?.(event) } catch { /* listener errors are not our problem */ }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateSessionId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  return `recording-${ts}`
}

function toSessionInfo(s: ActiveRecording): SessionInfo {
  return {
    id: s.id,
    dir: s.dir,
    micPath: s.micPath,
    systemPath: s.systemPath,
    primaryPath: s.primaryPath,
    platform: s.platform,
    captureSystemAudio: s.captureSystemAudio,
    startedAt: s.startedAt,
  }
}

async function waitForSysProcExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
  if (proc.exitCode !== null) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * Post-hoc mix of a mono 48kHz/Int16 WAV (`mic`) and a stereo 48kHz/Int16
 * WAV (`system`) into a new mono 48kHz/Int16 WAV (`outPath`).
 *
 * We read a small chunk at a time to keep peak memory bounded. If one stream
 * runs out before the other, the tail is carried through at full gain.
 */
function mixMonoStereo16k(micPath: string, systemPath: string, outPath: string): void {
  const micInfo = findDataChunk(micPath)
  const sysInfo = findDataChunk(systemPath)
  if (!micInfo.valid || !sysInfo.valid) {
    throw new Error('could not locate PCM data chunks in input WAVs')
  }
  if (micInfo.sampleRate !== sysInfo.sampleRate) {
    throw new Error(`sample rate mismatch: mic=${micInfo.sampleRate} system=${sysInfo.sampleRate}`)
  }
  if (micInfo.bitsPerSample !== 16 || sysInfo.bitsPerSample !== 16) {
    throw new Error('mixer only supports 16-bit PCM')
  }

  const sampleRate = micInfo.sampleRate
  const micChannels = micInfo.channels
  const sysChannels = sysInfo.channels

  const CHUNK_FRAMES = 4096
  const micBytesPerFrame = micChannels * 2
  const sysBytesPerFrame = sysChannels * 2
  const micChunkBytes = CHUNK_FRAMES * micBytesPerFrame
  const sysChunkBytes = CHUNK_FRAMES * sysBytesPerFrame

  const writer = new WavWriter({ path: outPath, sampleRate, channels: 1, bitsPerSample: 16, flushHeaderIntervalMs: 0 })
  const micFd = openSync(micPath, 'r')
  const sysFd = openSync(systemPath, 'r')
  try {
    let micPos = micInfo.dataOffset
    let sysPos = sysInfo.dataOffset
    const micEnd = micInfo.dataOffset + micInfo.dataSize
    const sysEnd = sysInfo.dataOffset + sysInfo.dataSize

    const micBuf = Buffer.alloc(micChunkBytes)
    const sysBuf = Buffer.alloc(sysChunkBytes)

    while (micPos < micEnd || sysPos < sysEnd) {
      const micBytesToRead = Math.max(0, Math.min(micChunkBytes, micEnd - micPos))
      const sysBytesToRead = Math.max(0, Math.min(sysChunkBytes, sysEnd - sysPos))

      const micRead = micBytesToRead > 0 ? readSync(micFd, micBuf, 0, micBytesToRead, micPos) : 0
      const sysRead = sysBytesToRead > 0 ? readSync(sysFd, sysBuf, 0, sysBytesToRead, sysPos) : 0
      micPos += micRead
      sysPos += sysRead

      const micFrames = micRead / micBytesPerFrame
      const sysFrames = sysRead / sysBytesPerFrame
      const frames = Math.max(micFrames, sysFrames)
      if (frames === 0) break

      const out = new Int16Array(frames)
      for (let i = 0; i < frames; i++) {
        let micSample = 0
        if (i < micFrames) {
          if (micChannels === 1) {
            micSample = micBuf.readInt16LE(i * 2)
          } else {
            // Downmix if mic is ever stereo — average channels.
            let acc = 0
            for (let c = 0; c < micChannels; c++) acc += micBuf.readInt16LE(i * micBytesPerFrame + c * 2)
            micSample = Math.round(acc / micChannels)
          }
        }

        let sysSample = 0
        if (i < sysFrames) {
          let acc = 0
          for (let c = 0; c < sysChannels; c++) acc += sysBuf.readInt16LE(i * sysBytesPerFrame + c * 2)
          sysSample = Math.round(acc / sysChannels)
        }

        const sum = micSample * 0.7 + sysSample * 0.7
        out[i] = clampInt16(sum)
      }

      writer.write(new Uint8Array(out.buffer, out.byteOffset, out.byteLength))
    }
  } finally {
    closeSync(micFd)
    closeSync(sysFd)
    writer.finalize()
  }
}

function clampInt16(v: number): number {
  if (v >= 32767) return 32767
  if (v <= -32768) return -32768
  return Math.round(v)
}

interface WavDataInfo {
  valid: boolean
  sampleRate: number
  channels: number
  bitsPerSample: number
  dataOffset: number
  dataSize: number
}

/**
 * Walk a WAV file's RIFF chunk list and return the location of the PCM
 * data chunk. Mirrors the robust header parser used by the test helpers.
 */
function findDataChunk(filePath: string): WavDataInfo {
  const invalid: WavDataInfo = {
    valid: false, sampleRate: 0, channels: 0, bitsPerSample: 0, dataOffset: 0, dataSize: 0,
  }
  const fd = openSync(filePath, 'r')
  try {
    const stat = fstatSync(fd)
    const fileSize = stat.size
    if (fileSize < 44) return invalid

    const riffHeader = Buffer.alloc(12)
    if (readSync(fd, riffHeader, 0, 12, 0) !== 12) return invalid
    if (riffHeader.toString('ascii', 0, 4) !== 'RIFF') return invalid
    if (riffHeader.toString('ascii', 8, 12) !== 'WAVE') return invalid

    let offset = 12
    let channels = 0
    let sampleRate = 0
    let bitsPerSample = 0
    let dataOffset = 0
    let dataSize = 0
    let sawFmt = false

    const chunkHeader = Buffer.alloc(8)
    while (offset + 8 <= fileSize) {
      if (readSync(fd, chunkHeader, 0, 8, offset) !== 8) break
      const id = chunkHeader.toString('ascii', 0, 4)
      const size = chunkHeader.readUInt32LE(4)
      const payloadStart = offset + 8

      if (id === 'fmt ') {
        const fmt = Buffer.alloc(Math.min(size, 40))
        readSync(fd, fmt, 0, fmt.length, payloadStart)
        channels = fmt.readUInt16LE(2)
        sampleRate = fmt.readUInt32LE(4)
        bitsPerSample = fmt.readUInt16LE(14)
        sawFmt = true
      } else if (id === 'data') {
        dataSize = Math.min(size, fileSize - payloadStart)
        dataOffset = payloadStart
        break
      }

      offset = payloadStart + size + (size % 2)
    }

    if (!sawFmt || dataOffset === 0) return invalid
    return { valid: true, sampleRate, channels, bitsPerSample, dataOffset, dataSize }
  } finally {
    closeSync(fd)
  }
}

// Export helpers that are useful to tests.
export const __testing = { findDataChunk, mixMonoStereo16k }

// Avoid unused-import warnings in strict mode.
void statSync
