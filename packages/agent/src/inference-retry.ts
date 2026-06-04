// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Inference reconnect/retry for the agent loop.
 *
 * When a single model call drops mid-generation with a *retryable* failure
 * (network reset, provider 5xx, idle timeout, a stream that ended before
 * `message_stop`), the safe recovery is to re-issue that same call rather than
 * end the turn. pi-agent-core runs tools only AFTER a complete assistant
 * message, so a call that died mid-generation never executed that step's tools
 * — re-issuing it is idempotent w.r.t. side effects. The earlier completed
 * steps stay in the transcript and are reused via `Agent.continue()`.
 *
 * This module owns:
 *   - option resolution (caps, backoff, env overrides), mirroring
 *     `resolveStallFallbackOptions` in `stall-fallback.ts`.
 *   - detecting whether the last attempt failed and extracting its error text.
 *   - stripping the failed assistant tail so `Agent.continue()` can re-drive
 *     from the last user/tool-result message.
 *
 * The actual retry loop lives in `agent-loop.ts` (it needs the live `Agent`).
 */

import type { Message } from '@mariozechner/pi-ai'
import type { RetryReason } from './retry-classifier'

export interface InferenceRetryOptions {
  /** Max number of re-issues (continues) after the initial attempt. Default 2. */
  maxAttempts?: number
  /** Base backoff delay in ms (doubled per attempt). Default 500. */
  baseDelayMs?: number
  /** Cap on a single backoff delay in ms. Default 8000. */
  maxDelayMs?: number
  /** Apply +/- jitter to the backoff. Default true. */
  jitter?: boolean
  /** Injectable delay computer (tests can assert/replace). */
  computeDelayMs?: (attempt: number) => number
  /** Injectable sleep (tests pass a no-op / fake-timer). */
  sleep?: (ms: number) => Promise<void>
}

export interface ResolvedInferenceRetry {
  maxAttempts: number
  computeDelayMs: (attempt: number) => number
  sleep: (ms: number) => Promise<void>
}

export interface InferenceRetryInfo {
  /** 1-based attempt index (1 = first retry). */
  attempt: number
  maxAttempts: number
  reason: RetryReason
  delayMs: number
  /** The (cleaned) error text that triggered the retry. */
  error: string
}

const DEFAULT_MAX_ATTEMPTS = 2
const DEFAULT_BASE_DELAY_MS = 500
const DEFAULT_MAX_DELAY_MS = 8_000

function envInt(name: string): number | undefined {
  const raw = process.env[name]
  if (raw == null || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Resolve effective inference-retry options from explicit config + env.
 * Returns `null` when retries are disabled.
 *
 * Env:
 * - `SHOGO_INFERENCE_RETRY=0|false|off` disables it entirely.
 * - `SHOGO_INFERENCE_RETRY_MAX_ATTEMPTS=<n>` overrides the retry cap.
 * - `SHOGO_INFERENCE_RETRY_BASE_MS=<n>` overrides the base backoff.
 */
export function resolveInferenceRetryOptions(
  explicit?: InferenceRetryOptions | false,
): ResolvedInferenceRetry | null {
  if (explicit === false) return null
  const envFlag = (process.env.SHOGO_INFERENCE_RETRY ?? '').trim().toLowerCase()
  if (envFlag === '0' || envFlag === 'false' || envFlag === 'off') return null

  const o = explicit ?? {}
  const rawMax = o.maxAttempts ?? envInt('SHOGO_INFERENCE_RETRY_MAX_ATTEMPTS') ?? DEFAULT_MAX_ATTEMPTS
  const maxAttempts = Math.max(0, Math.min(10, Math.floor(rawMax)))
  if (maxAttempts <= 0) return null

  const base = o.baseDelayMs ?? envInt('SHOGO_INFERENCE_RETRY_BASE_MS') ?? DEFAULT_BASE_DELAY_MS
  const max = o.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const jitter = o.jitter ?? true

  const computeDelayMs =
    o.computeDelayMs ??
    ((attempt: number) => {
      const raw = Math.min(max, base * Math.pow(2, Math.max(0, attempt - 1)))
      // Half-jitter: keep at least 50% of the computed delay so backoff still grows.
      return jitter ? Math.round(raw * (0.5 + Math.random() * 0.5)) : Math.round(raw)
    })

  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  return { maxAttempts, computeDelayMs, sleep }
}

export interface InferenceFailure {
  errorText: string
  stopReason?: string
}

/**
 * Inspect the transcript after an attempt and decide whether the last model
 * call failed. Returns the failure details, or `null` if the last assistant
 * turn completed cleanly.
 *
 * pi-agent-core catches stream errors internally and appends an assistant
 * message carrying `errorMessage` / `stopReason: 'error'` rather than throwing,
 * so we inspect the trailing assistant message. A directly-thrown error
 * (`promptError`) takes precedence.
 */
export function detectInferenceFailure(
  messages: Message[],
  promptError?: Error,
): InferenceFailure | null {
  if (promptError) {
    return { errorText: promptError.message || String(promptError) }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as any
    if (m.role !== 'assistant') continue
    if (m.errorMessage || m.stopReason === 'error') {
      return { errorText: m.errorMessage || 'Provider error', stopReason: m.stopReason }
    }
    // First (trailing) assistant message is clean -> the turn succeeded.
    return null
  }
  return null
}

/**
 * Return a copy of `messages` with the trailing failed assistant message(s)
 * removed, or `null` if there was nothing to strip. A "failed" assistant
 * message is one with an `errorMessage`, `stopReason: 'error'`, or no usable
 * content. Stripping leaves the transcript ending on the last user/tool-result
 * message so `Agent.continue()` can re-issue the dropped call.
 */
export function stripTrailingFailedAssistants(messages: Message[]): Message[] | null {
  let end = messages.length
  while (end > 0) {
    const m = messages[end - 1] as any
    if (m.role !== 'assistant') break
    const hasError = !!m.errorMessage || m.stopReason === 'error'
    const emptyContent =
      !Array.isArray(m.content) ||
      m.content.length === 0 ||
      m.content.every(
        (c: any) =>
          (c.type === 'text' && !(c.text && c.text.trim())) ||
          (c.type === 'thinking' && !(c.thinking && c.thinking.trim())),
      )
    if (hasError || emptyContent) {
      end--
      continue
    }
    break
  }
  if (end === messages.length) return null
  return messages.slice(0, end)
}
