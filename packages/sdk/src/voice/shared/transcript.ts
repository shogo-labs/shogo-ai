// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Platform-agnostic transcript handling:
 *
 *   - `createTranscriptDisconnectHandler` returns the `onDisconnect`
 *     handler that flushes the accumulated transcript to the consumer
 *     (either via the user-supplied `onTranscript` callback, or by
 *     POSTing to `transcriptIngestPath` if the transcript is long
 *     enough to be worth keeping).
 *   - `appendTranscriptLine` is a tiny helper applied from the
 *     `onMessage` path — same on web and native.
 *
 * Web and native diverge only on the "flush before app teardown" path:
 *   - Web uses `window.addEventListener('pagehide', ...)` +
 *     `navigator.sendBeacon`.
 *   - Native uses `AppState.addEventListener('change', ...)` +
 *     a regular `fetch`.
 *
 * Those hooks live in their respective platform files. This module
 * stays DOM-free.
 */

import type { MutableRefObject } from 'react'
import { stripAudioTags } from '../audioTags.js'
import type { PostJson } from './postJson.js'

export type TranscriptCallback = (transcript: string) => void | Promise<void>

export interface CreateTranscriptDisconnectHandlerOptions {
  /**
   * Whether the *current* disconnect is part of an internal
   * `restart()` reconnect (preserve transcript, don't flush) vs a
   * real session end.
   */
  isRestartingRef: MutableRefObject<boolean>
  /**
   * Whether *this hook* opened the active session — only flush in
   * that case so external sessions don't double-write.
   */
  weStartedSessionRef: MutableRefObject<boolean>
  /** Buffer of `User: ...` / `Agent: ...` lines accumulated this session. */
  transcriptRef: MutableRefObject<string[]>
  /** Caller-supplied override; when set we skip the default POST. */
  onTranscript: TranscriptCallback | undefined
  /** Where to POST the transcript when no override is set. */
  transcriptIngestPath: string
  postJson: PostJson
}

export function createTranscriptDisconnectHandler({
  isRestartingRef,
  weStartedSessionRef,
  transcriptRef,
  onTranscript,
  transcriptIngestPath,
  postJson,
}: CreateTranscriptDisconnectHandlerOptions): () => void {
  return function handleTranscriptOnDisconnect() {
    if (isRestartingRef.current) {
      // Transient disconnect inside `restart()`. Preserve accumulated
      // state so the consumer sees a single continuous transcript
      // across the reconnect gap.
      return
    }
    if (!weStartedSessionRef.current) {
      transcriptRef.current = []
      return
    }
    weStartedSessionRef.current = false
    const transcript = transcriptRef.current.join('\n')
    transcriptRef.current = []
    if (onTranscript) {
      void onTranscript(transcript)
      return
    }
    const trimmed = transcript.trim()
    if (trimmed.length < 20) return
    void postJson(transcriptIngestPath, { transcript: trimmed }).catch(() => {
      // best effort
    })
  }
}

export interface AppendTranscriptLineOptions {
  transcriptRef: MutableRefObject<string[]>
  weStartedSessionRef: MutableRefObject<boolean>
}

/**
 * Append a `User: ...` / `Agent: ...` line for the given convai
 * `onMessage` event. No-ops if the message is empty or the session
 * wasn't opened by us. Applies `stripAudioTags` to agent messages so
 * the saved transcript stays readable.
 */
export function appendTranscriptLine(
  msg: { source?: string; message?: string },
  { transcriptRef, weStartedSessionRef }: AppendTranscriptLineOptions,
): void {
  if (!msg?.message || !msg?.source) return
  if (!weStartedSessionRef.current) return
  const speaker = msg.source === 'user' ? 'User' : 'Agent'
  const cleaned = msg.source === 'user' ? msg.message : stripAudioTags(msg.message)
  if (!cleaned) return
  transcriptRef.current.push(`${speaker}: ${cleaned}`)
}
