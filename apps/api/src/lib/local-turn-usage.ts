// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop: record a finished chat turn into the local workspace's analytics
 * (`usage_events` + `agent_cost_metrics`) from the token counts the runtime
 * reported on its own stream. Writes the same rows `closeSession` writes in
 * cloud, minus the wallet debit (local usage is never billed).
 *
 * Must stay free of Redis / Stripe imports — it is part of the local API bundle.
 */
import { calculateUsageCost, proxyModelToBillingModel } from './usage-cost'
import { recordLocalUsage } from '../services/billing-local'
import { recordAgentCostMetric } from '../services/cost-analytics.service'
import type { BillingSessionFallbackUsage, BillingSessionQualitySignals } from './proxy-billing-session'

export interface LocalTurnUsage {
  workspaceId: string
  projectId: string | null
  userId: string
  chatSessionId?: string | null
  usage: BillingSessionFallbackUsage
  quality?: BillingSessionQualitySignals
  openedAt?: number
  /** Proxied LLM calls in the turn, when known (recorded as `toolCalls`, like cloud). */
  requestCount?: number
  /** `usage_events.actionMetadata.usageSource`. */
  usageSource?: 'stream-fallback' | 'local-proxy'
}

export async function recordLocalTurnUsage(
  turn: LocalTurnUsage,
): Promise<{ billedUsd: number; rawUsd: number; totalTokens: number }> {
  const inputTokens = turn.usage.inputTokens || 0
  const outputTokens = turn.usage.outputTokens || 0
  const cachedInputTokens = turn.usage.cachedInputTokens || 0
  const cacheWriteTokens = turn.usage.cacheWriteTokens || 0
  const totalTokens = inputTokens + outputTokens + cachedInputTokens + cacheWriteTokens
  if (totalTokens === 0) return { billedUsd: 0, rawUsd: 0, totalTokens: 0 }

  const model = turn.usage.model || 'sonnet'
  const billingModel = proxyModelToBillingModel(model)
  const { rawUsd, billedUsd: tokenBilledUsd, pricingUnknown } = calculateUsageCost(
    inputTokens, outputTokens, model, cachedInputTokens, cacheWriteTokens,
  )
  const durationMs = turn.openedAt ? Date.now() - turn.openedAt : 0
  const quality = turn.quality ?? {}
  const source = {
    ...(turn.chatSessionId ? { chatSessionId: turn.chatSessionId } : {}),
    usageSource: turn.usageSource ?? 'stream-fallback',
    ...(pricingUnknown ? { pricingUnknown } : {}),
  }

  await Promise.all([
    recordAgentCostMetric({
      workspaceId: turn.workspaceId,
      projectId: turn.projectId ?? undefined,
      agentType: 'main-chat',
      model,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheWriteTokens,
      toolCalls: turn.requestCount ?? 0,
      creditCost: 0,
      wallTimeMs: durationMs,
      success: quality.success === true,
      hitMaxTurns: quality.hitMaxTurns ?? false,
      loopDetected: quality.loopDetected ?? false,
      escalated: quality.escalated ?? false,
      responseEmpty: quality.responseEmpty ?? false,
      metadata: source,
    }).catch((err) => console.warn('[LocalTurnUsage] Failed to record cost metric:', err?.message ?? err)),
    recordLocalUsage({
      workspaceId: turn.workspaceId,
      projectId: turn.projectId,
      memberId: turn.userId,
      actionType: 'chat_message',
      rawUsd,
      billedUsd: 0,
      actionMetadata: {
        inputTokens,
        cachedInputTokens,
        cacheWriteTokens,
        outputTokens,
        totalTokens,
        model,
        billingModel,
        rawUsd,
        tokenRawUsd: rawUsd,
        tokenBilledUsd,
        durationMs,
        ...source,
      },
    }),
  ])

  return { billedUsd: 0, rawUsd, totalTokens }
}
