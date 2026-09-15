// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { ProxyTokenPayload } from './ai-proxy-token'
import { prisma } from './prisma'
import { MARKUP_MULTIPLIER } from './usage-cost'
import { getMergedModelEntrySync } from '../services/model-registry.service'
import { calculateLiveSessionCost, getModelEntry } from '@shogo/model-catalog'
import { recordUsage } from '../routes/ai-proxy'
import * as billingService from '../services/billing.service'

export interface LiveSessionMeterContext {
  sessionId: string
  tokenPayload: ProxyTokenPayload
  model: string
  backendModel?: string
  transport: 'websocket' | 'webrtc' | 'sideband'
  responseIds: Set<string>
}

function billingProjectId(payload: ProxyTokenPayload): string | null {
  return payload.projectId === 'api-key' || payload.projectId === 'system'
    ? null
    : (payload.projectId || null)
}

function billingMemberId(payload: ProxyTokenPayload): string {
  return payload.userId || 'system'
}

function liveCost(model: string, seconds: number): number {
  const entry = getMergedModelEntrySync(model) ?? getModelEntry(model)
  if (!entry?.usdPerMinute || !Number.isFinite(seconds) || seconds <= 0) return 0
  return (seconds / 60) * entry.usdPerMinute
}

export async function ensureLiveSessionMeter(
  context: LiveSessionMeterContext,
  startedAt = new Date(),
): Promise<void> {
  const payload = context.tokenPayload
  await (prisma as any).liveSessionMeter.upsert({
    where: { sessionId: context.sessionId },
    create: {
      sessionId: context.sessionId,
      workspaceId: payload.workspaceId,
      projectId: billingProjectId(payload),
      memberId: billingMemberId(payload),
      model: context.model,
      backendModel: context.backendModel ?? null,
      transport: context.transport,
      startedAt,
    },
    update: {
      backendModel: context.backendModel ?? undefined,
      transport: context.transport,
      startedAt,
    },
  })
}

function parseEvent(raw: unknown): Record<string, any> | null {
  try {
    const text =
      typeof raw === 'string'
        ? raw
        : raw instanceof Uint8Array
          ? new TextDecoder().decode(raw)
          : raw && typeof raw === 'object' && 'data' in raw
            ? String((raw as { data: unknown }).data)
            : null
    if (!text) return null
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Observe an upstream event. Duration is cumulative, so each update replaces
 * the stored value rather than adding to it.
 */
export async function observeLiveEvent(
  context: LiveSessionMeterContext,
  raw: unknown,
): Promise<void> {
  const event = parseEvent(raw)
  if (!event) return

  if (event.type === 'session.started' && typeof event.session?.id === 'string') {
    if (event.session.id !== context.sessionId) {
      context.sessionId = event.session.id
    }
    await ensureLiveSessionMeter(context)
  }

  const seconds =
    typeof event.usage?.seconds === 'number'
      ? event.usage.seconds
      : typeof event.session?.usage?.seconds === 'number'
        ? event.session.usage.seconds
        : null
  if (seconds !== null && Number.isFinite(seconds)) {
    await (prisma as any).liveSessionMeter.updateMany({
      where: { sessionId: context.sessionId, billed: false },
      data: { seconds: Math.max(0, seconds) },
    })
  }

  // Responses delegation wraps Responses events in response.event. Bill the
  // backend token usage through the same path as normal Responses calls.
  if (event.type === 'response.event') {
    const nested = event.event
    const response = nested?.response
    const responseId = response?.id ?? nested?.response_id
    const usage = response?.usage
    if (nested?.type === 'response.completed' && usage && (!responseId || !context.responseIds.has(responseId))) {
      if (responseId) context.responseIds.add(responseId)
      const totalInput = Number(usage.input_tokens ?? 0)
      const cachedInput = Number(usage.input_tokens_details?.cached_tokens ?? 0)
      const output = Number(usage.output_tokens ?? 0)
      if (context.backendModel && (totalInput || cachedInput || output)) {
        void recordUsage(
          context.tokenPayload,
          context.backendModel,
          totalInput - cachedInput,
          output,
          cachedInput,
          0,
        )
      }
    }
  }
}

/** Finalize and charge a session exactly once. */
export async function finalizeLiveSessionMeter(
  context: LiveSessionMeterContext,
  options: { confirmed: boolean; seconds?: number } = { confirmed: true },
): Promise<void> {
  const row = await (prisma as any).liveSessionMeter.findUnique({
    where: { sessionId: context.sessionId },
  }) as { billed: boolean; seconds: number; model: string; workspaceId: string; projectId: string | null; memberId: string } | null
  if (!row || row.billed) return

  const seconds = Math.max(0, options.seconds ?? row.seconds ?? 0)
  const rawUsd = liveCost(row.model, seconds) || calculateLiveSessionCost(row.model, seconds)
  const billedUsd = rawUsd * MARKUP_MULTIPLIER

  // Claim before charging to make simultaneous close/error paths idempotent.
  const claimed = await (prisma as any).liveSessionMeter.updateMany({
    where: { sessionId: context.sessionId, billed: false },
    data: {
      billed: true,
      seconds,
      rawUsd,
      billedUsd,
      usageConfirmed: options.confirmed,
      endedAt: new Date(),
    },
  })
  if (!claimed.count) return

  try {
    if (billedUsd > 0) {
      const debit = await billingService.consumeUsage({
        workspaceId: row.workspaceId,
        projectId: row.projectId,
        memberId: row.memberId,
        actionType: 'ai_live_session_minutes',
        rawUsd,
        billedUsd,
        actionMetadata: {
          sessionId: context.sessionId,
          model: row.model,
          transport: context.transport,
          seconds,
          usageConfirmed: options.confirmed,
        },
      })
      if (!debit.success) {
        // Leave the row retryable, matching voice-meter's webhook behavior.
        await (prisma as any).liveSessionMeter.updateMany({
          where: { sessionId: context.sessionId },
          data: { billed: false },
        })
      }
    }
  } catch (error) {
    await (prisma as any).liveSessionMeter.updateMany({
      where: { sessionId: context.sessionId },
      data: { billed: false },
    }).catch(() => {})
    throw error
  }
}
