// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Central Usage Plan Configuration
 *
 * Single source of truth for USD usage allocations per plan. The plan ladder
 * is flat and per-seat, modeled on Cursor.com:
 *
 *   - Basic    $8/mo   single user, $5 of usage included
 *   - Pro      $20/seat/mo, $20 of usage included per seat
 *   - Business $40/seat/mo, $40 of usage included per seat
 *
 * Used by: billing.service.ts (backend allocation), webhook (monthly refills).
 *
 * All values are in USD. LLM / voice / image usage is metered at the raw
 * provider cost plus `MARKUP_MULTIPLIER` (see `usage-cost.ts`).
 */

/** Daily included USD that refills every day on every plan. */
export const DAILY_INCLUDED_USD = 0.50

/** Monthly cap on dispensed daily USD (free tier). */
export const MONTHLY_DAILY_CAP_USD = 3.00

/**
 * Included USD per *seat* per month. Basic is single-user (always 1 seat).
 * Free is 0 (only the daily allowance applies).
 */
export const SEAT_INCLUDED_USD = {
  free: 0,
  basic: 5,
  pro: 20,
  business: 40,
  enterprise: 2000,
} as const

export type PlanId = keyof typeof SEAT_INCLUDED_USD

/**
 * Compute the monthly included USD for a (plan, seats) tuple.
 *
 * Backwards-compat: legacy tier ids (e.g. `pro_200`, `business_1200`) encode
 * a credit count and are translated at $0.10/credit. Used only by the
 * migration script and by webhook handlers that may still see legacy ids on
 * grandfathered subscriptions.
 */
export function getMonthlyIncludedForPlan(planId: string, seats: number = 1): number {
  const safeSeats = Math.max(1, Math.floor(seats || 1))
  if (planId in SEAT_INCLUDED_USD) {
    const base = SEAT_INCLUDED_USD[planId as PlanId]
    // Basic and free are single-user, ignore seats.
    if (planId === 'free' || planId === 'basic') return base
    return base * safeSeats
  }

  // Legacy tier id support: `pro_200` -> $20 included, `business_1200` -> $120.
  const m = planId.match(/^(basic|pro|business)_(\d+)$/)
  if (m) return parseInt(m[2], 10) * 0.10

  return 0
}

/** @deprecated Use `SEAT_INCLUDED_USD` and `getMonthlyIncludedForPlan(plan, seats)`. */
export const PLAN_INCLUDED_USD = {
  free: 0,
  basic: 5,
  pro: 20,
  business: 20,
  enterprise: 2000,
} as const

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
