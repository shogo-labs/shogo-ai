// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Renderer-side capture pipeline. Wraps `getUserMedia` (mic, all platforms)
 * and `getDisplayMedia` (system audio, Windows only) into an AudioWorklet
 * that emits Int16 PCM frames. Frames are forwarded to the Electron main
 * process through a callback supplied by the preload bridge.
 *
 * This module is loaded from the preload script (which runs in the
 * renderer's isolated world). All Web Audio / getUserMedia calls are done
 * from there — contextIsolation + sandbox still lets preload talk to the
 * browser's navigator / AudioContext, it only restricts Node access.
 */
import { PCM_WORKLET_NAME, PCM_WORKLET_SOURCE } from './pcm-worklet'

export type AudioSourceKind = 'mic' | 'system'

export interface CaptureStartOptions {
  sessionId: string
  /** macOS: mic only (system audio is supplied by shogo-sysaudio).
   *  Windows: both mic + system via the renderer. */
  captureSystemAudio: boolean
  /** Platform string from preload, lets us tune behaviour without sniffing UA. */
  platform: NodeJS.Platform
}

export interface PcmChunkMessage {
  type: 'pcm'
  sampleRate: number
  channels: number
  bitsPerSample: number
  frames: number
  buffer: ArrayBuffer
}

export interface AudioCaptureEvents {
  onPcm: (source: AudioSourceKind, chunk: PcmChunkMessage) => void
  onError: (source: AudioSourceKind, error: Error) => void
  onInfo?: (message: string, data?: Record<string, unknown>) => void
}

interface SourcePipeline {
  context: AudioContext
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  worklet: AudioWorkletNode
}

export class AudioCaptureManager {
  private micPipeline: SourcePipeline | null = null
  private systemPipeline: SourcePipeline | null = null
  private workletModuleUrl: string | null = null
  private readonly events: AudioCaptureEvents

  constructor(events: AudioCaptureEvents) {
    this.events = events
  }

  async start(opts: CaptureStartOptions): Promise<{ mic: boolean; system: boolean }> {
    await this.ensureWorkletModule()

    let micOk = false
    try {
      this.micPipeline = await this.openPipeline('mic', await this.getMicStream())
      micOk = true
    } catch (err) {
      this.events.onError('mic', asError(err))
    }

    let systemOk = false
    if (opts.captureSystemAudio && opts.platform === 'win32') {
      try {
        this.systemPipeline = await this.openPipeline('system', await this.getWindowsSystemStream())
        systemOk = true
      } catch (err) {
        this.events.onError('system', asError(err))
      }
    }

    return { mic: micOk, system: systemOk }
  }

  async stop(): Promise<void> {
    await this.closePipeline('mic', this.micPipeline)
    this.micPipeline = null
    await this.closePipeline('system', this.systemPipeline)
    this.systemPipeline = null
  }

  private async getMicStream(): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      } as MediaTrackConstraints,
      video: false,
    })
  }

  private async getWindowsSystemStream(): Promise<MediaStream> {
    // Chromium's getDisplayMedia on Windows returns a WASAPI loopback track
    // when the user selects "Share system audio". The video track is
    // required by the API even though we immediately stop it.
    const anyMedia = navigator.mediaDevices as unknown as {
      getDisplayMedia: (c: MediaStreamConstraints) => Promise<MediaStream>
    }
    const stream = await anyMedia.getDisplayMedia({
      audio: true,
      video: {
        width: { max: 2 },
        height: { max: 2 },
        frameRate: { max: 1 },
      },
    })
    for (const track of stream.getVideoTracks()) {
      try { track.stop() } catch { /* ignore */ }
      try { stream.removeTrack(track) } catch { /* ignore */ }
    }
    if (stream.getAudioTracks().length === 0) {
      throw new Error('system audio track not available — ensure "Share system audio" is ticked in the picker')
    }
    return stream
  }

  private async ensureWorkletModule(): Promise<void> {
    if (this.workletModuleUrl) return
    const blob = new Blob([PCM_WORKLET_SOURCE], { type: 'application/javascript' })
    this.workletModuleUrl = URL.createObjectURL(blob)
  }

  private async openPipeline(source: AudioSourceKind, stream: MediaStream): Promise<SourcePipeline> {
    if (!this.workletModuleUrl) throw new Error('worklet module not initialised')

    // 48 kHz matches the shogo-sysaudio stream so both WAVs share a rate.
    const context = new AudioContext({ sampleRate: 48000 })
    try {
      await context.audioWorklet.addModule(this.workletModuleUrl)
    } catch (err) {
      try { await context.close() } catch { /* ignore */ }
      throw err
    }

    const node = new AudioWorkletNode(context, PCM_WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { batchMs: 100 },
    })
    node.port.onmessage = (ev: MessageEvent<PcmChunkMessage>) => {
      const data = ev.data
      if (data && data.type === 'pcm') {
        this.events.onPcm(source, data)
      }
    }
    node.onprocessorerror = (ev) => {
      this.events.onError(source, asError((ev as unknown as { message?: string }).message ?? 'worklet error'))
    }

    const sourceNode = context.createMediaStreamSource(stream)
    sourceNode.connect(node)

    this.events.onInfo?.(`capture.started`, {
      source,
      sampleRate: context.sampleRate,
      trackCount: stream.getAudioTracks().length,
    })

    return { context, stream, source: sourceNode, worklet: node }
  }

  private async closePipeline(source: AudioSourceKind, pipeline: SourcePipeline | null): Promise<void> {
    if (!pipeline) return
    try {
      pipeline.worklet.port.postMessage({ type: 'close' })
    } catch { /* ignore */ }
    try { pipeline.source.disconnect() } catch { /* ignore */ }
    try { pipeline.worklet.disconnect() } catch { /* ignore */ }
    for (const track of pipeline.stream.getTracks()) {
      try { track.stop() } catch { /* ignore */ }
    }
    try { await pipeline.context.close() } catch { /* ignore */ }
    this.events.onInfo?.(`capture.stopped`, { source })
  }
}

function asError(value: unknown): Error {
  if (value instanceof Error) return value
  if (typeof value === 'string') return new Error(value)
  return new Error(String(value))
}
