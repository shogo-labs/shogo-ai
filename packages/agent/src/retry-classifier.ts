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

/**
 * What actually went wrong with a turn, as opposed to whether a single model
 * call is worth retrying. Each class has exactly one better ending than a
 * generic "the model did not produce a final answer" message: a usage-limit
 * notice, a ceiling summary, a cross-family failover, or a plain retry line.
 *
 * `classifyTurnFailure` is the single place that decides this, so the loop, the
 * gateway and the copy shown to a person never disagree about what happened.
 */
export type TurnFailureClass =
  | 'aborted_by_user'
  | 'iteration_ceiling'
  | 'usage_limit'
  | 'bad_tool_id'
  | 'bad_image'
  | 'too_large'
  | 'refusal'
  | 'content_filter'
  | 'upstream_400'
  | 'invalid_request'
  | 'network'
  | 'unknown'

export interface TurnFailureInput {
  /** Raw error text, already stripped of any JSON wrapper where possible. */
  rawError?: string | null
  /** Why the loop stopped early, if it did. */
  abortReason?: 'external' | 'max_iterations' | 'loop_detected' | null
  /** stopReason of the last assistant message (`refusal`, `sensitive`, …). */
  stopReason?: string | null
  /** How many tool calls the turn completed. */
  toolCalls?: number
}

/**
 * Billing failures that belong to the *upstream provider account*, not to the
 * person using Shogo. They look like usage limits but no upgrade fixes them, so
 * they must never produce the usage-limit notice.
 */
const UPSTREAM_BILLING_FAILURE =
  /credit balance is too low|insufficient_quota|insufficient (credits|funds|balance)|billing[_ ]hard[_ ]limit/i

/** True when the text is Shogo's own out-of-usage signal (upgrade helps). */
export function isUsageLimitFailure(raw?: string | null): boolean {
  if (!raw) return false
  if (UPSTREAM_BILLING_FAILURE.test(raw)) return false
  return /usage_limit_reached|usage limit reached|reached your usage limit|spending cap|overage_cap_reached|overage_payment_pending/i.test(
    raw,
  )
}

/**
 * A tool-call id the next provider refused (`messages.1.content.0.tool_use.id: …`).
 * Requires the provider's key form (`tool_use.id`, `tool_call_id`) so a JS
 * identifier like `sanitizeToolCallId` in a stack trace is not mistaken for one.
 */
const BAD_TOOL_ID_FAILURE = /\btool[_.](?:use|call)[_.]?id\b|\btool[_.]?(?:use|call)[_.]id\b/i

/** An image block the provider rejected outright. */
const BAD_IMAGE_FAILURE =
  /unsupported image|uploaded an unsupported image|invalid image|image (is )?(too large|corrupt|invalid)|does not support (images?|vision)|image input is not supported|could not (process|load|decode) (the )?image/i

/** Request too large for the provider (413), including the proxy's rewrapped form. */
const TOO_LARGE_FAILURE = /\b413\b|payload too large|request entity too large|request too large|length limit exceeded/i

/** The model itself declined the request — another model may not. */
const REFUSAL_FAILURE = /stop_reason[\"'\s:=]+(refusal|sensitive)|model refused|declined to (answer|respond)/i

/** Provider-side safety filtering of the content. */
const CONTENT_FILTER_FAILURE =
  /content[_\s-]?(policy|filter)|moderation|safety (system|filter)|content exists risk|sensitive content|flagged/i

/**
 * A 400 the *upstream provider* returned, with or without a specific cause.
 * A bare `400` / `invalid_request_error` is our own malformed payload — every
 * family rejects it the same way, so it is not failover-eligible.
 */
const UPSTREAM_400_FAILURE =
  /provider returned error|upstream (provider )?(error|rejected|returned)|content exists risk/i

/**
 * Classes the gateway can answer by re-running the turn on a model from a
 * different provider family. These are *not* retried on the same model: the
 * model already gave its answer.
 */
export function isFailoverFailure(cls: TurnFailureClass): boolean {
  return cls === 'refusal' || cls === 'content_filter' || cls === 'upstream_400'
}

/**
 * Classify a failed turn. Ordered so the most specific true cause wins: an
 * abort is never a provider failure, a usage limit is never a refusal, and a
 * named 400 cause beats the generic "provider returned error" wrapper.
 */
export function classifyTurnFailure(input: TurnFailureInput): TurnFailureClass {
  if (input.abortReason === 'external') return 'aborted_by_user'
  if (input.abortReason === 'max_iterations') return 'iteration_ceiling'

  const raw = input.rawError ?? ''
  const stopReason = (input.stopReason ?? '').toLowerCase()

  if (isUsageLimitFailure(raw)) return 'usage_limit'
  if (BAD_TOOL_ID_FAILURE.test(raw)) return 'bad_tool_id'
  if (BAD_IMAGE_FAILURE.test(raw)) return 'bad_image'
  if (TOO_LARGE_FAILURE.test(raw)) return 'too_large'
  if (stopReason === 'refusal' || stopReason === 'sensitive' || REFUSAL_FAILURE.test(raw)) return 'refusal'
  if (CONTENT_FILTER_FAILURE.test(raw)) return 'content_filter'

  const { reason } = classifyRetryability({ message: raw, stopReason: input.stopReason })
  if (reason === 'network' || reason === 'timeout' || reason === 'idle_timeout' || reason === 'truncated') {
    return 'network'
  }
  if (reason === 'server_5xx' || reason === 'overloaded' || reason === 'upstream_error') return 'network'
  if (reason === 'aborted') return 'aborted_by_user'

  if (UPSTREAM_400_FAILURE.test(raw)) return 'upstream_400'
  // A request-shape 400 (role ordering, invalid params, a malformed payload)
  // fails identically on every family, so it is never failover-eligible.
  if (reason === 'invalid_request') return 'invalid_request'
  return 'unknown'
}

/**
 * The one line a person sees when a turn could not be finished and nothing
 * better applies. Never contains provider text.
 */
export function buildTurnFailureMessage(cls: TurnFailureClass | undefined, toolCallCount: number): string {
  const steps =
    toolCallCount > 0
      ? ` I completed ${toolCallCount} step${toolCallCount === 1 ? '' : 's'} and saved that work.`
      : ''
  if (cls === 'iteration_ceiling') {
    return `I hit the step limit for this turn, so I stopped before writing the final answer.${steps} Send another message and I'll pick up exactly where I left off.`
  }
  if (cls === 'content_filter') {
    return `The model provider's content filter blocked this request.${steps} Try rephrasing it, or continue with a different model.`
  }
  if (cls === 'invalid_request') {
    return `The request to the model was rejected as malformed.${steps} Send another message to pick up from here; if it keeps happening, start a new conversation.`
  }
  return `The model couldn't finish this step.${steps} Your work so far is saved — send another message to pick up from here.`
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
    case 'network_drop':
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
  [/provider (is )?not configured|provider .*not configured|not configured on this server/i, 'auth'],
  [/\bunauthorized\b|invalid[_\s-]?api[_\s-]?key|authentication|permission denied|\b401\b|\b403\b/i, 'auth'],
  [/content[_\s-]?(policy|filter)|moderation|safety (system|filter)|stop_reason["'\s:]+content_filter/i, 'content_policy'],
  [/billing|insufficient[_\s]?(credits|funds|balance)|payment required|\b402\b|quota (exceeded|reached)|usage limit/i, 'billing'],
  [/invalid[_\s-]?request|\b400\b|\bunprocessable\b|\b422\b|prompt is too long|maximum context length|context (length|window) (exceeded|too)/i, 'invalid_request'],
  // The proxy can wrap an upstream 413 as a 500 ("500 custom API error (413):
  // ... length limit exceeded"); a longer wait never shrinks the request.
  [/\b413\b|payload too large|request entity too large|length limit exceeded/i, 'invalid_request'],
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
