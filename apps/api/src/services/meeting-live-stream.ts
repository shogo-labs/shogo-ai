// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Streaming live transcription for a recording in progress.
 *
 * The recorder (browser, desktop main process or phone) opens a WebSocket
 * with a ticket and sends 16 kHz mono PCM16 frames. A streaming recognizer
 * turns them into `partial` text (the words still being said) and `final`
 * segments. Finals are saved to the draft meeting's transcript; partials and
 * finals are fanned out to viewers through `meeting-live-bus`. The full-file
 * pass after stop still replaces the live transcript, unless the live
 * transcript covered everything and a second cloud pass would cost money.
 *
 * Recognizers:
 *  - OpenAI realtime transcription (cloud, or a local install with its own key)
 *  - sherpa-onnx streaming zipformer (local, offline)
 * When neither is available the ticket route says so and clients fall back to
 * the chunk upload path.
 */

import { spawn, type ChildProcess } from 'child_process'
import { createServer } from 'net'
import {
  appendStreamFinal,
  getLocalMeetingConfig,
  setLiveStatus,
  upsertRecordingDraft,
  friendlyMeetingError,
  type StreamFinalResult,
} from './meeting.service'
import {
  getSherpaOnlineServerPath,
  getSherpaProcessEnv,
  getStreamingModelFiles,
  isStreamingTranscriptionAvailable,
} from './transcription.service'
import { getNativeProviderApiKeySync } from './provider-credentials.service'
import { publishMeetingLive, type MeetingLiveEvent } from '../lib/meeting-live-bus'
import { verifyStreamTicket, type MeetingStreamTicket } from '../lib/meeting-stream-ticket'

export const STREAM_SAMPLE_RATE = 16000
/** Largest binary frame accepted from a recorder (about 2 s of audio). */
export const STREAM_MAX_FRAME_BYTES = 64 * 1024
/** A single stream never runs longer than this. */
export const STREAM_MAX_SECONDS = 8 * 60 * 60
const FINISH_TIMEOUT_MS = 8000

// ---------------------------------------------------------------------------
// Backend contract
// ---------------------------------------------------------------------------

export type BackendEvent =
  | { type: 'partial'; itemId: string; text: string; start: number }
  | { type: 'final'; itemId: string; text: string; start: number; end: number }
  | { type: 'error'; message: string; fatal: boolean }

export interface StreamingBackend {
  readonly name: 'openai' | 'sherpa'
  /** True when usage should be billed to the workspace (Shogo's own key). */
  readonly billed: boolean
  start(emit: (event: BackendEvent) => void): Promise<void>
  /** 16 kHz mono signed 16-bit little-endian samples. */
  sendPcm(pcm: Buffer): void
  /** Flush buffered audio and resolve when the pending finals were emitted (or the timeout passed). */
  finish(timeoutMs: number): Promise<void>
  close(): void
}

/** ASR output is often upper case with no punctuation. */
export function prettifyAsr(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const letters = trimmed.replace(/[^A-Za-z]/g, '')
  const shouting = letters.length > 3 && letters === letters.toUpperCase()
  const body = shouting ? trimmed.toLowerCase() : trimmed
  return body.charAt(0).toUpperCase() + body.slice(1)
}

// ---------------------------------------------------------------------------
// 16 kHz -> 24 kHz (OpenAI's pcm16 input is 24 kHz)
// ---------------------------------------------------------------------------

function windowRms(samples: Int16Array, from: number, to: number): number {
  let sum = 0
  for (let i = from; i < to; i++) sum += samples[i] * samples[i]
  return to > from ? Math.sqrt(sum / (to - from)) : 0
}

export class Upsampler16to24 {
  private pos = 0
  private prev = 0

  process(input: Int16Array): Int16Array {
    const n = input.length
    if (n === 0) return new Int16Array(0)
    const out: number[] = []
    while (this.pos < n) {
      const i0 = Math.floor(this.pos)
      const a = i0 === 0 ? this.prev : input[i0 - 1]
      const b = input[i0]
      out.push(Math.round(a + (b - a) * (this.pos - i0)))
      this.pos += 2 / 3
    }
    this.pos -= n
    this.prev = input[n - 1]
    return Int16Array.from(out)
  }
}

export function pcmBufferToInt16(buf: Buffer): Int16Array {
  const even = buf.byteLength & ~1
  const copy = new Uint8Array(even)
  copy.set(buf.subarray(0, even))
  return new Int16Array(copy.buffer)
}

// ---------------------------------------------------------------------------
// OpenAI realtime transcription
// ---------------------------------------------------------------------------

export interface WebSocketLike {
  send(data: string | ArrayBufferLike | Uint8Array): void
  close(): void
  onopen: ((event?: any) => void) | null
  onmessage: ((event: any) => void) | null
  onclose: ((event?: any) => void) | null
  onerror: ((event?: any) => void) | null
  readyState?: number
}

export type SocketFactory = (url: string, init?: { headers?: Record<string, string> }) => WebSocketLike

const defaultSocketFactory: SocketFactory = (url, init) => new (globalThis as any).WebSocket(url, init) as WebSocketLike

export const OPENAI_TRANSCRIBE_MODEL = 'gpt-4o-transcribe'
/** A pause this long ends an utterance. OpenAI only returns text once an utterance is committed. */
const VAD_SILENCE_MS = 350
/**
 * OpenAI returns words only after an utterance is committed (about 0.7 s
 * later), so a speaker who never pauses would see nothing. Commit at least
 * this often.
 */
export const MAX_UTTERANCE_SECONDS = 8
/** After this long we look for a dip in the speaker's voice to cut at, so words are not split. */
export const PREFERRED_UTTERANCE_SECONDS = 3
const WINDOW_SAMPLES = 320 // 20 ms
/** Windows quieter than this are never speech. */
const SPEECH_FLOOR_RMS = 350
/** A real pause, not the closed lips inside a word like "up-date" (about 160 ms). */
const DIP_WINDOWS = 8

export class OpenAIRealtimeBackend implements StreamingBackend {
  readonly name = 'openai' as const
  private socket: WebSocketLike | null = null
  private emit: (event: BackendEvent) => void = () => {}
  private readonly upsampler = new Upsampler16to24()
  private samplesSent = 0
  private readonly starts = new Map<string, number>()
  private readonly ends = new Map<string, number>()
  private readonly text = new Map<string, string>()
  private readonly pending = new Set<string>()
  private lastEnd = 0
  /** Where the utterance currently being heard began, in seconds of audio sent. Null in a pause. */
  private openSince: number | null = null
  /** Audio seconds at which we committed ourselves, matched to `committed` events in order. */
  private forcedCommits: number[] = []
  private previousCommitEnd = 0
  /** Running average of how loud speech is, to tell a dip from a word. */
  private speechLevel = 0
  /** Consecutive quiet 20 ms windows. */
  private quietRun = 0
  private closed = false
  private waiters: Array<() => void> = []

  constructor(
    private readonly apiKey: string,
    readonly billed: boolean,
    private readonly offsetSeconds = 0,
    private readonly createSocket: SocketFactory = defaultSocketFactory,
    private readonly language = 'en',
  ) {}

  start(emit: (event: BackendEvent) => void): Promise<void> {
    this.emit = emit
    return new Promise((resolve, reject) => {
      let opened = false
      let socket: WebSocketLike
      try {
        socket = this.createSocket('wss://api.openai.com/v1/realtime?intent=transcription', {
          // The beta protocol (with an OpenAI-Beta header) is retired; this is the GA one.
          headers: { Authorization: `Bearer ${this.apiKey}` },
        })
      } catch (err: any) {
        reject(new Error(`Could not reach OpenAI: ${err?.message ?? err}`))
        return
      }
      this.socket = socket
      socket.onopen = () => {
        opened = true
        socket.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              type: 'transcription',
              audio: {
                input: {
                  format: { type: 'audio/pcm', rate: 24000 },
                  transcription: { model: OPENAI_TRANSCRIBE_MODEL, language: this.language },
                  turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: VAD_SILENCE_MS },
                  noise_reduction: { type: 'near_field' },
                },
              },
            },
          }),
        )
        resolve()
      }
      socket.onmessage = (event) => this.onMessage(event?.data ?? event)
      socket.onerror = () => {
        if (!opened) reject(new Error('Could not connect to OpenAI transcription'))
      }
      socket.onclose = () => {
        if (!opened) reject(new Error('OpenAI transcription closed before it started'))
        else if (!this.closed) this.emit({ type: 'error', message: 'The transcription connection dropped.', fatal: true })
        this.closed = true
        this.wake()
      }
    })
  }

  sendPcm(pcm: Buffer): void {
    if (this.closed || !this.socket) return
    const samples = pcmBufferToInt16(pcm)
    if (samples.length === 0) return
    try {
      // Walk 20 ms windows so a long utterance can be cut at a dip in the voice.
      let sent = 0
      for (let end = WINDOW_SAMPLES; sent < samples.length; end += WINDOW_SAMPLES) {
        const to = Math.min(end, samples.length)
        const level = windowRms(samples, to - WINDOW_SAMPLES > 0 ? to - WINDOW_SAMPLES : 0, to)
        const now = (this.samplesSent + to) / STREAM_SAMPLE_RATE
        const loud = level >= SPEECH_FLOOR_RMS
        if (loud) this.speechLevel = this.speechLevel === 0 ? level : this.speechLevel * 0.95 + level * 0.05
        // Our own check for speech in progress, for after a cut (OpenAI's speech_started only fires after a pause).
        if (loud && this.openSince === null) this.openSince = now
        this.quietRun = !loud || level < this.speechLevel * 0.2 ? this.quietRun + 1 : 0
        if (this.openSince !== null) {
          const age = now - this.openSince
          if (age >= MAX_UTTERANCE_SECONDS || (age >= PREFERRED_UTTERANCE_SECONDS && this.quietRun >= DIP_WINDOWS)) {
            this.append(samples.subarray(sent, to))
            sent = to
            this.forcedCommits.push(this.offsetSeconds + now)
            this.openSince = null
            this.socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
          }
        }
        if (to >= samples.length) break
      }
      this.append(samples.subarray(sent))
      this.samplesSent += samples.length
    } catch {
      this.emit({ type: 'error', message: 'The transcription connection dropped.', fatal: true })
    }
  }

  private append(samples: Int16Array): void {
    if (samples.length === 0 || !this.socket) return
    const up = this.upsampler.process(samples)
    const bytes = Buffer.from(up.buffer, up.byteOffset, up.byteLength)
    this.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: bytes.toString('base64') }))
  }

  async finish(timeoutMs: number): Promise<void> {
    if (this.closed || !this.socket) return
    try {
      // Commit whatever speech is still buffered; with nothing buffered OpenAI answers with an ignorable error.
      this.socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
    } catch {}
    const deadline = Date.now() + timeoutMs
    // Give the commit a moment to register its item before judging "nothing pending".
    await new Promise((resolve) => setTimeout(resolve, 150))
    while (this.pending.size > 0 && !this.closed && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(10, deadline - Date.now()))
        this.waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  close(): void {
    this.closed = true
    try {
      this.socket?.close()
    } catch {}
    this.wake()
  }

  private wake(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const w of waiters) w()
  }

  private seconds(ms: unknown): number | null {
    return typeof ms === 'number' && Number.isFinite(ms) ? this.offsetSeconds + ms / 1000 : null
  }

  private onMessage(raw: unknown): void {
    let event: any
    try {
      event = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8'))
    } catch {
      return
    }
    const itemId: string | undefined = typeof event?.item_id === 'string' ? event.item_id : undefined
    switch (event?.type) {
      case 'input_audio_buffer.speech_started': {
        if (!itemId) return
        const start = this.seconds(event.audio_start_ms)
        if (start !== null) this.starts.set(itemId, start)
        this.openSince = typeof event.audio_start_ms === 'number' ? event.audio_start_ms / 1000 : this.samplesSent / STREAM_SAMPLE_RATE
        this.pending.add(itemId)
        return
      }
      case 'input_audio_buffer.speech_stopped': {
        if (!itemId) return
        const end = this.seconds(event.audio_end_ms)
        if (end !== null) this.ends.set(itemId, end)
        this.openSince = null
        return
      }
      case 'input_audio_buffer.committed': {
        if (!itemId) return
        this.pending.add(itemId)
        // Utterances we cut ourselves have no speech_stopped to say where they ended.
        if (!this.ends.has(itemId) && this.forcedCommits.length) this.ends.set(itemId, this.forcedCommits.shift()!)
        if (!this.starts.has(itemId)) this.starts.set(itemId, this.previousCommitEnd)
        this.previousCommitEnd = this.ends.get(itemId) ?? this.offsetSeconds + this.samplesSent / STREAM_SAMPLE_RATE
        return
      }
      case 'conversation.item.input_audio_transcription.delta': {
        if (!itemId || typeof event.delta !== 'string') return
        const next = (this.text.get(itemId) ?? '') + event.delta
        this.text.set(itemId, next)
        const text = prettifyAsr(next)
        if (text) this.emit({ type: 'partial', itemId, text, start: this.starts.get(itemId) ?? this.lastEnd })
        return
      }
      case 'conversation.item.input_audio_transcription.completed': {
        if (!itemId) return
        const text = prettifyAsr(String(event.transcript ?? this.text.get(itemId) ?? ''))
        const start = this.starts.get(itemId) ?? this.lastEnd
        const end = Math.max(start, this.ends.get(itemId) ?? this.offsetSeconds + this.samplesSent / STREAM_SAMPLE_RATE)
        this.lastEnd = end
        this.pending.delete(itemId)
        this.text.delete(itemId)
        if (text) this.emit({ type: 'final', itemId, text, start, end })
        this.wake()
        return
      }
      case 'conversation.item.input_audio_transcription.failed': {
        if (itemId) this.pending.delete(itemId)
        this.emit({ type: 'error', message: String(event.error?.message ?? 'Transcription failed'), fatal: false })
        this.wake()
        return
      }
      case 'error': {
        const code = String(event.error?.code ?? '')
        // Committing an empty buffer is expected when the speaker was silent at the end.
        if (code === 'input_audio_buffer_commit_empty') return
        this.emit({ type: 'error', message: String(event.error?.message ?? 'OpenAI transcription error'), fatal: false })
        return
      }
    }
  }
}

// ---------------------------------------------------------------------------
// sherpa-onnx streaming recognizer
// ---------------------------------------------------------------------------

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('No free port'))))
    })
  })
}

/**
 * Runs `sherpa-onnx-online-websocket-server` for one recording and talks to
 * it over a local socket. The server takes float32 samples and answers with
 * `{ text, segment, is_final, start_time }` as the hypothesis grows; a text
 * message of "Done" flushes it.
 */
export class SherpaOnlineBackend implements StreamingBackend {
  readonly name = 'sherpa' as const
  readonly billed = false
  private proc: ChildProcess | null = null
  private socket: WebSocketLike | null = null
  private emit: (event: BackendEvent) => void = () => {}
  private closed = false
  private done = false
  private samplesSent = 0
  private lastEnd = 0
  /** The segment being heard, so it can be finalized when the recorder stops. */
  private open: { itemId: string; text: string; start: number } | null = null
  private waiters: Array<() => void> = []

  constructor(
    private readonly offsetSeconds = 0,
    private readonly createSocket: SocketFactory = defaultSocketFactory,
  ) {}

  async start(emit: (event: BackendEvent) => void): Promise<void> {
    this.emit = emit
    const bin = getSherpaOnlineServerPath()
    const model = getStreamingModelFiles()
    if (!bin || !model) throw new Error('Streaming transcription is not installed')
    const port = await freePort()
    const proc = spawn(
      bin,
      [
        `--port=${port}`,
        '--num-work-threads=1',
        '--num-io-threads=1',
        `--tokens=${model.tokens}`,
        `--encoder=${model.encoder}`,
        `--decoder=${model.decoder}`,
        `--joiner=${model.joiner}`,
        '--enable-endpoint=true',
        '--rule1-min-trailing-silence=1.6',
        '--rule2-min-trailing-silence=0.6',
        // Without a pause the recognizer would keep one segment open for ever; this ends it.
        '--rule3-min-utterance-length=10',
        '--loop-interval-ms=20',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], env: getSherpaProcessEnv() },
    )
    this.proc = proc
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-500)
    })
    proc.on('exit', (code) => {
      if (!this.closed && !this.done) {
        this.emit({ type: 'error', message: `The streaming recognizer stopped (code ${code}). ${stderr}`.trim(), fatal: true })
      }
      this.closed = true
      this.wake()
    })

    // The server needs a moment to bind; retry the connection briefly.
    const deadline = Date.now() + 8000
    let lastError: unknown
    while (Date.now() < deadline) {
      if (this.closed) throw new Error(`The streaming recognizer did not start. ${stderr}`.trim())
      try {
        this.socket = await this.connect(port)
        return
      } catch (err) {
        lastError = err
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
    }
    this.close()
    throw new Error(`The streaming recognizer did not start: ${(lastError as any)?.message ?? lastError}`)
  }

  private connect(port: number): Promise<WebSocketLike> {
    return new Promise((resolve, reject) => {
      const socket = this.createSocket(`ws://127.0.0.1:${port}`)
      let opened = false
      socket.onopen = () => {
        opened = true
        resolve(socket)
      }
      socket.onerror = () => {
        if (!opened) reject(new Error('connect failed'))
      }
      socket.onmessage = (event) => this.onMessage(event?.data ?? event)
      socket.onclose = () => {
        // A refused attempt while the server is still binding must not count as "finished".
        if (!opened) {
          reject(new Error('closed'))
          return
        }
        this.done = true
        this.wake()
      }
    })
  }

  sendPcm(pcm: Buffer): void {
    if (this.closed || !this.socket) return
    const samples = pcmBufferToInt16(pcm)
    if (samples.length === 0) return
    this.samplesSent += samples.length
    const floats = new Float32Array(samples.length)
    for (let i = 0; i < samples.length; i++) floats[i] = samples[i] / 32768
    try {
      this.socket.send(new Uint8Array(floats.buffer))
    } catch {
      this.emit({ type: 'error', message: 'The streaming recognizer connection dropped.', fatal: true })
    }
  }

  async finish(timeoutMs: number): Promise<void> {
    if (this.closed || !this.socket || this.done) return
    try {
      this.socket.send('Done')
    } catch {
      return
    }
    const deadline = Date.now() + timeoutMs
    while (!this.done && !this.closed && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(10, deadline - Date.now()))
        this.waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  close(): void {
    this.closed = true
    try {
      this.socket?.close()
    } catch {}
    try {
      this.proc?.kill('SIGTERM')
    } catch {}
    this.wake()
  }

  private wake(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const w of waiters) w()
  }

  private onMessage(raw: unknown): void {
    const body = typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8')
    // After "Done" the server sends the last results, then this text. It does not close the socket.
    if (body.trim() === 'Done!') {
      this.flushOpen()
      this.done = true
      this.wake()
      return
    }
    let message: any
    try {
      message = JSON.parse(body)
    } catch {
      return
    }
    if (typeof message?.text !== 'string') return
    const segment = Number.isFinite(message.segment) ? message.segment : 0
    const itemId = `sherpa-${this.offsetSeconds}-${segment}`
    const text = prettifyAsr(message.text)
    const start = this.offsetSeconds + (Number.isFinite(message.start_time) ? message.start_time : this.lastEnd)
    if (message.is_final === true) {
      this.open = null
      const end = Math.max(start, this.offsetSeconds + this.samplesSent / STREAM_SAMPLE_RATE)
      this.lastEnd = end - this.offsetSeconds
      if (text) this.emit({ type: 'final', itemId, text, start, end })
    } else if (text) {
      this.open = { itemId, text, start }
      this.emit({ type: 'partial', itemId, text, start })
    }
  }

  /** The recorder stopped mid-segment: what was heard so far is the final text. */
  private flushOpen(): void {
    const open = this.open
    this.open = null
    if (!open) return
    const end = Math.max(open.start, this.offsetSeconds + this.samplesSent / STREAM_SAMPLE_RATE)
    this.lastEnd = end - this.offsetSeconds
    this.emit({ type: 'final', itemId: open.itemId, text: open.text, start: open.start, end })
  }
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

const isLocalMode = () => process.env.SHOGO_LOCAL_MODE === 'true'

export interface BackendChoice {
  name: 'openai' | 'sherpa'
  create(offsetSeconds: number): StreamingBackend
}

/** The recognizer a new stream would use, or null when only chunk upload is possible. */
export function chooseStreamingBackend(): BackendChoice | null {
  if (isLocalMode()) {
    if (isStreamingTranscriptionAvailable()) {
      return { name: 'sherpa', create: (offset) => new SherpaOnlineBackend(offset) }
    }
    // The user's own provider key: their account, nothing to bill.
    const key = getNativeProviderApiKeySync('openai')
    if (key) return { name: 'openai', create: (offset) => new OpenAIRealtimeBackend(key, false, offset) }
    return null
  }
  const key = process.env.OPENAI_API_KEY
  return key ? { name: 'openai', create: (offset) => new OpenAIRealtimeBackend(key, true, offset) } : null
}

/** Whether the app may start a stream, with the reason when it may not. */
export async function describeStreamAvailability(): Promise<
  { ok: true; backend: 'openai' | 'sherpa' } | { ok: false; reason: 'disabled' | 'unavailable' }
> {
  if (isLocalMode() && !(await getLocalMeetingConfig()).enabled) return { ok: false, reason: 'disabled' }
  const choice = chooseStreamingBackend()
  return choice ? { ok: true, backend: choice.name } : { ok: false, reason: 'unavailable' }
}

// ---------------------------------------------------------------------------
// One recorder's stream
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { type: 'ready'; backend: 'openai' | 'sherpa' }
  | { type: 'partial'; itemId: string; text: string; start: number }
  | { type: 'final'; itemId: string; segment: { start: number; end: number; text: string } }
  | { type: 'status'; state: 'ok' | 'error'; message?: string }
  | { type: 'done'; complete: boolean; chunks: number; seconds: number }
  | { type: 'error'; code: string; message: string; fatal: boolean }

export interface StreamSessionDeps {
  ensureDraft(
    owner: { workspaceId: string; userId: string | null },
    recordingId: string,
  ): Promise<{ id: string; status: string }>
  appendFinal(meetingId: string, input: { itemId: string; segment: { start: number; end: number; text: string } }): Promise<StreamFinalResult>
  publish(meetingId: string, event: MeetingLiveEvent): void
  setStatus(meetingId: string, status: { state: 'ok' | 'error'; message?: string }): Promise<void>
  /** Called once with the audio seconds streamed, when the backend is billed. */
  bill(ticket: MeetingStreamTicket, seconds: number): Promise<void>
  admit(ticket: MeetingStreamTicket): Promise<boolean>
}

export const defaultStreamDeps: StreamSessionDeps = {
  ensureDraft: (owner, recordingId) => upsertRecordingDraft(owner, recordingId, {}),
  appendFinal: appendStreamFinal,
  publish: publishMeetingLive,
  setStatus: setLiveStatus,
  async bill(ticket, seconds) {
    const { recordTranscriptionUsage } = await import('../routes/ai-proxy')
    const now = Math.floor(Date.now() / 1000)
    await recordTranscriptionUsage(
      {
        projectId: 'api-key',
        workspaceId: ticket.workspaceId,
        userId: ticket.userId ?? 'system',
        type: 'ai-proxy',
        authKind: 'api-key',
        iat: now,
        exp: now + 3600,
      } as any,
      OPENAI_TRANSCRIBE_MODEL,
      seconds,
    )
  },
  async admit(ticket) {
    if (isLocalMode()) return true
    const { checkUsageBalance } = await import('./billing.service')
    return (await checkUsageBalance(ticket.workspaceId)).ok
  },
}

export class LiveStreamSession {
  private meetingId: string | null = null
  private backend: StreamingBackend | null = null
  private began: Promise<boolean> | null = null
  private ready = false
  private pending: Buffer[] = []
  private pendingBytes = 0
  private samples = 0
  private finals = 0
  private lost = false
  private persist: Promise<unknown> = Promise.resolve()
  private finished: Promise<void> | null = null
  private billed = false
  private closed = false

  constructor(
    private readonly ticket: MeetingStreamTicket,
    private readonly offsetSeconds: number,
    private readonly send: (message: ServerMessage) => void,
    private readonly choice: BackendChoice | null = chooseStreamingBackend(),
    private readonly deps: StreamSessionDeps = defaultStreamDeps,
  ) {}

  /** Connect the recognizer. False (after telling the recorder why) when the stream can't run. */
  begin(): Promise<boolean> {
    this.began ??= this.doBegin()
    return this.began
  }

  private fail(code: string, message: string): false {
    this.send({ type: 'error', code, message, fatal: true })
    return false
  }

  private async doBegin(): Promise<boolean> {
    const choice = this.choice
    if (!choice) return this.fail('stream_unavailable', 'Live streaming is not available here.')
    if (!(await this.deps.admit(this.ticket))) return this.fail('usage_limit_reached', 'Workspace usage limit reached.')
    const draft = await this.deps.ensureDraft(
      { workspaceId: this.ticket.workspaceId, userId: this.ticket.userId },
      this.ticket.recordingId,
    )
    this.meetingId = draft.id
    if (draft.status !== 'recording') return this.fail('not_recording', 'This recording has already finished.')
    const backend = choice.create(this.offsetSeconds)
    this.backend = backend
    try {
      await backend.start((event) => this.onBackendEvent(event))
    } catch (err: any) {
      const message = friendlyMeetingError('transcript', err)
      await this.deps.setStatus(draft.id, { state: 'error', message })
      return this.fail('backend_unavailable', message)
    }
    if (this.closed) {
      backend.close()
      return false
    }
    this.ready = true
    this.send({ type: 'ready', backend: backend.name })
    for (const frame of this.pending) backend.sendPcm(frame)
    this.pending = []
    this.pendingBytes = 0
    return true
  }

  onAudio(frame: Buffer): void {
    if (this.closed || this.finished) return
    if (frame.byteLength > STREAM_MAX_FRAME_BYTES) return
    if (this.samples / STREAM_SAMPLE_RATE > STREAM_MAX_SECONDS) return
    this.samples += frame.byteLength >> 1
    if (this.ready && this.backend) {
      this.backend.sendPcm(frame)
    } else if (this.pendingBytes < STREAM_SAMPLE_RATE * 2 * 30) {
      // Audio that arrives while the recognizer starts, capped at 30 s.
      this.pending.push(frame)
      this.pendingBytes += frame.byteLength
    } else {
      this.lost = true
    }
  }

  private onBackendEvent(event: BackendEvent): void {
    const meetingId = this.meetingId
    if (!meetingId || this.closed) return
    if (event.type === 'partial') {
      const message = { type: 'partial' as const, itemId: event.itemId, text: event.text, start: event.start }
      this.deps.publish(meetingId, message)
      this.send(message)
    } else if (event.type === 'final') {
      const segment = { start: event.start, end: event.end, text: event.text }
      this.persist = this.persist.then(async () => {
        const result = await this.deps.appendFinal(meetingId, { itemId: event.itemId, segment })
        if (!result.ok) {
          this.lost = true
          if (result.reason === 'not_recording') this.close()
          return
        }
        if (result.stored) this.finals = result.finals
        this.deps.publish(meetingId, { type: 'final', itemId: event.itemId, segment })
        this.send({ type: 'final', itemId: event.itemId, segment })
      })
    } else {
      this.lost = true
      const message = friendlyMeetingError('transcript', new Error(event.message))
      this.persist = this.persist.then(() => this.deps.setStatus(meetingId, { state: 'error', message }))
      this.send({ type: 'error', code: 'backend_error', message, fatal: event.fatal })
    }
  }

  /** Flush the recognizer, wait for the last finals to be saved, then report coverage. */
  finish(timeoutMs = FINISH_TIMEOUT_MS): Promise<void> {
    this.finished ??= this.doFinish(timeoutMs)
    return this.finished
  }

  private async doFinish(timeoutMs: number): Promise<void> {
    const ok = await this.begin().catch(() => false)
    if (ok && this.backend) await this.backend.finish(timeoutMs).catch(() => {})
    await this.persist.catch(() => {})
    this.send({
      type: 'done',
      complete: ok && !this.lost,
      chunks: this.finals,
      seconds: this.offsetSeconds + this.samples / STREAM_SAMPLE_RATE,
    })
    await this.settleBilling()
    this.backend?.close()
    this.closed = true
  }

  /** Recorder went away without finishing. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.backend?.close()
    void this.settleBilling()
  }

  private async settleBilling(): Promise<void> {
    if (this.billed || !this.backend?.billed || this.samples === 0) return
    this.billed = true
    await this.deps.bill(this.ticket, this.samples / STREAM_SAMPLE_RATE).catch((err) => {
      console.error('[MeetingStream] billing failed:', err?.message ?? err)
    })
  }
}

// ---------------------------------------------------------------------------
// Streaming HTTP body (the desktop main process has no WebSocket client)
// ---------------------------------------------------------------------------

export type HttpStreamOutcome =
  | { ok: true; complete: boolean; chunks: number; seconds: number }
  | { ok: false; code: string; message: string }

/**
 * Run a stream whose audio arrives as the (chunked) body of one HTTP request.
 * Resolves when the body ends and the last finals are saved, or early when the
 * stream can't start.
 */
export async function runHttpAudioStream(
  body: ReadableStream<Uint8Array> | null,
  ticket: MeetingStreamTicket,
  options: { offsetSeconds?: number; signal?: AbortSignal; choice?: BackendChoice | null; deps?: StreamSessionDeps } = {},
): Promise<HttpStreamOutcome> {
  let failure: { code: string; message: string } | null = null
  let done: Extract<ServerMessage, { type: 'done' }> | null = null
  const session = new LiveStreamSession(
    ticket,
    options.offsetSeconds ?? 0,
    (message) => {
      if (message.type === 'done') done = message
      else if (message.type === 'error' && message.fatal) failure ??= { code: message.code, message: message.message }
    },
    options.choice === undefined ? chooseStreamingBackend() : options.choice,
    options.deps ?? defaultStreamDeps,
  )
  if (!body) return { ok: false, code: 'empty', message: 'No audio in the request.' }
  if (!(await session.begin())) {
    return { ok: false, ...(failure ?? { code: 'stream_unavailable', message: 'Live streaming is not available here.' }) }
  }
  options.signal?.addEventListener('abort', () => session.close())
  const reader = body.getReader()
  let carry: Buffer = Buffer.alloc(0)
  try {
    while (true) {
      const { value, done: finished } = await reader.read()
      if (finished) break
      if (!value?.byteLength) continue
      let data = carry.length ? Buffer.concat([carry, Buffer.from(value)]) : Buffer.from(value)
      const even = data.byteLength & ~1
      carry = data.subarray(even)
      data = data.subarray(0, even)
      for (let offset = 0; offset < data.byteLength; offset += STREAM_MAX_FRAME_BYTES / 2) {
        session.onAudio(data.subarray(offset, Math.min(data.byteLength, offset + STREAM_MAX_FRAME_BYTES / 2)))
      }
    }
  } catch {
    // The recorder went away mid-stream: keep what the recognizer already produced.
  }
  await session.finish()
  const final = done as Extract<ServerMessage, { type: 'done' }> | null
  return final
    ? { ok: true, complete: final.complete, chunks: final.chunks, seconds: final.seconds }
    : { ok: false, code: 'no_summary', message: 'The stream ended without a summary.' }
}

// ---------------------------------------------------------------------------
// Bun WebSocket glue (see server.ts)
// ---------------------------------------------------------------------------

export interface MeetingStreamSocketData {
  kind: 'meeting-live-stream'
  ticket: MeetingStreamTicket
  offsetSeconds: number
  session?: LiveStreamSession
}

export function isMeetingStreamSocketData(value: unknown): value is MeetingStreamSocketData {
  return !!value && typeof value === 'object' && (value as any).kind === 'meeting-live-stream'
}

/** Validate an upgrade request. Returns the socket data, or null for a bad ticket. */
export function meetingStreamSocketData(url: URL): MeetingStreamSocketData | null {
  const ticket = verifyStreamTicket(url.searchParams.get('ticket'))
  if (!ticket) return null
  const offset = Number(url.searchParams.get('offset') ?? 0)
  return {
    kind: 'meeting-live-stream',
    ticket,
    offsetSeconds: Number.isFinite(offset) && offset >= 0 && offset <= STREAM_MAX_SECONDS ? offset : 0,
  }
}

export function meetingStreamOpen(ws: any): void {
  const data = ws.data as MeetingStreamSocketData
  const session = new LiveStreamSession(data.ticket, data.offsetSeconds, (message) => {
    try {
      ws.send(JSON.stringify(message))
    } catch {}
  })
  data.session = session
  void session.begin().then((ok) => {
    if (!ok) try { ws.close() } catch {}
  }).catch((err) => {
    console.error('[MeetingStream] start failed:', err?.message ?? err)
    try { ws.send(JSON.stringify({ type: 'error', code: 'internal', message: 'Live transcription failed to start.', fatal: true })) } catch {}
    try { ws.close() } catch {}
  })
}

export function meetingStreamMessage(ws: any, message: unknown): void {
  const session = (ws.data as MeetingStreamSocketData).session
  if (!session) return
  if (typeof message === 'string') {
    let parsed: any
    try {
      parsed = JSON.parse(message)
    } catch {
      return
    }
    if (parsed?.type === 'finish') {
      void session.finish().finally(() => {
        try { ws.close() } catch {}
      })
    }
    return
  }
  const bytes = message instanceof ArrayBuffer ? Buffer.from(message) : Buffer.from(message as Uint8Array)
  session.onAudio(bytes)
}

export function meetingStreamClose(ws: any): void {
  ;(ws.data as MeetingStreamSocketData).session?.close()
}
