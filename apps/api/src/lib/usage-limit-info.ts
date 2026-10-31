// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import * as billingService from '../services/billing-runtime'
import { reportUsageLimitHit } from './usage-cap-events'

/**
 * Build the time-gating detail attached to a 402 "usage limit reached"
 * response. When a rolling window is exhausted this surfaces which window
 * gated the request and when it next resets, so clients can show a
 * "resets in X" countdown (mirroring Codex / Claude Code). Best-effort:
 * returns nulls if the windows can't be resolved.
 *
 * This is also where a cap gets recorded (`firstCapHitAt`, the wallet's
 * `capNotifyPendingAt`, the `hit_cap` event), because every 402 site in the
 * API builds its payload here — one hook instead of one per route.
 */
export async function buildUsageLimitInfo(
  workspaceId: string,
  hit: { userId?: string | null; source?: string } = {},
): Promise<{ resetsAt: string | null; window: string | null; retryAfterSeconds: number | null }> {
  let window: string | null = null
  let resetsAt: string | null = null
  let retryAfterSeconds: number | null = null
  try {
    const w = await billingService.getUsageWindows(workspaceId)
    const exhausted = [w.fiveHour, w.weekly].filter(
      (s) => s.limitUsd != null && s.utilization >= 1 && s.resetsAt != null,
    )
    if (exhausted.length > 0) {
      const soonest = exhausted.reduce((a, b) =>
        a.resetsAt!.getTime() <= b.resetsAt!.getTime() ? a : b,
      )
      window = soonest.kind
      resetsAt = soonest.resetsAt!.toISOString()
      retryAfterSeconds = Math.max(0, Math.ceil((soonest.resetsAt!.getTime() - Date.now()) / 1000))
    }
  } catch {
    /* windows unavailable — the 402 still goes out without a countdown */
  }

  await reportUsageLimitHit({ workspaceId, userId: hit.userId, window, source: hit.source })

  return { resetsAt, window, retryAfterSeconds }
}
