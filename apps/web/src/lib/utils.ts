import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Format credit numbers consistently: whole numbers stay integer, decimals get 1 dp */
export function formatCredits(credits: number): string {
  return credits % 1 === 0 ? String(credits) : credits.toFixed(1)
}

/** Compute total credit allocation for a plan */
export function getTotalCreditsForPlan(planId: string | undefined, planCredits: Record<string, number>, dailyCredits: number): number {
  const base = planId ? (planCredits[planId] ?? planCredits.free) : planCredits.free
  return base + dailyCredits
}
