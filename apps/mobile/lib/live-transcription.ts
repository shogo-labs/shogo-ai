// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Live transcription for a recording in progress: stream mic audio over a
 * socket when the server can transcribe in real time, and fall back to
 * uploading short WAV chunks when it can't (or when the stream dies).
 *
 * The audio tap starts first and holds what it hears while the stream
 * connects, so the choice never costs the first seconds of the meeting.
 */
import {
  createChunker,
  createStreamSink,
  type Chunker,
  type LiveCapture,
  type LiveChunk,
  type LiveSummary,
  type PcmTap,
} from './live-audio'
import { LiveStreamClient, type StreamHandlers, type StreamTicket } from './live-stream'

export interface AdaptiveLiveOptions {
  tap: PcmTap
  getTicket(): Promise<StreamTicket>
  /** `ws://` or `wss://` origin of the API. */
  wsBase: string
  /** Fallback: transcribe one chunk server-side. */
  postChunk(chunk: LiveChunk): Promise<void>
  handlers?: StreamHandlers
  /** Which path ended up carrying the audio. */
  onMode?(mode: 'stream' | 'chunks'): void
  WebSocketImpl?: any
  connectTimeoutMs?: number
}

export function startAdaptiveLive(options: AdaptiveLiveOptions): LiveCapture {
  const { tap } = options
  let mode: 'connecting' | 'stream' | 'chunks' = 'connecting'
  let stopped = false
  let client: LiveStreamClient | null = null
  let sink: ReturnType<typeof createStreamSink> | null = null
  let chunker: Chunker | null = null
  /** The stream ended early; chunks cover the rest, so the whole isn't covered by one transcript. */
  let streamBroke = false

  const useChunks = (startOffset: number) => {
    mode = 'chunks'
    chunker = createChunker(tap.sampleRate, options.postChunk, startOffset)
    tap.attach((frame) => chunker!.push(frame))
    options.onMode?.('chunks')
  }

  const decided = LiveStreamClient.connect({
    getTicket: options.getTicket,
    wsBase: options.wsBase,
    WebSocketImpl: options.WebSocketImpl,
    connectTimeoutMs: options.connectTimeoutMs,
    handlers: {
      ...options.handlers,
      onFatal: (message) => {
        options.handlers?.onFatal?.(message)
        // Keep transcribing the rest of the meeting through chunks.
        if (mode !== 'stream' || stopped) return
        streamBroke = true
        const resumeAt = client?.secondsSent ?? 0
        sink = null
        useChunks(resumeAt)
      },
    },
  }).then((connected) => {
    client = connected
    // Even if recording already stopped, the audio buffered while connecting is still worth sending.
    if (connected) {
      mode = 'stream'
      sink = createStreamSink(tap.sampleRate, (frame) => connected.sendPcm(frame))
      tap.attach((frame) => sink!.push(frame))
      options.onMode?.('stream')
    } else {
      useChunks(0)
    }
  })

  return {
    async stop(stopOptions) {
      stopped = true
      tap.disconnect()
      await decided.catch(() => {})
      let summary: LiveSummary
      if (mode === 'stream' && client) {
        if (stopOptions?.discard) {
          client.abort()
          summary = { complete: false, chunks: 0, seconds: client.secondsSent }
        } else {
          sink?.flush()
          const done = await client.finish(stopOptions?.timeoutMs)
          summary = { complete: done.complete, chunks: done.chunks, seconds: Math.max(done.seconds, client.secondsSent) }
        }
      } else if (chunker) {
        summary = await (chunker as Chunker).finish(stopOptions)
        if (streamBroke) summary = { ...summary, complete: false }
      } else {
        summary = { complete: false, chunks: 0, seconds: 0 }
      }
      tap.close()
      return summary
    },
  }
}
