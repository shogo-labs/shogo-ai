// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Central Usage Plan Configuration
 *
 * Single source of truth for USD usage allocations per plan (Cursor-style).
 * Used by: billing.service.ts (backend allocation), webhook (monthly refills)
 *
 * All values are in USD. LLM / voice / image usage is metered at the raw
 * provider cost plus `MARKUP_MULTIPLIER` (see `usage-cost.ts`).
 */

/** Daily included USD that refills every day on the free tier. */
export const DAILY_INCLUDED_USD = 0.50

/** Monthly cap on dispensed daily USD (free tier). */
export const MONTHLY_DAILY_CAP_USD = 3.00

/**
 * Base plan monthly included USD.
 * Legacy tier suffixes (e.g. `pro_200`, `business_1200`) encode a credit
 * count; we convert to USD at $0.10/credit for parity with prior pricing.
 */
export const PLAN_INCLUDED_USD = {
  free: 0,
  basic: 5,
  pro: 20,
  business: 20,
  enterprise: 2000,
} as const

export type PlanId = keyof typeof PLAN_INCLUDED_USD

/**
 * Parse a planId (e.g. "pro", "pro_800", "business_1200") and return the
 * monthly included USD amount. Tier suffixes use legacy credit numbers
 * converted at $0.10/credit.
 */
export function getMonthlyIncludedForPlan(planId: string): number {
  const parts = planId.split('_')
  const tierCredits = parts.length > 1 ? parseInt(parts[1], 10) : NaN
  if (!isNaN(tierCredits)) return tierCredits * 0.10
  return PLAN_INCLUDED_USD[parts[0] as PlanId] ?? PLAN_INCLUDED_USD.free
}

/**
 * Voice / telephony raw provider rates (Mode B only). All values are USD.
 * The workspace is charged these rates times `MARKUP_MULTIPLIER` on top
 * of whatever daily/monthly included pool they have.
 *
 * Per-minute charges are rounded up to the nearest whole minute
 * (`Math.ceil(durationSeconds / 60)`); monthly number fees are debited
 * by `voice-monthly-rebill.ts`.
 *
 * Mode A (self-hosted BYO keys) is not metered — the customer pays
 * Twilio and ElevenLabs directly.
 */
export const VOICE_RAW_USD = {
  minutesInbound: 0.20,
  minutesOutbound: 0.24,
  numberSetup: 2.00,
  numberMonthly: 3.00,
} as const

export type VoiceRateKey = keyof typeof VOICE_RAW_USD

/**
 * Optional per-plan overrides on raw USD voice rates. Left empty by default
 * — the flat VOICE_RAW_USD applies to every plan. Values are sparse: omit
 * any key to inherit from VOICE_RAW_USD.
 */
export const PLAN_VOICE_RATE_OVERRIDES: Partial<
  Record<PlanId, Partial<typeof VOICE_RAW_USD>>
> = {}
