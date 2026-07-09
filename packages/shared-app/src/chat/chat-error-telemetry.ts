// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat stream-error telemetry.
 *
 * Historically, chat transport failures (`net::ERR_HTTP2_PROTOCOL_ERROR` →
 * `TypeError: network error`, `TypeError: Failed to fetch`, `TimeoutError:
 * signal timed out`, mid-stream resets) were handled entirely at the
 * `console.error` level: `ChatPanel`'s `onError` logged and rendered the
 * "Connection interrupted. Please tap Retry to continue." banner, but never
 * called `Sentry.captureException`. The result was silent, user-facing pain —
 * the incident class simply did not exist in the Sentry dashboard, so it could
 * only ever be reconstructed from anecdotes.
 *
 * This module builds a deliberate, structured report for that class so it shows
 * up as its OWN issue. Two design points matter:
 *
 *   1. It is tagged with {@link SHOGO_TELEMETRY_TAG} so the production_web noise
 *      filter (`lib/sentry-noise-filter.ts`) can recognise it as an intentional
 *      capture and NOT drop it — even though the raw message ("Failed to fetch"
 *      etc.) matches the generic transient-network branch that filters unowned
 *      global rejections.
 *   2. It excludes user-initiated aborts (pressing Stop, sending a new message,
 *      navigating away). Those are normal control flow, not failures, and would
 *      otherwise drown the signal.
 *
 * Pure + platform-independent so both web and mobile share the classification
 * and it is unit-testable without the Sentry SDK.
 */

/** Tag key that marks an event as a deliberate Shogo capture (never noise). */
export const SHOGO_TELEMETRY_TAG = 'shogo_telemetry'

export type ChatErrorClass = 'user-abort' | 'connection' | 'other'

/** Best-effort message extraction from an unknown thrown value. */
export function chatErrorMessage(err: unknown): string {
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    const m = (err as { message?: unknown }).message
    if (typeof m === 'string') return m
  }
  return String(err ?? '')
}

function chatErrorName(err: unknown): string {
  if (err && typeof err === 'object') {
    const n = (err as { name?: unknown }).name
    if (typeof n === 'string') return n
  }
  return ''
}

// User-initiated / control-flow aborts. These are expected and must never be
// reported: `stop()`, sending a new message (which aborts the prior stream),
// navigation/unmount, and the SDK's own "The user aborted a request." phrasing.
const USER_ABORT_PATTERNS = [
  /the user aborted a request/i,
  /BodyStreamBuffer was aborted/i,
  /operation was aborted/i,
  /\bAbortError\b/i,
]

// Genuine transport/connection failures — the silent "Connection interrupted"
// class we want surfaced.
const CONNECTION_PATTERNS = [
  /failed to fetch/i,
  /network error/i,
  /fetch failed/i,
  /\bnetwork\b/i,
  /econnreset/i,
  /econnrefused/i,
  /socket hang up/i,
  /\bterminated\b/i,
  /signal timed out/i,
  /\bTimeoutError\b/i,
  /ERR_HTTP2/i,
  /\bload failed\b/i,
  /connection interrupted/i,
]

/**
 * Classify a chat error for telemetry purposes.
 *
 * `userInitiatedStop` lets the caller force `'user-abort'` when it KNOWS the
 * user pressed Stop (ChatPanel tracks this in `userInitiatedStopRef`), covering
 * cases where the underlying error text is ambiguous.
 */
export function classifyChatError(err: unknown, userInitiatedStop = false): ChatErrorClass {
  if (userInitiatedStop) return 'user-abort'
  const name = chatErrorName(err)
  const message = chatErrorMessage(err)
  if (name === 'AbortError') return 'user-abort'
  if (USER_ABORT_PATTERNS.some((p) => p.test(message))) return 'user-abort'
  if (CONNECTION_PATTERNS.some((p) => p.test(message))) return 'connection'
  return 'other'
}

/** Whether a chat error should be reported to Sentry (i.e. is not a user abort). */
export function shouldReportChatError(err: unknown, userInitiatedStop = false): boolean {
  return classifyChatError(err, userInitiatedStop) !== 'user-abort'
}

export interface ChatErrorContext {
  turnId?: string | null
  sessionId?: string | null
  projectId?: string | null
  lastSeq?: number | null
  /** True when the durable stream / probe recovered the turn despite the error. */
  recovered?: boolean
  /** Where the error surfaced, e.g. 'stream'. */
  phase?: string
  userInitiatedStop?: boolean
}

export interface ChatErrorReport {
  /** Human-readable Sentry issue title. */
  message: string
  class: ChatErrorClass
  level: 'error' | 'warning'
  tags: Record<string, string>
  extra: Record<string, unknown>
  /** Groups this class separately from generic global "Failed to fetch" noise. */
  fingerprint: string[]
}

/**
 * Build the Sentry payload for a chat stream error, or `null` when it should not
 * be reported (user abort). The caller passes the returned fields straight to
 * `Sentry.captureException(err, { level, tags, extra, fingerprint })`.
 */
export function buildChatStreamErrorReport(
  err: unknown,
  ctx: ChatErrorContext = {},
): ChatErrorReport | null {
  const cls = classifyChatError(err, ctx.userInitiatedStop ?? false)
  if (cls === 'user-abort') return null

  const rawMessage = chatErrorMessage(err)
  const tags: Record<string, string> = {
    [SHOGO_TELEMETRY_TAG]: 'chat_stream_error',
    chatErrorClass: cls,
    projectId: ctx.projectId ?? '(none)',
    chatSessionId: ctx.sessionId ?? '(none)',
    turnId: ctx.turnId ?? '(none)',
    recovered: ctx.recovered ? 'true' : 'false',
  }

  return {
    message: `chat_stream_error: ${cls}`,
    class: cls,
    // A recovered turn still isn't blocking the user, but we want to see it.
    level: ctx.recovered ? 'warning' : 'error',
    tags,
    extra: {
      rawMessage,
      errorName: chatErrorName(err),
      lastSeq: ctx.lastSeq ?? null,
      recovered: ctx.recovered ?? false,
      phase: ctx.phase ?? 'stream',
    },
    fingerprint: ['chat_stream_error', cls],
  }
}
