// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Voice / telephony cost helpers (USD).
 *
 * Thin wrappers around the rate card in `usage-plans.ts`. Keeps the
 * rounding logic (`Math.ceil(seconds / 60)`) in one place so webhooks,
 * pre-flight checks, and monthly rebillers all charge consistently.
 */

import { prisma } from './prisma'
import {
  VOICE_RAW_USD,
  PLAN_VOICE_RATE_OVERRIDES,
  type VoiceRateKey,
  type PlanId,
} from '../config/usage-plans'
import { MARKUP_MULTIPLIER } from './usage-cost'

export type VoiceDirection = 'inbound' | 'outbound'

/**
 * Resolve the effective raw USD rate for a given `(planId, key)`. Plan
 * overrides win over the flat `VOICE_RAW_USD`; an unknown plan falls
 * back to the flat rate.
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
  return VOICE_RAW_USD[key]
}

export interface VoiceMinuteCostResult {
  billedMinutes: number
  rawUsd: number
  billedUsd: number
  rawUsdPerMinute: number
  billedUsdPerMinute: number
}

/**
 * Calculate the USD cost of a voice minute charge. `durationSeconds`
 * is rounded UP to the nearest whole minute — 0s bills as 1min (EL
 * always connects), 61s bills as 2min, 120s as 2min, 121s as 3min.
 */
export function calculateVoiceMinuteCost(
  planId: string | null | undefined,
  direction: VoiceDirection,
  durationSeconds: number,
): VoiceMinuteCostResult {
  const rateKey: VoiceRateKey =
    direction === 'inbound' ? 'minutesInbound' : 'minutesOutbound'
  const rawUsdPerMinute = resolveVoiceRate(planId, rateKey)
  const billedUsdPerMinute = rawUsdPerMinute * MARKUP_MULTIPLIER
  const seconds = Math.max(0, Math.floor(durationSeconds))
  const billedMinutes = Math.max(1, Math.ceil(seconds / 60))
  const rawUsd = billedMinutes * rawUsdPerMinute
  const billedUsd = billedMinutes * billedUsdPerMinute
  return { billedMinutes, rawUsd, billedUsd, rawUsdPerMinute, billedUsdPerMinute }
}

/**
 * Calculate the USD cost of a one-off or recurring phone number charge.
 */
export function calculateVoiceNumberCost(
  planId: string | null | undefined,
  kind: 'setup' | 'monthly',
): { rawUsd: number; billedUsd: number } {
  const key: VoiceRateKey = kind === 'setup' ? 'numberSetup' : 'numberMonthly'
  const rawUsd = resolveVoiceRate(planId, key)
  return { rawUsd, billedUsd: rawUsd * MARKUP_MULTIPLIER }
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
 * Current combined daily + monthly USD balance for a workspace.
 * Used by voice pre-flight checks before incurring outbound / number
 * charges. Returns 0 when no wallet row exists yet (new workspace).
 *
 * In local mode (`SHOGO_LOCAL_MODE=true`) returns `Infinity` so
 * self-hosted installs bypass pre-flight checks — matches the rest of
 * `billing.service` which short-circuits on local mode. Real usage
 * events are still recorded for observability.
 *
 * Note: this reads the wallet snapshot; it does NOT apply lazy daily/
 * monthly resets. That's fine — the actual `consumeUsage` call handles
 * resets transactionally. Pre-flight is best-effort.
 */
export async function getUsdBalance(workspaceId: string): Promise<number> {
  if (process.env.SHOGO_LOCAL_MODE === 'true') return Number.POSITIVE_INFINITY
  try {
    const wallet = await prisma.usageWallet.findUnique({
      where: { workspaceId },
      select: { dailyIncludedUsd: true, monthlyIncludedUsd: true },
    })
    if (!wallet) return 0
    return (wallet.dailyIncludedUsd ?? 0) + (wallet.monthlyIncludedUsd ?? 0)
  } catch {
    return 0
  }
}
