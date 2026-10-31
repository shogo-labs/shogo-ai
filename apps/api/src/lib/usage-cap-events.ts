// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The one place a 402 usage gate records that it happened.
 *
 * Before this, only `project-chat.ts` told Loops (`usage_limit_hit`), the
 * workspace chat — where nearly all traffic is — told nobody, and nothing was
 * persisted. So "how many people hit the free cap, and did they come back"
 * was unanswerable (SHO-258 §2), and the credits-reset job (§4) had no
 * durable "this wallet is owed a 'your agent is back'" flag to work from.
 *
 * Every 402 site reaches here through `buildUsageLimitInfo`, so adding a route
 * later can't silently skip the instrumentation.
 */
import { prisma } from './prisma'
import { trackEvent } from '../services/loops.service'

export interface UsageLimitHit {
  workspaceId: string
  /** Whose cap it is. Omitted for runtime/internal turns, which have no user. */
  userId?: string | null
  /** The window that gated the request (`five_hour` / `weekly`) when known. */
  window?: string | null
  /** Which surface was blocked, for segmentation: chat / ai-proxy / voice. */
  source?: string
}

/**
 * Best-effort: a metrics write must never turn a 402 into a 500, so every step
 * is individually guarded and the whole thing resolves.
 */
export async function reportUsageLimitHit(hit: UsageLimitHit): Promise<void> {
  const userId = hit.userId && hit.userId !== 'system' ? hit.userId : null
  const now = new Date()

  if (userId) {
    try {
      // Set once — the funnel wants "first cap", not "last cap".
      await prisma.user.updateMany({
        where: { id: userId, firstCapHitAt: null },
        data: { firstCapHitAt: now },
      })
    } catch (error: any) {
      console.warn('[usage-cap] firstCapHitAt write failed:', error?.message ?? error)
    }
  }

  try {
    // Set once per cap: refreshed only after the reset job clears it.
    await prisma.usageWallet.updateMany({
      where: { workspaceId: hit.workspaceId, capNotifyPendingAt: null },
      data: { capNotifyPendingAt: now },
    })
  } catch (error: any) {
    console.warn('[usage-cap] capNotifyPendingAt write failed:', error?.message ?? error)
  }

  if (userId) {
    // Fire-and-forget: an HTTP call to Loops must not slow down a 402 that the
    // user is waiting on.
    trackEvent(userId, 'hit_cap', {
      workspace_id: hit.workspaceId,
      window: hit.window ?? null,
      source: hit.source ?? 'chat',
    }).catch((error: any) => console.warn('[usage-cap] hit_cap event failed:', error?.message ?? error))
  }
}

/**
 * Marks the first time a user opened one of their own project previews — the
 * funnel step between "sent a message" and "came back" (SHO-258 §7).
 */
export async function recordFirstPreviewSeen(userId: string | null | undefined): Promise<void> {
  if (!userId || userId === 'system') return
  try {
    await prisma.user.updateMany({
      where: { id: userId, firstPreviewSeenAt: null },
      data: { firstPreviewSeenAt: new Date() },
    })
  } catch (error: any) {
    console.warn('[usage-cap] firstPreviewSeenAt write failed:', error?.message ?? error)
  }
}
