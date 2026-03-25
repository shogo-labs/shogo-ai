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
