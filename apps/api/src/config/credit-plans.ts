// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Central Credit Plan Configuration
 *
 * Single source of truth for credit allocations per plan.
 * Used by: billing.service.ts (backend allocation), webhook (credit allocation)
 *
 * 1 credit = $0.10 of LLM cost. Plan credits are doubled from legacy values
 * (same dollar prices). Plan ID suffixes still use legacy numbers; tiered
 * amounts are doubled via getMonthlyCreditsForPlan().
 */

export const DAILY_CREDITS = 5

export const MONTHLY_DAILY_CAP = 30

export const PLAN_CREDITS = {
  free: 0,
  basic: 50,
  pro: 200,
  business: 200,
  enterprise: 20000,
} as const

/**
 * Parse a planId (e.g. "pro", "pro_800", "business_1200") and return the
 * monthly credit allocation. Tiered plan suffixes use legacy credit numbers
 * and are doubled to match the new credit value ($0.10/credit).
 */
export function getMonthlyCreditsForPlan(planId: string): number {
  const parts = planId.split('_')
  const tierCredits = parts.length > 1 ? parseInt(parts[1], 10) : NaN
  if (!isNaN(tierCredits)) return tierCredits * 2
  return PLAN_CREDITS[parts[0] as keyof typeof PLAN_CREDITS] ?? PLAN_CREDITS.free
}

export type PlanId = keyof typeof PLAN_CREDITS

/**
 * Voice / telephony rate card (Mode B only). Rates are credits, which
 * are billed at $0.10/credit today. Per-minute charges are rounded up
 * to the nearest whole minute (`Math.ceil(durationSeconds / 60)`).
 *
 * These cover Shogo's own Twilio + ElevenLabs costs plus margin. Mode
 * A (self-hosted BYO keys) is not metered — the customer pays Twilio
 * and ElevenLabs directly.
 */
export const VOICE_RATES = {
  minutesInbound: 10,
  minutesOutbound: 12,
  numberSetup: 100,
  numberMonthly: 150,
} as const

export type VoiceRateKey = keyof typeof VOICE_RATES

/**
 * Optional per-plan overrides. Left empty by default — the flat
 * VOICE_RATES apply to every plan until product wants to tier them.
 * Values are sparse: omit any key to inherit from VOICE_RATES.
 */
export const PLAN_VOICE_RATE_OVERRIDES: Partial<
  Record<PlanId, Partial<typeof VOICE_RATES>>
> = {}
