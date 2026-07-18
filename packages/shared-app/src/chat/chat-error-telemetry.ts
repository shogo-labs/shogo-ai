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

export type ChatErrorClass = 'user-abort' | 'expected' | 'connection' | 'parse' | 'other'

/**
 * Classes that are NORMAL control flow / expected business conditions, not
 * defects — never reported to Sentry. `user-abort` is the user pressing Stop /
 * navigating away; `expected` is a handled, user-facing server state (usage
 * limit, rate limit) that the chat already renders a friendly message for.
 */
const NON_REPORTED_CLASSES: ReadonlySet<ChatErrorClass> = new Set(['user-abort', 'expected'])

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

// Expected, user-facing server conditions — NOT defects. The chat already maps
// these to a friendly message (`ERROR_CODE_MESSAGES` in `message-helpers`) and
// shows a paywall/retry affordance, so capturing them floods Sentry with a
// non-actionable business state. Historically the biggest offender was
// `usage_limit_reached` (Sentry JAVASCRIPT-REACT-45, >1k events): it carries
// the `shogo_telemetry` tag, so it bypasses the production_web noise filter and
// was reported as an `error`. We match BOTH the raw error code (when the SDK
// throws `{"error":{"code":"usage_limit_reached"}}`) and the resolved friendly
// message (when the code has already been mapped upstream).
const EXPECTED_PATTERNS = [
  /\busage_limit_reached\b/i,
  /\binsufficient_credits\b/i,
  /\brate_limit_exceeded\b/i,
  /usage limit reached/i,
  /usage-based pricing/i,
  /sending messages too quickly/i,
]

// Stream-decoding failures thrown by the AI SDK's SSE/JSON reader
// (`safeParseJSON` → `AI_JSONParseError`). These are NOT transport failures —
// they mean a malformed/truncated frame reached the parser (e.g. a mid-frame
// disconnect spliced against a durable-resume replay). They MUST be matched
// before {@link CONNECTION_PATTERNS}: an `AI_JSONParseError`'s message embeds
// the entire offending payload, and a tool output that merely mentions
// "network error" (browser-QA results routinely do) would otherwise be
// misfiled as `connection`. Matched against the error NAME and the message
// PREFIX only, never the embedded body.
const PARSE_NAME_PATTERNS = [/JSONParseError/i, /^SyntaxError$/]
const PARSE_MESSAGE_PREFIX_PATTERNS = [
  /^JSON parsing failed/i,
  /^JSON Parse error/i,
  /^Unexpected (?:token|end of JSON)/i,
  /^Unterminated string in JSON/i,
]

function isParseError(name: string, message: string): boolean {
  if (PARSE_NAME_PATTERNS.some((p) => p.test(name))) return true
  // Only inspect the message PREFIX — an `AI_JSONParseError` appends the raw
  // (often multi-KB) payload after the prefix, which we must not scan.
  const head = message.slice(0, 64)
  return PARSE_MESSAGE_PREFIX_PATTERNS.some((p) => p.test(head))
}

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
  // Expected business conditions (usage/rate limit) before everything else —
  // these are handled + user-facing, never a defect.
  if (EXPECTED_PATTERNS.some((p) => p.test(message))) return 'expected'
  // Parse failures next — their message embeds the raw payload, so testing
  // the connection patterns against it produces false `connection` labels.
  if (isParseError(name, message)) return 'parse'
  if (CONNECTION_PATTERNS.some((p) => p.test(message))) return 'connection'
  return 'other'
}

/**
 * Whether a chat error should be reported to Sentry. Skips normal control flow
 * (user aborts) and expected, already-surfaced business states (usage/rate
 * limit) — see {@link NON_REPORTED_CLASSES}.
 */
export function shouldReportChatError(err: unknown, userInitiatedStop = false): boolean {
  return !NON_REPORTED_CLASSES.has(classifyChatError(err, userInitiatedStop))
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
 * Build the Sentry payload for a chat stream error, or `null` when it should
 * not be reported — user aborts and expected business states (usage/rate
 * limit); see {@link NON_REPORTED_CLASSES}. The caller passes the returned
 * fields straight to
 * `Sentry.captureException(err, { level, tags, extra, fingerprint })`.
 */
export function buildChatStreamErrorReport(
  err: unknown,
  ctx: ChatErrorContext = {},
): ChatErrorReport | null {
  const cls = classifyChatError(err, ctx.userInitiatedStop ?? false)
  if (NON_REPORTED_CLASSES.has(cls)) return null

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
