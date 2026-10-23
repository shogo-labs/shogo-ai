// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import * as billingService from '../services/billing-runtime'

/**
 * Build the time-gating detail attached to a 402 "usage limit reached"
 * response. When a rolling window is exhausted this surfaces which window
 * gated the request and when it next resets, so clients can show a
 * "resets in X" countdown (mirroring Codex / Claude Code). Best-effort:
 * returns nulls if the windows can't be resolved.
 */
export async function buildUsageLimitInfo(
  workspaceId: string,
): Promise<{ resetsAt: string | null; window: string | null; retryAfterSeconds: number | null }> {
  try {
    const w = await billingService.getUsageWindows(workspaceId)
    const exhausted = [w.fiveHour, w.weekly].filter(
      (s) => s.limitUsd != null && s.utilization >= 1 && s.resetsAt != null,
    )
    if (exhausted.length === 0) return { resetsAt: null, window: null, retryAfterSeconds: null }
    const soonest = exhausted.reduce((a, b) =>
      a.resetsAt!.getTime() <= b.resetsAt!.getTime() ? a : b,
    )
    return {
      resetsAt: soonest.resetsAt!.toISOString(),
      window: soonest.kind,
      retryAfterSeconds: Math.max(0, Math.ceil((soonest.resetsAt!.getTime() - Date.now()) / 1000)),
    }
  } catch {
    return { resetsAt: null, window: null, retryAfterSeconds: null }
  }
}
