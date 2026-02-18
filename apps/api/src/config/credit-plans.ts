/**
 * Central Credit Plan Configuration
 *
 * Single source of truth for credit allocations per plan.
 * Used by: billing.service.ts (backend allocation), webhook (credit allocation)
 *
 * Base tier = default when planId has no suffix (e.g. "pro" = 100 credits)
 * Tiered = planId with suffix (e.g. "pro_800" = 800 credits)
 */

export const DAILY_CREDITS = 5

export const PLAN_CREDITS = {
  free: 50,
  pro: 100,       // base tier ($25/month)
  business: 100,  // base tier ($50/month)
  enterprise: 10000,
} as const

/**
 * Parse a planId (e.g. "pro", "pro_800", "business_1200") and return the monthly credit allocation.
 */
export function getMonthlyCreditsForPlan(planId: string): number {
  const parts = planId.split('_')
  const tierCredits = parts.length > 1 ? parseInt(parts[1], 10) : NaN
  if (!isNaN(tierCredits)) return tierCredits
  return PLAN_CREDITS[parts[0] as keyof typeof PLAN_CREDITS] ?? PLAN_CREDITS.free
}

