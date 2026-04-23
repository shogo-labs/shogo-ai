// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Voice / telephony cost helpers.
 *
 * Thin wrappers around the rate card in `credit-plans.ts`. Keeps the
 * rounding logic (`Math.ceil(seconds / 60)`) in one place so webhooks,
 * pre-flight checks, and monthly rebillers all charge consistently.
 */

import { prisma } from './prisma'
import {
  VOICE_RATES,
  PLAN_VOICE_RATE_OVERRIDES,
  type VoiceRateKey,
  type PlanId,
} from '../config/credit-plans'

export type VoiceDirection = 'inbound' | 'outbound'

/**
 * Resolve the effective credit rate for a given `(planId, key)`. Plan
 * overrides win over the flat `VOICE_RATES`; an unknown plan falls back
 * to the flat rate.
 */
export function resolveVoiceRate(
  planId: string | null | undefined,
  key: VoiceRateKey,
): number {
  if (planId) {
    const familyId = planId.split('_')[0] as PlanId
    const override = PLAN_VOICE_RATE_OVERRIDES[familyId]?.[key]
    if (typeof override === 'number') return override
  }
  return VOICE_RATES[key]
}

/**
 * Calculate the credit cost of a voice minute charge. `durationSeconds`
 * is rounded UP to the nearest whole minute — 0s bills as 1min (EL
 * always connects), 61s bills as 2min, 120s as 2min, 121s as 3min.
 */
export function calculateVoiceMinuteCost(
  planId: string | null | undefined,
  direction: VoiceDirection,
  durationSeconds: number,
): { billedMinutes: number; creditCost: number; creditsPerMinute: number } {
  const rateKey: VoiceRateKey =
    direction === 'inbound' ? 'minutesInbound' : 'minutesOutbound'
  const creditsPerMinute = resolveVoiceRate(planId, rateKey)
  const seconds = Math.max(0, Math.floor(durationSeconds))
  const billedMinutes = Math.max(1, Math.ceil(seconds / 60))
  const creditCost = billedMinutes * creditsPerMinute
  return { billedMinutes, creditCost, creditsPerMinute }
}

/**
 * Look up the active plan id for a workspace. Returns `'free'` when
 * the workspace has no active subscription row. Shared across voice
 * rate resolution, pre-flight checks, and tests.
 */
export async function resolvePlanIdForWorkspace(
  workspaceId: string,
): Promise<string> {
  try {
    const sub = await prisma.subscription.findFirst({
      where: {
        workspaceId,
        status: { in: ['active', 'trialing'] },
      },
      select: { planId: true },
    })
    return sub?.planId ?? 'free'
  } catch {
    return 'free'
  }
}

/**
 * Current combined daily + monthly credit balance for a workspace.
 * Used by voice pre-flight checks before incurring outbound / number
 * charges. Returns 0 when no ledger row exists yet (new workspace).
 *
 * In local mode (`SHOGO_LOCAL_MODE=true`) returns `Infinity` so
 * self-hosted installs bypass pre-flight checks — matches the rest of
 * `billing.service` which short-circuits on local mode. Real usage
 * events are still recorded for observability.
 *
 * Note: this reads the ledger snapshot; it does NOT apply lazy daily/
 * monthly resets. That's fine — the actual `consumeCredits` call
 * handles resets transactionally. Pre-flight is best-effort.
 */
export async function getCreditBalance(workspaceId: string): Promise<number> {
  if (process.env.SHOGO_LOCAL_MODE === 'true') return Number.POSITIVE_INFINITY
  try {
    const ledger = await prisma.creditLedger.findUnique({
      where: { workspaceId },
      select: { dailyCredits: true, monthlyCredits: true },
    })
    if (!ledger) return 0
    return (ledger.dailyCredits ?? 0) + (ledger.monthlyCredits ?? 0)
  } catch {
    return 0
  }
}
