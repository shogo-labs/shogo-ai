// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat-composer dictation in browser and Electron clients.
 *
 * Browser speech-recognition services depend on an external network backend.
 * Capture the mic directly, encode a 16 kHz WAV, and use Shogo's API instead.
 */

import { API_URL } from '../../lib/api-url'
import { encodeWav16, resampleTo16k } from '../../lib/live-audio'

import { getDesktopBridge, type MicAccessResult } from '../../lib/desktop-bridge'

export { getDesktopBridge }
export type { MicAccessResult }

/** Raised when the OS or Chromium refuses the microphone. */
export class MicPermissionError extends Error {
  constructor(message = 'Microphone access is blocked.') {
    super(message)
    this.name = 'MicPermissionError'
  }
}

export interface DesktopDictation {
  /** Stop capturing and return the clip as a 16 kHz mono WAV (null if nothing usable was captured). */
  stop(): Promise<Blob | null>
  /** Stop capturing and drop the audio. */
  cancel(): void
}

/** Ask the OS for the mic (prompts on macOS), then start buffering PCM. */
export async function startDesktopDictation(): Promise<DesktopDictation> {
  const bridge = getDesktopBridge()
  if (bridge?.ensureMicAccess) {
    const access = await bridge.ensureMicAccess()
    if (access !== 'granted') throw new MicPermissionError()
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
  } catch (err) {
    const name = (err as { name?: string })?.name
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new MicPermissionError()
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new Error('No microphone was found. Connect one and try again.')
    }
    throw err
  }

  const Ctx = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext
  if (!Ctx) {
    stream.getTracks().forEach((t) => t.stop())
    throw new Error('Audio capture is not available.')
  }
  let ctx: AudioContext
  try {
    ctx = new Ctx()
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop())
    throw error
  }

  let source: MediaStreamAudioSourceNode
  let processor: ScriptProcessorNode
  try {
    source = ctx.createMediaStreamSource(stream)
    // Same approach as live-audio.ts: no separate worklet module needed.
    processor = ctx.createScriptProcessor(4096, 1, 1)
    source.connect(processor)
    processor.connect(ctx.destination)
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop())
    try { await ctx.close() } catch {}
    throw error
  }
  const sampleRate = ctx.sampleRate
  const parts: Float32Array[] = []
  let length = 0
  let closed = false

  processor.onaudioprocess = (event) => {
    if (closed) return
    const input = event.inputBuffer.getChannelData(0)
    parts.push(new Float32Array(input))
    length += input.length
  }
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {})

  const close = async () => {
    if (closed) return
    closed = true
    processor.onaudioprocess = null
    try { source.disconnect() } catch {}
    try { processor.disconnect() } catch {}
    stream.getTracks().forEach((t) => t.stop())
    try { await ctx.close() } catch {}
  }

  return {
    async stop() {
      await close()
      if (length === 0) return null
      const all = new Float32Array(length)
      let offset = 0
      for (const part of parts) {
        all.set(part, offset)
        offset += part.length
      }
      return new Blob([encodeWav16(resampleTo16k(all, sampleRate))], { type: 'audio/wav' })
    },
    cancel() {
      void close()
    },
  }
}

/** POST the clip to Shogo's authenticated API and return the transcript text. */
export async function transcribeDesktopClip(wav: Blob): Promise<string> {
  const res = await fetch(`${API_URL}/api/dictation/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: wav,
    credentials: 'include',
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(
      typeof body?.error === 'string' ? body.error : `Transcription failed (${res.status})`,
    )
  }
  return typeof body?.text === 'string' ? body.text : ''
}
