// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Inference retry telemetry.
 *
 * The agent loop retries transient model failures without a limit (fast tier,
 * connectivity park, provider backoff), so users rarely see these failures.
 * These structured records (routed to SigNoz via the OTEL log sink, same as
 * `canvas-slo.ts`) are how we see how often each layer fires, how long users
 * wait, and which failures look deterministic despite a transient
 * classification.
 *
 *   - `inference_retry_episode` — one per retry episode, when it ends.
 *   - `inference_retry_long` — once per episode that is still retrying after
 *     `LONG_RETRY_MS`, so ongoing outages can alert before they resolve.
 *   - `inference_retry_no_progress` — once per episode flagged
 *     `suspectedDeterministic` (identical failures, nothing new).
 *   - `inference_retry_now` — the user tapped "Retry now".
 *
 * Keep attribute names stable; saved SigNoz queries depend on them.
 */

import { createLogger } from '@shogo/shared-runtime'
import type { RetryEpisodeSummary } from './agent-loop'

const log = createLogger('retry-telemetry')

export const LONG_RETRY_MS = 2 * 60_000

interface RetryContext {
  sessionId: string
  model: string
  provider?: string
}

function base(ctx: RetryContext) {
  return {
    projectId: process.env.PROJECT_ID ?? null,
    sessionId: ctx.sessionId,
    model: ctx.model,
    provider: ctx.provider ?? null,
  }
}

export function recordRetryEpisode(ctx: RetryContext, summary: RetryEpisodeSummary): void {
  try {
    const attrs = {
      event: 'inference_retry_episode',
      ...base(ctx),
      layer: summary.layer,
      reason: summary.reason,
      attempts: summary.attempts,
      elapsedMs: summary.elapsedMs,
      outcome: summary.outcome,
      suspectedDeterministic: summary.suspectedDeterministic,
      error: summary.error,
    }
    if (summary.outcome === 'recovered') log.info('inference retry episode recovered', attrs)
    else log.warn(`inference retry episode ended: ${summary.outcome}`, attrs)
  } catch {
    /* telemetry is best-effort */
  }
}

export function recordRetryLong(
  ctx: RetryContext,
  info: { layer: string; reason: string; attempt: number; elapsedMs: number; error?: string },
): void {
  try {
    log.warn('inference retry still running after 2 minutes', {
      event: 'inference_retry_long',
      ...base(ctx),
      layer: info.layer,
      reason: info.reason,
      attempt: info.attempt,
      elapsedMs: info.elapsedMs,
      error: info.error?.slice(0, 300) ?? null,
    })
  } catch {
    /* best-effort */
  }
}

export function recordRetryNoProgress(
  ctx: RetryContext,
  info: { reason: string; attempt: number; elapsedMs: number; error: string },
): void {
  try {
    log.warn('inference retry making no progress — possible misclassified deterministic failure', {
      event: 'inference_retry_no_progress',
      ...base(ctx),
      reason: info.reason,
      attempt: info.attempt,
      elapsedMs: info.elapsedMs,
      error: info.error.slice(0, 300),
    })
  } catch {
    /* best-effort */
  }
}

export function recordRetryNow(ctx: RetryContext, woke: boolean): void {
  try {
    log.info('user requested retry now', {
      event: 'inference_retry_now',
      ...base(ctx),
      woke,
    })
  } catch {
    /* best-effort */
  }
}
