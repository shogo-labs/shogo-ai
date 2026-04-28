// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Proxy Billing Sessions
 *
 * Accumulates token usage across multiple AI proxy calls within a single
 * user-message turn, then charges once when the session closes.
 *
 * Problem: An agentic loop (user message → tool calls → more tool calls → final
 * response) makes N separate API calls through the AI proxy. Charging per-call
 * inflates cost because of per-call minimums and rounding.
 *
 * Solution: The caller (project-chat, /api/chat, agent-runtime) opens a billing
 * session before proxying. The AI proxy accumulates tokens against the session.
 * When the caller closes the session, we charge once based on the total.
 *
 * Keyed by projectId since projects process one message at a time.
 * Runs in-process (same API server as ai-proxy and project-chat routes).
 */

import { calculateUsageCost, proxyModelToBillingModel } from './usage-cost'
import * as billingService from '../services/billing.service'
import { recordAgentCostMetric } from '../services/cost-analytics.service'

const SESSION_TIMEOUT_MS = 10 * 60 * 1000 // 10 min safety net

export interface BillingSessionQualitySignals {
  success?: boolean
  hitMaxTurns?: boolean
  loopDetected?: boolean
  escalated?: boolean
  responseEmpty?: boolean
}

interface BillingSession {
  projectId: string
  workspaceId: string
  userId: string
  model: string
  inputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  outputTokens: number
  requestCount: number
  quality: BillingSessionQualitySignals
  openedAt: number
  lastActivityAt: number
}

const sessions = new Map<string, BillingSession>()

// Periodic cleanup of orphaned sessions (crash recovery)
setInterval(() => {
  const now = Date.now()
  for (const [key, session] of sessions) {
    if (now - session.lastActivityAt > SESSION_TIMEOUT_MS) {
      console.warn(`[BillingSession] Flushing orphaned session for project ${key} (${session.requestCount} requests, ${session.inputTokens + session.outputTokens} tokens)`)
      closeSession(key).catch(err =>
        console.error(`[BillingSession] Failed to flush orphaned session ${key}:`, err)
      )
    }
  }
}, 60_000)

/**
 * Open a billing session for a project. Subsequent AI proxy calls for this
 * project will accumulate tokens here instead of charging per-call.
 */
export function openSession(
  projectId: string,
  workspaceId: string,
  userId: string,
): void {
  // If there's an existing session (shouldn't happen, but safety), flush it first
  const existing = sessions.get(projectId)
  if (existing) {
    console.warn(`[BillingSession] Overwriting existing session for ${projectId} (${existing.requestCount} requests buffered)`)
    closeSession(projectId).catch(() => {})
  }

  sessions.set(projectId, {
    projectId,
    workspaceId,
    userId,
    model: 'sonnet',
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    requestCount: 0,
    quality: {},
    openedAt: Date.now(),
    lastActivityAt: Date.now(),
  })
}

/**
 * Check if there's an active billing session for a project.
 */
export function hasSession(projectId: string): boolean {
  return sessions.has(projectId)
}

/**
 * Accumulate token usage from an AI proxy call. Returns true if tokens were
 * accumulated against an active session, false if no session exists (caller
 * should charge per-call).
 */
export function accumulateUsage(
  projectId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number = 0,
  cacheWriteTokens: number = 0,
): boolean {
  const session = sessions.get(projectId)
  if (!session) return false

  session.inputTokens += inputTokens
  session.cachedInputTokens += cachedInputTokens
  session.cacheWriteTokens += cacheWriteTokens
  session.outputTokens += outputTokens
  session.requestCount += 1
  session.model = model
  session.lastActivityAt = Date.now()

  return true
}

export function setQualitySignals(projectId: string, quality: BillingSessionQualitySignals): boolean {
  const session = sessions.get(projectId)
  if (!session) return false
  session.quality = { ...session.quality, ...quality }
  session.lastActivityAt = Date.now()
  return true
}

/**
 * Close a billing session and charge USD based on total accumulated tokens.
 * Returns the marked-up USD charged (0 if no tokens or session not found).
 */
export async function closeSession(
  projectId: string,
): Promise<{ billedUsd: number; rawUsd: number; totalTokens: number }> {
  const session = sessions.get(projectId)
  sessions.delete(projectId)

  if (!session) {
    return { billedUsd: 0, rawUsd: 0, totalTokens: 0 }
  }

  const totalTokens = session.inputTokens + session.cachedInputTokens + session.cacheWriteTokens + session.outputTokens
  if (totalTokens === 0) {
    return { billedUsd: 0, rawUsd: 0, totalTokens: 0 }
  }

  const billingModel = proxyModelToBillingModel(session.model)
  const { rawUsd, billedUsd } = calculateUsageCost(
    session.inputTokens, session.outputTokens, billingModel,
    session.cachedInputTokens, session.cacheWriteTokens,
  )
  const durationMs = Date.now() - session.openedAt
  const finalQuality = session.quality

  // Always record cost metrics, even if billing fails (e.g. no subscription/credits).
  // Fire-and-forget so a slow analytics DB does not tax the chat close path.
  //
  // Pass `creditCost: 0` and let `recordAgentCostMetric` recompute from tokens
  // server-side. We could pass `billedUsd` here, but this path runs before any
  // markup adjustment is finalized — using the canonical token→cost catalog
  // keeps analytics consistent with the catalog displayed in the UI.
  void recordAgentCostMetric({
    workspaceId: session.workspaceId,
    projectId: session.projectId,
    agentType: 'main-chat',
    model: billingModel,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    cachedInputTokens: session.cachedInputTokens,
    toolCalls: session.requestCount,
    creditCost: 0,
    wallTimeMs: durationMs,
    success: finalQuality.success === true,
    hitMaxTurns: finalQuality.hitMaxTurns ?? false,
    loopDetected: finalQuality.loopDetected ?? false,
    escalated: finalQuality.escalated ?? false,
    responseEmpty: finalQuality.responseEmpty ?? false,
  }).catch((err) => {
    console.warn('[BillingSession] Failed to record main-chat cost metric:', err?.message ?? err)
  })

  try {
    const result = await billingService.consumeUsage({
      workspaceId: session.workspaceId,
      projectId: session.projectId,
      memberId: session.userId,
      actionType: 'chat_message',
      rawUsd,
      billedUsd,
      actionMetadata: {
        inputTokens: session.inputTokens,
        cachedInputTokens: session.cachedInputTokens,
        cacheWriteTokens: session.cacheWriteTokens,
        outputTokens: session.outputTokens,
        totalTokens,
        model: session.model,
        billingModel,
        rawUsd,
        requestCount: session.requestCount,
        durationMs,
      },
    })

    if (result.success) {
      console.log(
        `[BillingSession] Charged $${billedUsd.toFixed(4)} (raw $${rawUsd.toFixed(4)}) — ${session.inputTokens} in, ${session.cacheWriteTokens} cache-write, ${session.cachedInputTokens} cache-read, ${session.outputTokens} out (${totalTokens} total across ${session.requestCount} requests, model: ${billingModel}) — remaining included: $${result.remainingIncludedUsd?.toFixed(4)}`
      )
    } else {
      console.warn(`[BillingSession] Could not charge usage: ${result.error}`)
    }
  } catch (err) {
    console.error(`[BillingSession] Failed to charge usage for project ${projectId}:`, err)
  }

  return { billedUsd, rawUsd, totalTokens }
}
