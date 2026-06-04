// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Retryability classifier for inference (model-call) failures.
 *
 * A single LLM call can fail mid-generation for many reasons. Some are
 * transient and safe to re-issue (network reset, provider 5xx, idle timeout,
 * a stream that ended before `message_stop`); others are definitive and must
 * NOT be retried (user abort, auth/permission, malformed request, content
 * policy, billing). This module makes that decision in one place so the agent
 * loop and any callers stay consistent.
 *
 * Two signal sources are supported, in priority order:
 *   1. A structured marker embedded by Shogo's AI proxy in the error message
 *      (`[shogo:retryable=<bool>;code=<code>]`). This is the authoritative
 *      signal and survives whatever wrapping the provider SDK applies.
 *   2. String/heuristic matching on the raw error text + HTTP status as a
 *      fallback when no marker is present (direct provider calls, thrown
 *      Errors, non-proxied paths).
 *
 * A user-initiated abort is ALWAYS non-retryable regardless of any other
 * signal.
 */

export type RetryReason =
  | 'network'
  | 'timeout'
  | 'idle_timeout'
  | 'server_5xx'
  | 'overloaded'
  | 'truncated'
  | 'aborted'
  | 'auth'
  | 'invalid_request'
  | 'content_policy'
  | 'billing'
  | 'upstream_error'
  | 'unknown'

export interface RetryClassification {
  retryable: boolean
  reason: RetryReason
}

export interface RetryClassifyInput {
  /** Raw error text (pi-ai `errorMessage` or a thrown Error's message). */
  message?: string | null
  /** stopReason from the failed assistant message, if known. */
  stopReason?: string | null
  /** HTTP-ish status code, if known. */
  status?: number | null
  /** True when the failure was a user-initiated abort (never retryable). */
  aborted?: boolean
  /** Structured retryable override (e.g. already-decided upstream). */
  retryable?: boolean | null
}

/**
 * Stable marker the AI proxy embeds in stream-error messages so the
 * retryable flag + code survive transport into pi-ai's `errorMessage`.
 * Keep this format in sync with `apps/api/src/routes/ai-proxy.ts`.
 */
const STREAM_ERROR_MARKER = /\[shogo:retryable=(true|false);code=([a-z0-9_]+)\]/i

export interface StreamErrorMarker {
  retryable: boolean
  code: string
}

/** Parse the proxy's `[shogo:retryable=...;code=...]` marker, if present. */
export function parseStreamErrorMarker(message?: string | null): StreamErrorMarker | null {
  if (!message) return null
  const m = STREAM_ERROR_MARKER.exec(message)
  if (!m) return null
  return { retryable: m[1].toLowerCase() === 'true', code: m[2].toLowerCase() }
}

/** Strip the proxy marker so user-facing error text stays clean. */
export function stripStreamErrorMarker(message?: string | null): string {
  if (!message) return ''
  return message.replace(/\s*\[shogo:retryable=[^\]]*\]/gi, '').trim()
}

function codeToReason(code: string): RetryReason {
  switch (code) {
    case 'idle_timeout':
      return 'idle_timeout'
    case 'upstream_truncated':
      return 'truncated'
    case 'upstream_error':
      return 'upstream_error'
    case 'econnreset':
    case 'econnrefused':
    case 'epipe':
    case 'network_error':
      return 'network'
    case 'etimedout':
    case 'timeout':
      return 'timeout'
    default:
      return 'unknown'
  }
}

function classifyByStatus(status: number): RetryClassification | null {
  if (status === 408 || status === 425) return { retryable: true, reason: 'timeout' }
  if (status === 429) return { retryable: true, reason: 'overloaded' }
  if (status >= 500 && status <= 599) return { retryable: true, reason: 'server_5xx' }
  if (status === 401 || status === 403) return { retryable: false, reason: 'auth' }
  if (status === 402) return { retryable: false, reason: 'billing' }
  if (status === 400 || status === 404 || status === 422) return { retryable: false, reason: 'invalid_request' }
  return null
}

// Non-retryable patterns take precedence over retryable ones so that, e.g.,
// "401 connection" is treated as auth rather than network.
const NON_RETRYABLE_PATTERNS: Array<[RegExp, RetryReason]> = [
  [/\bunauthorized\b|invalid[_\s-]?api[_\s-]?key|authentication|permission denied|\b401\b|\b403\b/i, 'auth'],
  [/content[_\s-]?(policy|filter)|moderation|safety (system|filter)|stop_reason["'\s:]+content_filter/i, 'content_policy'],
  [/billing|insufficient[_\s]?(credits|funds|balance)|payment required|\b402\b|quota (exceeded|reached)|usage limit/i, 'billing'],
  [/invalid[_\s-]?request|\b400\b|\bunprocessable\b|\b422\b|prompt is too long|maximum context length|context (length|window) (exceeded|too)/i, 'invalid_request'],
]

const RETRYABLE_PATTERNS: Array<[RegExp, RetryReason]> = [
  [/idle[_\s-]?timeout/i, 'idle_timeout'],
  [/(ended|stopped|closed|dropped) (without|before) (a )?message_stop|upstream_truncated|truncat(ed|ion)|premature (close|end)|unexpected end of/i, 'truncated'],
  [/\b429\b|rate[_\s-]?limit|overloaded|too many requests|capacity/i, 'overloaded'],
  [/\b50[0-9]\b|\b502\b|\b503\b|\b504\b|internal server error|bad gateway|service unavailable|gateway timeout|server error/i, 'server_5xx'],
  [/econnreset|econnrefused|enotfound|ehostunreach|enetunreach|epipe|socket hang up|fetch failed|network (error|failure)|connection (reset|closed|refused|error|lost|aborted|terminated)|stream (error|dropped|interrupted|faulted)|terminated|read econnreset/i, 'network'],
  [/etimedout|timed out|stream timed out|request timeout|deadline exceeded/i, 'timeout'],
]

/**
 * Classify whether an inference failure is safe to retry.
 *
 * Decision order:
 *   1. User abort -> never retryable.
 *   2. Proxy marker (authoritative structured signal).
 *   3. Explicit `retryable` override.
 *   4. HTTP status.
 *   5. Non-retryable text patterns, then retryable text patterns.
 *   6. Default: non-retryable / unknown (conservative — don't burn tokens or
 *      loop on errors we don't recognize).
 */
export function classifyRetryability(input: RetryClassifyInput): RetryClassification {
  if (input.aborted || input.stopReason === 'aborted') {
    return { retryable: false, reason: 'aborted' }
  }

  const marker = parseStreamErrorMarker(input.message)
  if (marker) {
    return { retryable: marker.retryable, reason: codeToReason(marker.code) }
  }

  if (typeof input.retryable === 'boolean') {
    // Honor the structured flag; still derive a best-effort reason from text.
    const derived = deriveReasonFromText(input.message)
    return { retryable: input.retryable, reason: derived ?? (input.retryable ? 'network' : 'unknown') }
  }

  if (typeof input.status === 'number' && Number.isFinite(input.status)) {
    const byStatus = classifyByStatus(input.status)
    if (byStatus) return byStatus
  }

  const msg = input.message ?? ''
  for (const [re, reason] of NON_RETRYABLE_PATTERNS) {
    if (re.test(msg)) return { retryable: false, reason }
  }
  for (const [re, reason] of RETRYABLE_PATTERNS) {
    if (re.test(msg)) return { retryable: true, reason }
  }

  return { retryable: false, reason: 'unknown' }
}

function deriveReasonFromText(message?: string | null): RetryReason | null {
  if (!message) return null
  for (const [re, reason] of NON_RETRYABLE_PATTERNS) {
    if (re.test(message)) return reason
  }
  for (const [re, reason] of RETRYABLE_PATTERNS) {
    if (re.test(message)) return reason
  }
  return null
}
