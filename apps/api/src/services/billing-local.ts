// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Local-mode usage recording, shared by `billing.service.ts` and the
 * `billing-runtime.ts` seam so desktop records usage the same way whichever
 * module a route imports. Must stay free of Stripe / cloud dependencies —
 * it is part of the local API bundle.
 */
import { prisma } from '../lib/prisma'
import type { ConsumeUsageParams, ConsumeUsageResult } from './billing.service'

type UsageEventData = Parameters<typeof prisma.usageEvent.create>[0]['data']

/** Local installs are uncapped: record the event for analytics and never debit. */
export async function recordLocalUsage(params: ConsumeUsageParams): Promise<ConsumeUsageResult> {
  const { workspaceId, projectId, memberId, actionType, actionMetadata } = params
  try {
    await prisma.usageEvent.create({
      data: {
        workspaceId,
        projectId,
        memberId,
        actionType,
        rawUsd: params.rawUsd ?? null,
        billedUsd: 0,
        source: 'daily',
        balanceBefore: 0,
        balanceAfter: 0,
        actionMetadata: (actionMetadata ?? null) as UsageEventData['actionMetadata'],
      },
    })
  } catch (e) {
    console.warn('[billing] Failed to record local usage event:', e)
  }
  return { success: true, remainingIncludedUsd: Infinity, overageChargedUsd: 0, source: 'daily' }
}
