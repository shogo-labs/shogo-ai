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

import { calculateCreditCost, proxyModelToBillingModel } from './credit-cost'
import * as billingService from '../services/billing.service'

const SESSION_TIMEOUT_MS = 10 * 60 * 1000 // 10 min safety net

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

/**
 * Close a billing session and charge credits based on total accumulated tokens.
 * Returns the credit cost charged (0 if no tokens or session not found).
 */
export async function closeSession(
  projectId: string,
): Promise<{ creditCost: number; totalTokens: number }> {
  const session = sessions.get(projectId)
  sessions.delete(projectId)

  if (!session) {
    return { creditCost: 0, totalTokens: 0 }
  }

  const totalTokens = session.inputTokens + session.cachedInputTokens + session.cacheWriteTokens + session.outputTokens
  if (totalTokens === 0) {
    return { creditCost: 0, totalTokens: 0 }
  }

  const billingModel = proxyModelToBillingModel(session.model)
  const { credits: creditCost, dollarCost } = calculateCreditCost(
    session.inputTokens, session.outputTokens, billingModel,
    session.cachedInputTokens, session.cacheWriteTokens,
  )
  const durationMs = Date.now() - session.openedAt

  try {
    const result = await billingService.consumeCredits(
      session.workspaceId,
      session.projectId,
      session.userId,
      'chat_message',
      creditCost,
      {
        inputTokens: session.inputTokens,
        cachedInputTokens: session.cachedInputTokens,
        cacheWriteTokens: session.cacheWriteTokens,
        outputTokens: session.outputTokens,
        totalTokens,
        model: session.model,
        billingModel,
        dollarCost,
        requestCount: session.requestCount,
        durationMs,
      }
    )

    if (result.success) {
      console.log(
        `[BillingSession] Charged ${creditCost} credits ($${dollarCost.toFixed(4)}) — ${session.inputTokens} in, ${session.cacheWriteTokens} cache-write, ${session.cachedInputTokens} cache-read, ${session.outputTokens} out (${totalTokens} total across ${session.requestCount} requests, model: ${billingModel}) — remaining: ${result.remainingCredits}`
      )
    } else {
      console.warn(`[BillingSession] Could not charge credits: ${result.error}`)
    }
  } catch (err) {
    console.error(`[BillingSession] Failed to charge credits for project ${projectId}:`, err)
  }

  return { creditCost, totalTokens }
}
