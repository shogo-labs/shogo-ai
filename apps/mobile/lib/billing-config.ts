// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Billing Configuration — single source of truth for plan tiers, features, and credit constants.
 * Import from here rather than defining billing values locally in components.
 */

export interface PriceTier {
  credits: number
  monthly: number
  annual: number
}

/** The base credit amount that maps 1:1 to a plan name (no suffix needed in planId). */
export const BASE_TIER_CREDITS = 200

export const BASIC_TIER: PriceTier = { credits: 50, monthly: 8, annual: 80 }

export const BASIC_FEATURES = [
  '50 monthly credits',
  '5 daily credits (up to 30/month)',
  'Basic AI model (fast responses)',
  'Unlimited domains',
]

export const PRO_TIERS: PriceTier[] = [
  { credits: 200, monthly: 25, annual: 250 },
  { credits: 400, monthly: 50, annual: 500 },
  { credits: 800, monthly: 98, annual: 980 },
  { credits: 1600, monthly: 190, annual: 1900 },
  { credits: 2400, monthly: 280, annual: 2800 },
  { credits: 4000, monthly: 460, annual: 4600 },
  { credits: 6000, monthly: 680, annual: 6800 },
  { credits: 10000, monthly: 1100, annual: 11000 },
  { credits: 15000, monthly: 1650, annual: 16500 },
  { credits: 20000, monthly: 2200, annual: 22000 },
]

export const BUSINESS_TIERS: PriceTier[] = [
  { credits: 200, monthly: 40, annual: 400 },
  { credits: 400, monthly: 65, annual: 650 },
  { credits: 800, monthly: 130, annual: 1300 },
  { credits: 1600, monthly: 250, annual: 2500 },
  { credits: 2400, monthly: 365, annual: 3650 },
  { credits: 4000, monthly: 600, annual: 6000 },
  { credits: 6000, monthly: 885, annual: 8850 },
  { credits: 10000, monthly: 1430, annual: 14300 },
  { credits: 15000, monthly: 2145, annual: 21450 },
  { credits: 20000, monthly: 2860, annual: 28600 },
]

export const PRO_FEATURES = [
  '5 daily credits (up to 30/month)',
  'Usage-based Cloud + AI',
  'Credit rollovers',
  'Unlimited domains',
  'Custom domains',
  'Remove branding',
  'User roles & permissions',
]

export const BUSINESS_FEATURES = [
  'Everything in Pro, plus:',
  'Team analytics & usage reporting',
  'SSO authentication',
  'Audit logs',
  'Personal & restricted projects',
  'Opt out of data training',
  'Per-member spending limits',
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
  free: 0,
  basic: 50,
  pro: 200,
  business: 200,
  enterprise: 20000,
}

export const DAILY_CREDITS = 5

export const MONTHLY_DAILY_CAP = 30

export function getTotalCreditsForPlan(planId: string | undefined): number {
  if (!planId) return (PLAN_CREDITS['free'] || 0) + DAILY_CREDITS

  if (PLAN_CREDITS[planId] !== undefined) {
    return PLAN_CREDITS[planId] + DAILY_CREDITS
  }

  const match = planId.match(/^(free|basic|pro|business|enterprise)_(\d+)$/)
  if (match) {
    return parseInt(match[2], 10) * 2 + DAILY_CREDITS
  }

  return DAILY_CREDITS
}

export function formatCredits(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return n % 1 === 0 ? String(n) : n.toFixed(2)
}
