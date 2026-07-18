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
 * Keyed by `(projectId, chatSessionId)` so concurrent chat sessions on the
 * same project (multiple chat panels, multiple workspace members) bill
 * independently. When no chatSessionId is supplied (legacy callers, first
 * turn of a brand-new chat session before the id is known), the key falls
 * back to `projectId` alone for backwards compatibility.
 *
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
  chatSessionId: string | null
  workspaceId: string
  userId: string
  model: string
  inputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  outputTokens: number
  requestCount: number
  imageRawUsd: number
  imageBilledUsd: number
  imageGenerationCount: number
  imageModels: string[]
  quality: BillingSessionQualitySignals
  openedAt: number
  lastActivityAt: number
}

const sessions = new Map<string, BillingSession>()

/**
 * Compose the in-memory map key from project + chat session. Falls back to
 * projectId alone when no chatSessionId is available so legacy callers
 * (and the first turn of a brand-new chat) continue to bill correctly.
 */
function sessionKey(projectId: string, chatSessionId?: string | null): string {
  return chatSessionId ? `${projectId}:${chatSessionId}` : projectId
}

// Periodic cleanup of orphaned sessions (crash recovery)
setInterval(() => {
  const now = Date.now()
  for (const [key, session] of sessions) {
    if (now - session.lastActivityAt > SESSION_TIMEOUT_MS) {
      console.warn(`[BillingSession] Flushing orphaned session for ${key} (${session.requestCount} requests, ${session.inputTokens + session.outputTokens} tokens, ${session.imageGenerationCount} images $${session.imageBilledUsd.toFixed(4)})`)
      closeSession(session.projectId, { chatSessionId: session.chatSessionId ?? undefined }).catch(err =>
        console.error(`[BillingSession] Failed to flush orphaned session ${key}:`, err)
      )
    }
  }
}, 60_000)

/**
 * Open a billing session for a (project, chatSession) tuple. Subsequent AI
 * proxy calls for the same tuple will accumulate tokens here instead of
 * charging per-call.
 *
 * `chatSessionId` is optional for backwards compatibility — when omitted
 * the session is keyed by `projectId` alone and concurrent turns on the
 * same project will collide as before. Always pass it from new code paths.
 */
export function openSession(
  projectId: string,
  workspaceId: string,
  userId: string,
  chatSessionId?: string | null,
): void {
  const key = sessionKey(projectId, chatSessionId)

  // If there's an existing session for the same key, flush it first. With
  // a composite key this should be vanishingly rare (real concurrent
  // re-entry of the SAME chat session); elevate to error so we notice in
  // prod if it ever happens.
  const existing = sessions.get(key)
  if (existing) {
    const log = chatSessionId ? console.error : console.warn
    log(`[BillingSession] Overwriting existing session for ${key} (${existing.requestCount} requests buffered)`)
    closeSession(projectId, { chatSessionId: chatSessionId ?? undefined }).catch(() => {})
  }

  sessions.set(key, {
    projectId,
    chatSessionId: chatSessionId ?? null,
    workspaceId,
    userId,
    model: 'sonnet',
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    requestCount: 0,
    imageRawUsd: 0,
    imageBilledUsd: 0,
    imageGenerationCount: 0,
    imageModels: [],
    quality: {},
    openedAt: Date.now(),
    lastActivityAt: Date.now(),
  })
}

/**
 * Check if there's an active billing session for a (project, chatSession)
 * tuple.
 */
export function hasSession(projectId: string, chatSessionId?: string | null): boolean {
  return sessions.has(sessionKey(projectId, chatSessionId))
}

/**
 * Check whether a turn is currently in flight for `projectId` — i.e. a billing
 * session was opened for it and hasn't been closed yet.
 *
 * Used by the AI proxy's per-call usage pre-flight to avoid killing an
 * already-admitted message mid-generation: a chat turn is gated for usage once
 * at turn start (project-chat / workspace-chat), then makes up to
 * AGENT_MAX_ITERATIONS proxied LLM/image calls. Re-running the 402 pre-flight
 * on those intermediate calls would drop the run halfway. If a session is
 * open, the turn already passed the start gate, so we let it finish.
 *
 * Resolution order:
 *   1. `lookupSession` (composite `(projectId, chatSessionId)` key, then the
 *      legacy projectId-only fallback).
 *   2. A scan for any open session belonging to `projectId`. This covers
 *      header-less/sentinel callers where the runtime dropped the
 *      `x-chat-session-id` header (gateway `isRealChatSession === false`), so
 *      the keyed lookups miss even though a turn is genuinely in flight.
 */
export function hasActiveSession(projectId: string, chatSessionId?: string | null): boolean {
  if (lookupSession(projectId, chatSessionId)) return true
  for (const s of sessions.values()) {
    if (s.projectId === projectId) return true
  }
  return false
}

/**
 * Accumulate token usage from an AI proxy call. Returns true if tokens were
 * accumulated against an active session, false if no session exists (caller
 * should charge per-call).
 *
 * Looks up the session via the composite `(projectId, chatSessionId)` key
 * when chatSessionId is supplied, falling back to the legacy projectId-only
 * key if the composite lookup misses (covers calls from older runtimes that
 * don't yet forward the chat-session header).
 */
export function accumulateUsage(
  projectId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number = 0,
  cacheWriteTokens: number = 0,
  chatSessionId?: string | null,
): boolean {
  const session = lookupSession(projectId, chatSessionId)
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
 * Accumulate image-generation USD from an AI proxy image call. Returns true
 * if accumulated against an active session, false if no session exists
 * (caller should charge per-call).
 */
export function accumulateImageUsage(
  projectId: string,
  model: string,
  rawUsd: number,
  billedUsd: number,
  chatSessionId?: string | null,
): boolean {
  const session = lookupSession(projectId, chatSessionId)
  if (!session) return false

  session.imageRawUsd += rawUsd
  session.imageBilledUsd += billedUsd
  session.imageGenerationCount += 1
  if (!session.imageModels.includes(model)) {
    session.imageModels.push(model)
  }
  session.lastActivityAt = Date.now()

  return true
}

export function setQualitySignals(
  projectId: string,
  quality: BillingSessionQualitySignals,
  chatSessionId?: string | null,
): boolean {
  const session = lookupSession(projectId, chatSessionId)
  if (!session) return false
  session.quality = { ...session.quality, ...quality }
  session.lastActivityAt = Date.now()
  return true
}

/**
 * Resolve a session, preferring the composite key when chatSessionId is
 * known. Falls back to the legacy projectId-only key when the composite
 * lookup misses so a runtime that hasn't yet been redeployed (and therefore
 * isn't forwarding the chat-session header) can still accumulate against
 * the legacy-keyed session opened by older callers.
 */
function lookupSession(projectId: string, chatSessionId?: string | null): BillingSession | undefined {
  if (chatSessionId) {
    const composite = sessions.get(sessionKey(projectId, chatSessionId))
    if (composite) return composite
  }
  return sessions.get(projectId)
}

/**
 * Close a billing session and charge USD based on total accumulated tokens.
 * Returns the marked-up USD charged (0 if no tokens or session not found).
 *
 * When `discardPartial: true`, the session is dropped WITHOUT charging.
 * Used when the upstream stream EOF'd before the runtime emitted its
 * terminal `data-turn-complete` marker — we don't want to bill a user
 * for a half-finished turn that the auto-resuming-fetch client will
 * reconnect and finish on a subsequent request.
 */
export async function closeSession(
  projectId: string,
  options: { discardPartial?: boolean; chatSessionId?: string | null } = {},
): Promise<{ billedUsd: number; rawUsd: number; totalTokens: number }> {
  // Prefer the composite key. Fall back to the legacy projectId-only key
  // so callers that opened a session without a chatSessionId (or that
  // can't recover it on close) still drain the right entry.
  let key = sessionKey(projectId, options.chatSessionId)
  let session = sessions.get(key)
  if (!session && options.chatSessionId) {
    key = projectId
    session = sessions.get(key)
  }
  sessions.delete(key)

  if (!session) {
    return { billedUsd: 0, rawUsd: 0, totalTokens: 0 }
  }

  const totalTokens = session.inputTokens + session.cachedInputTokens + session.cacheWriteTokens + session.outputTokens
  if (totalTokens === 0 && session.imageBilledUsd === 0) {
    return { billedUsd: 0, rawUsd: 0, totalTokens: 0 }
  }

  if (options.discardPartial) {
    console.log(
      `[BillingSession] Discarded partial session for ${key} ` +
      `(stream EOF'd before turn-complete) — ${session.inputTokens} in, ${session.outputTokens} out, ` +
      `${session.requestCount} request(s), ${session.imageGenerationCount} image(s) NOT charged.`
    )
    return { billedUsd: 0, rawUsd: 0, totalTokens }
  }

  const billingModel = proxyModelToBillingModel(session.model)
  // Bill on the *real* model id, not the collapsed `billingModel` bucket.
  // `calculateUsageCost` prefers a DB-defined model's own per-token pricing
  // (custom providers, admin-added models like "Hoshi 1.0" / mimo-v2.5) and
  // only falls back to the static family bucket for catalog models. Passing
  // `billingModel` here defeated that lookup and billed every DB model at the
  // `sonnet` bucket (the `getModelBillingModel` default for unknown ids).
  const tokenCost = calculateUsageCost(
    session.inputTokens, session.outputTokens, session.model,
    session.cachedInputTokens, session.cacheWriteTokens,
  )
  const rawUsd = tokenCost.rawUsd + session.imageRawUsd
  const billedUsd = tokenCost.billedUsd + session.imageBilledUsd
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
    // Record the real model id so the analytics recompute path
    // (`serverComputeCreditCost`) honors DB-defined per-token pricing too,
    // keeping cost analytics consistent with the wallet debit above.
    model: session.model,
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
    metadata: session.chatSessionId ? { chatSessionId: session.chatSessionId } : undefined,
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
        tokenRawUsd: tokenCost.rawUsd,
        tokenBilledUsd: tokenCost.billedUsd,
        requestCount: session.requestCount,
        imageGenerationCount: session.imageGenerationCount,
        imageRawUsd: session.imageRawUsd,
        imageBilledUsd: session.imageBilledUsd,
        imageModels: session.imageModels,
        durationMs,
        ...(session.chatSessionId ? { chatSessionId: session.chatSessionId } : {}),
      },
    })

    if (result.success) {
      console.log(
        `[BillingSession] Charged $${billedUsd.toFixed(4)} (raw $${rawUsd.toFixed(4)}) — ${session.inputTokens} in, ${session.cacheWriteTokens} cache-write, ${session.cachedInputTokens} cache-read, ${session.outputTokens} out (${totalTokens} total across ${session.requestCount} requests, model: ${billingModel}), ${session.imageGenerationCount} images $${session.imageBilledUsd.toFixed(4)} — remaining included: $${result.remainingIncludedUsd?.toFixed(4)}`
      )
    } else {
      console.warn(`[BillingSession] Could not charge usage: ${result.error}`)
    }
  } catch (err) {
    console.error(`[BillingSession] Failed to charge usage for ${key}:`, err)
  }

  return { billedUsd, rawUsd, totalTokens }
}
