// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Voice call metering helper.
 *
 * Shared by the ElevenLabs `post_call_transcription` webhook and the
 * Twilio `statusCallback` webhook so both paths dedupe against the
 * same `VoiceCallMeter` row and result in exactly one `UsageEvent` +
 * credit debit per call.
 *
 * Idempotency: keyed by `(conversationId, callSid)` with unique
 * constraints on both columns. The first webhook to arrive creates or
 * finds the row; the second fills in whichever id it had and, if
 * `usageEventId` is still null, debits credits. Once `usageEventId`
 * is set, subsequent webhooks are a strict no-op.
 */

import { prisma } from './prisma'
import {
  calculateVoiceMinuteCost,
  resolvePlanIdForWorkspace,
  type VoiceDirection,
} from './voice-cost'
import { consumeCredits } from '../services/billing.service'

export interface RecordCallParams {
  projectId: string
  workspaceId: string
  direction: VoiceDirection
  durationSeconds: number
  conversationId?: string
  callSid?: string
  startedAt?: Date
  endedAt?: Date
  fromNumber?: string
  toNumber?: string
  agentId?: string
  /**
   * Member id to attribute the UsageEvent to. Defaults to the literal
   * string 'voice-webhook' for provider-driven webhooks where no
   * session user exists — matches how the billing service already
   * treats system writers.
   */
  memberId?: string
  /**
   * Post-call transcript from ElevenLabs. When present it's persisted
   * onto the VoiceCallMeter row so the UI can render recent calls with
   * an expandable transcript. Provider schema — typically an array of
   * `{ role, message, time_in_call_secs }` objects.
   */
  transcript?: unknown
  /**
   * Optional single-sentence summary from EL's call analysis.
   */
  transcriptSummary?: string
}

export interface RecordCallResult {
  meterId: string
  usageEventRecorded: boolean
  creditCost: number
  billedMinutes: number
  creditsPerMinute: number
  alreadyBilled: boolean
  actionType: 'voice_minutes_inbound' | 'voice_minutes_outbound'
}

/**
 * Upsert a VoiceCallMeter row for a completed call and — if not yet
 * billed — debit the right number of credits via billing.service.
 *
 * Returns `{ alreadyBilled: true }` for duplicate webhooks.
 */
export async function recordCallUsage(
  params: RecordCallParams,
): Promise<RecordCallResult> {
  if (!params.conversationId && !params.callSid) {
    throw new Error('recordCallUsage: conversationId or callSid is required')
  }

  const actionType: RecordCallResult['actionType'] =
    params.direction === 'inbound'
      ? 'voice_minutes_inbound'
      : 'voice_minutes_outbound'

  const planId = await resolvePlanIdForWorkspace(params.workspaceId)
  const { billedMinutes, creditCost, creditsPerMinute } =
    calculateVoiceMinuteCost(planId, params.direction, params.durationSeconds)

  // 1. Upsert by whichever unique key we have. We prefer conversationId
  //    because it's EL-assigned and survives Twilio retries; fall back
  //    to callSid when only Twilio has reported.
  const existing = await prisma.voiceCallMeter.findFirst({
    where: {
      OR: [
        ...(params.conversationId
          ? [{ conversationId: params.conversationId }]
          : []),
        ...(params.callSid ? [{ callSid: params.callSid }] : []),
      ],
    },
  })

  let meterId: string
  let alreadyBilled = false

  // Transcript-only updates are always allowed — even for an
  // already-billed row — so late-arriving post-call webhooks can
  // backfill the transcript without re-debiting credits.
  const transcriptPatch: Record<string, unknown> = {}
  if (params.transcript !== undefined) {
    transcriptPatch.transcript = params.transcript as any
  }
  if (params.transcriptSummary !== undefined) {
    transcriptPatch.transcriptSummary = params.transcriptSummary
  }

  if (existing) {
    meterId = existing.id
    alreadyBilled = !!existing.usageEventId
    await prisma.voiceCallMeter.update({
      where: { id: existing.id },
      data: {
        // Backfill whichever id wasn't present on the first webhook.
        ...(params.conversationId && !existing.conversationId
          ? { conversationId: params.conversationId }
          : {}),
        ...(params.callSid && !existing.callSid
          ? { callSid: params.callSid }
          : {}),
        durationSeconds: Math.max(
          existing.durationSeconds,
          Math.floor(params.durationSeconds),
        ),
        billedMinutes: alreadyBilled ? existing.billedMinutes : billedMinutes,
        ...(params.startedAt && !existing.startedAt
          ? { startedAt: params.startedAt }
          : {}),
        ...(params.endedAt ? { endedAt: params.endedAt } : {}),
        ...transcriptPatch,
      },
    })
  } else {
    const created = await prisma.voiceCallMeter.create({
      data: {
        projectId: params.projectId,
        workspaceId: params.workspaceId,
        conversationId: params.conversationId ?? null,
        callSid: params.callSid ?? null,
        direction: params.direction,
        durationSeconds: Math.floor(params.durationSeconds),
        billedMinutes,
        startedAt: params.startedAt ?? null,
        endedAt: params.endedAt ?? null,
        ...transcriptPatch,
      },
    })
    meterId = created.id
  }

  if (alreadyBilled) {
    return {
      meterId,
      usageEventRecorded: false,
      creditCost,
      billedMinutes,
      creditsPerMinute,
      alreadyBilled: true,
      actionType,
    }
  }

  // 2. Debit credits (single UsageEvent). Set usageEventId on the
  // meter afterward — first-writer-wins on the unique constraint.
  const memberId = params.memberId ?? 'voice-webhook'
  const debit = await consumeCredits(
    params.workspaceId,
    params.projectId,
    memberId,
    actionType,
    creditCost,
    {
      conversationId: params.conversationId,
      callSid: params.callSid,
      direction: params.direction,
      fromNumber: params.fromNumber,
      toNumber: params.toNumber,
      durationSeconds: params.durationSeconds,
      billedMinutes,
      creditsPerMinute,
      agentId: params.agentId,
      projectId: params.projectId,
    },
  )

  if (!debit.success) {
    // Leave usageEventId null so a later reconciler can retry. Surface
    // the error to the caller so webhooks can 500 (provider will retry).
    return {
      meterId,
      usageEventRecorded: false,
      creditCost,
      billedMinutes,
      creditsPerMinute,
      alreadyBilled: false,
      actionType,
    }
  }

  // Link the usage event to the meter. We look up the most recent
  // UsageEvent for this workspace+action — `consumeCredits` doesn't
  // return the event id today. We scope tightly on (workspaceId,
  // actionType, metadata.conversationId) to avoid mis-attribution.
  const latest = await prisma.usageEvent.findFirst({
    where: {
      workspaceId: params.workspaceId,
      actionType,
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, actionMetadata: true },
  })
  if (latest) {
    try {
      await prisma.voiceCallMeter.update({
        where: { id: meterId },
        data: { usageEventId: latest.id },
      })
    } catch (err) {
      // Another webhook raced us — harmless, just means dedupe worked.
    }
  }

  return {
    meterId,
    usageEventRecorded: true,
    creditCost,
    billedMinutes,
    creditsPerMinute,
    alreadyBilled: false,
    actionType,
  }
}

/**
 * Verify an ElevenLabs webhook signature per
 *   https://elevenlabs.io/docs/conversational-ai/workflows/post-call-webhooks
 *
 * EL signs `timestamp.body` with HMAC-SHA256 using the account's
 * webhook secret and sends it as:
 *
 *   ElevenLabs-Signature: t=<unix-seconds>,v0=<hex>
 *
 * We accept a ±5 minute clock skew. Tests (and callers with custom
 * headers) can override via `maxSkewSeconds`.
 */
export function verifyElevenLabsSignature(params: {
  secret: string
  signatureHeader: string | null
  rawBody: string
  nowSeconds?: number
  maxSkewSeconds?: number
}): boolean {
  if (!params.signatureHeader) return false
  const { createHmac, timingSafeEqual } = require('node:crypto') as typeof import('node:crypto')
  const parts = params.signatureHeader.split(',').map((p) => p.trim())
  let t: string | null = null
  let v0: string | null = null
  for (const p of parts) {
    if (p.startsWith('t=')) t = p.slice(2)
    else if (p.startsWith('v0=')) v0 = p.slice(3)
  }
  if (!t || !v0) return false
  const ts = Number(t)
  if (!Number.isFinite(ts)) return false

  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000)
  const skew = params.maxSkewSeconds ?? 300
  if (Math.abs(now - ts) > skew) return false

  const expected = createHmac('sha256', params.secret)
    .update(`${t}.${params.rawBody}`)
    .digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(v0)
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}
