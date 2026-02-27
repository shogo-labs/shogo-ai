/**
 * Billing Configuration — single source of truth for plan tiers, features, and credit constants.
 * Used by: billing.tsx, new-workspace.tsx
 */

export interface PriceTier {
  credits: number
  monthly: number
  annual: number
}

export const PRO_TIERS: PriceTier[] = [
  { credits: 100, monthly: 25, annual: 250 },
  { credits: 200, monthly: 50, annual: 500 },
  { credits: 400, monthly: 98, annual: 980 },
  { credits: 800, monthly: 190, annual: 1900 },
  { credits: 1200, monthly: 280, annual: 2800 },
  { credits: 2000, monthly: 460, annual: 4600 },
  { credits: 3000, monthly: 680, annual: 6800 },
  { credits: 5000, monthly: 1100, annual: 11000 },
  { credits: 7500, monthly: 1650, annual: 16500 },
  { credits: 10000, monthly: 2200, annual: 22000 },
]

export const BUSINESS_TIERS: PriceTier[] = [
  { credits: 100, monthly: 50, annual: 500 },
  { credits: 200, monthly: 100, annual: 1000 },
  { credits: 400, monthly: 195, annual: 1950 },
  { credits: 800, monthly: 380, annual: 3800 },
  { credits: 1200, monthly: 560, annual: 5600 },
  { credits: 2000, monthly: 920, annual: 9200 },
  { credits: 3000, monthly: 1350, annual: 13500 },
  { credits: 5000, monthly: 2200, annual: 22000 },
  { credits: 7500, monthly: 3200, annual: 32000 },
  { credits: 10000, monthly: 4200, annual: 42000 },
]

export const PRO_FEATURES = [
  '5 daily credits (up to 150/month)',
  'Usage-based Cloud + AI',
  'Credit rollovers',
  'Unlimited domains',
  'Custom domains',
  'Remove branding',
  'User roles & permissions',
]

export const BUSINESS_FEATURES = [
  'Everything in Pro, plus:',
  'SSO authentication',
  'Personal Projects',
  'Opt out of data training',
  'Design templates',
  'Priority support',
]

export const ENTERPRISE_FEATURES = [
  'Everything in Business, plus:',
  'Dedicated support',
  'Onboarding services',
  'Custom connections',
  'Group-based access control',
  'SCIM provisioning',
  'Custom design systems',
]

export const PLAN_CREDITS: Record<string, number> = {
  free: 50,
  pro: 100,
  business: 100,
  enterprise: 10000,
}

export const DAILY_CREDITS = 5

export function getTotalCreditsForPlan(planId: string | undefined): number {
  if (!planId) return (PLAN_CREDITS['free'] || 0) + DAILY_CREDITS
  return (PLAN_CREDITS[planId] || 0) + DAILY_CREDITS
}

export function formatCredits(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return n % 1 === 0 ? String(n) : n.toFixed(2)
}
