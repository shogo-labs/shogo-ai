import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Format credit numbers consistently: whole numbers stay integer, decimals get 2 dp */
export function formatCredits(credits: number): string {
  return credits % 1 === 0 ? String(credits) : credits.toFixed(2)
}

/**
 * Parse a planId (e.g. "pro", "pro_200", "business_1200") and return the monthly credit allocation.
 * Must match apps/api/src/config/credit-plans.ts getMonthlyCreditsForPlan().
 */
function getMonthlyCreditsForPlan(planId: string, planCredits: Record<string, number>): number {
  const parts = planId.split('_')
  const tierCredits = parts.length > 1 ? parseInt(parts[1], 10) : NaN
  if (!isNaN(tierCredits)) return tierCredits
  return planCredits[parts[0]] ?? planCredits.free
}

/** Compute total credit allocation for a plan (monthly + daily) */
export function getTotalCreditsForPlan(planId: string | undefined, planCredits: Record<string, number>, dailyCredits: number): number {
  const base = planId ? getMonthlyCreditsForPlan(planId, planCredits) : planCredits.free
  return base + dailyCredits
}
