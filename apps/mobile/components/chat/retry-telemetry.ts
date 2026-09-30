// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Client-side retry telemetry (Sentry). Server-side episodes are logged by
 * the runtime (`inference_retry_*` in SigNoz); these cover what only the
 * client sees: its own network retries, how long users actually wait, and
 * what they do about it.
 *
 *   - breadcrumbs for every retry start/end (context for any later error)
 *   - `chat_retry_episode`  — sampled summary of each finished client retry
 *   - `chat_retry_long`     — unsampled, once per episode that passes 2 minutes
 *   - `chat_retry_action`   — unsampled user actions during a retry
 *                             (`retry_now_clicked`, `cancelled_during_retry`,
 *                             `switched_model_during_overload`)
 */

import * as Sentry from "@sentry/react-native"
import { SHOGO_TELEMETRY_TAG, type AutoResumeRetryState } from "@shogo/shared-app/chat"
import type { RetryCause } from "./turns/turnRetryStatus"

export const RETRY_EPISODE_SAMPLE_RATE = 0.1

export interface RetryTelemetryContext {
  projectId?: string | null
  chatSessionId?: string | null
  model?: string | null
}

function tags(ctx: RetryTelemetryContext, extra: Record<string, string>) {
  return {
    [SHOGO_TELEMETRY_TAG]: "chat_retry",
    projectId: ctx.projectId ?? "(none)",
    chatSessionId: ctx.chatSessionId ?? "(none)",
    ...(ctx.model ? { model: ctx.model } : {}),
    ...extra,
  }
}

function safely(fn: () => void) {
  try {
    fn()
  } catch (err) {
    console.warn("[retry-telemetry] Sentry call threw:", err)
  }
}

export function recordClientRetryState(
  ctx: RetryTelemetryContext,
  state: AutoResumeRetryState,
  random: () => number = Math.random,
): void {
  safely(() => {
    Sentry.addBreadcrumb({
      category: "chat.retry",
      level: state.active ? "warning" : "info",
      message: state.active
        ? `${state.kind} retry ${state.attempt}${state.offline ? " (offline)" : ""}: ${state.error ?? ""}`
        : `${state.kind} retry ended: ${state.outcome} after ${state.attempt}`,
    })
    if (state.active || random() >= RETRY_EPISODE_SAMPLE_RATE) return
    Sentry.captureMessage("chat_retry_episode", {
      level: "info",
      tags: tags(ctx, { kind: state.kind, outcome: state.outcome ?? "unknown" }),
      extra: {
        attempts: state.attempt,
        elapsedMs: Date.now() - state.startedAt,
        sampleRate: RETRY_EPISODE_SAMPLE_RATE,
      },
    })
  })
}

export function recordClientRetryLong(
  ctx: RetryTelemetryContext,
  info: { cause: RetryCause; reason?: string; elapsedMs: number; suspectedDeterministic?: boolean },
): void {
  safely(() => {
    Sentry.captureMessage("chat_retry_long", {
      level: "warning",
      tags: tags(ctx, { cause: info.cause, ...(info.reason ? { reason: info.reason } : {}) }),
      extra: { elapsedMs: info.elapsedMs, suspectedDeterministic: !!info.suspectedDeterministic },
    })
  })
}

export type RetryUserAction =
  | "retry_now_clicked"
  | "cancelled_during_retry"
  | "switched_model_during_overload"

export function recordRetryUserAction(
  ctx: RetryTelemetryContext,
  action: RetryUserAction,
  info: { cause: RetryCause; elapsedMs: number; toModel?: string },
): void {
  safely(() => {
    Sentry.captureMessage("chat_retry_action", {
      level: "info",
      tags: tags(ctx, { action, cause: info.cause }),
      extra: { elapsedMs: info.elapsedMs, ...(info.toModel ? { toModel: info.toModel } : {}) },
    })
  })
}
