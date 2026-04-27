// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Billing Configuration — single source of truth for plan tiers and usage
 * constants.
 *
 * Usage is expressed in USD (Cursor-style); historical credit tier suffixes
 * (e.g. `pro_200`, `business_1200`) are interpreted at $0.10 per legacy
 * credit, so `pro_200` == $20 included usage per month. Raw provider costs
 * are billed with a flat 20% markup; see `usage-cost.ts` on the backend.
 */

export interface PriceTier {
  /** Included USD of usage per month. */
  includedUsd: number
  monthly: number
  annual: number
}

/** The base monthly included USD that maps 1:1 to a plan name (no suffix needed in planId). */
export const BASE_TIER_INCLUDED_USD = 20

export const BASIC_TIER: PriceTier = { includedUsd: 5, monthly: 8, annual: 80 }

export const BASIC_FEATURES = [
  '$5 of monthly usage',
  '$0.50 of daily usage (up to $3/month)',
  'Basic AI model (fast responses)',
  'Unlimited domains',
]

export const PRO_TIERS: PriceTier[] = [
  { includedUsd: 20, monthly: 25, annual: 250 },
  { includedUsd: 40, monthly: 50, annual: 500 },
  { includedUsd: 80, monthly: 98, annual: 980 },
  { includedUsd: 160, monthly: 190, annual: 1900 },
  { includedUsd: 240, monthly: 280, annual: 2800 },
  { includedUsd: 400, monthly: 460, annual: 4600 },
  { includedUsd: 600, monthly: 680, annual: 6800 },
  { includedUsd: 1000, monthly: 1100, annual: 11000 },
  { includedUsd: 1500, monthly: 1650, annual: 16500 },
  { includedUsd: 2000, monthly: 2200, annual: 22000 },
]

export const BUSINESS_TIERS: PriceTier[] = [
  { includedUsd: 20, monthly: 40, annual: 400 },
  { includedUsd: 40, monthly: 65, annual: 650 },
  { includedUsd: 80, monthly: 130, annual: 1300 },
  { includedUsd: 160, monthly: 250, annual: 2500 },
  { includedUsd: 240, monthly: 365, annual: 3650 },
  { includedUsd: 400, monthly: 600, annual: 6000 },
  { includedUsd: 600, monthly: 885, annual: 8850 },
  { includedUsd: 1000, monthly: 1430, annual: 14300 },
  { includedUsd: 1500, monthly: 2145, annual: 21450 },
  { includedUsd: 2000, monthly: 2860, annual: 28600 },
]

export const PRO_FEATURES = [
  '$0.50 of daily usage (up to $3/month)',
  'Opt-in usage-based pricing for overage',
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

/** Base monthly included USD per plan tier. */
export const PLAN_INCLUDED_USD: Record<string, number> = {
  free: 0,
  basic: 5,
  pro: 20,
  business: 20,
  enterprise: 2000,
}

/** Daily included USD that refills every day on every plan. */
export const DAILY_INCLUDED_USD = 0.5

/** Monthly cap on dispensed daily USD (free tier). */
export const MONTHLY_DAILY_CAP_USD = 3.0

export function getIncludedUsdForPlan(planId: string | undefined): number {
  if (!planId) return (PLAN_INCLUDED_USD['free'] || 0) + DAILY_INCLUDED_USD

  const normalizedId = planId.toLowerCase()

  if (PLAN_INCLUDED_USD[normalizedId] !== undefined) {
    return PLAN_INCLUDED_USD[normalizedId] + DAILY_INCLUDED_USD
  }

  // Legacy credit-tier suffix (e.g. `pro_200`) — interpret as USD at
  // $0.10/credit for backward compatibility with old subscription IDs.
  const match = normalizedId.match(/^(free|basic|pro|business|enterprise)_(\d+)$/)
  if (match) {
    return parseInt(match[2], 10) * 0.10 + DAILY_INCLUDED_USD
  }

  return DAILY_INCLUDED_USD
}

/**
 * Compute the "total capacity" for display in "remaining / total" usage
 * indicators. Uses `monthlyIncludedAllocationUsd` from the UsageWallet (the
 * original allocation that does not decrease with usage) when available.
 * Falls back to deriving from planId.
 */
export function getIncludedUsdCapacityForDisplay(
  planId: string | undefined,
  remainingTotal: number | undefined,
  monthlyIncludedAllocationUsd?: number,
): number {
  if (monthlyIncludedAllocationUsd && monthlyIncludedAllocationUsd > 0) {
    return monthlyIncludedAllocationUsd + DAILY_INCLUDED_USD
  }

  const baseline = getIncludedUsdForPlan(planId)

  if (remainingTotal === undefined) return baseline

  // Conservative fallback: if remaining exceeds baseline (rare), use
  // remaining so the UI doesn't show remaining > total.
  return Math.max(baseline, remainingTotal)
}

/** Format a USD amount for UI (e.g. `$12.34`, `$0`, `$1,234`). */
export function formatUsd(n: number): string {
  const rounded = Math.round(n * 100) / 100
  const opts: Intl.NumberFormatOptions = rounded % 1 === 0
    ? { minimumFractionDigits: 0, maximumFractionDigits: 0 }
    : { minimumFractionDigits: 2, maximumFractionDigits: 2 }
  return `$${rounded.toLocaleString('en-US', opts)}`
}

/** Extract a display-friendly plan name from a tiered planId (e.g. "business_1200" → "Business"). */
export function getPlanDisplayName(planId: string | undefined): string {
  if (!planId) return 'Free'
  const base = planId.split('_')[0]
  return base.charAt(0).toUpperCase() + base.slice(1)
}

export interface CurrencyDisplay {
  code: string
  symbol: string
  name: string
  symbolPosition: 'prefix' | 'suffix'
  decimalPlaces: number
}

export function formatCurrencyPrice(amount: number, currency: CurrencyDisplay): string {
  const rounded = currency.decimalPlaces === 0
    ? Math.round(amount)
    : Math.round(amount * 100) / 100
  const formatted = currency.decimalPlaces === 0
    ? rounded.toLocaleString('en-US')
    : rounded.toLocaleString('en-US', {
        minimumFractionDigits: currency.decimalPlaces,
        maximumFractionDigits: currency.decimalPlaces,
      })
  return currency.symbolPosition === 'prefix'
    ? `${currency.symbol}${formatted}`
    : `${formatted} ${currency.symbol}`
}

// ============================================================================
// Legacy credit-named aliases (kept temporarily for incremental call-site
// migration; prefer the USD-named exports above in new code).
// ============================================================================

/** @deprecated Use BASE_TIER_INCLUDED_USD. */
export const BASE_TIER_CREDITS = BASE_TIER_INCLUDED_USD

/** @deprecated Use PLAN_INCLUDED_USD. */
export const PLAN_CREDITS = PLAN_INCLUDED_USD

/** @deprecated Use DAILY_INCLUDED_USD. */
export const DAILY_CREDITS = DAILY_INCLUDED_USD

/** @deprecated Use MONTHLY_DAILY_CAP_USD. */
export const MONTHLY_DAILY_CAP = MONTHLY_DAILY_CAP_USD

/** @deprecated Use getIncludedUsdForPlan. */
export const getTotalCreditsForPlan = getIncludedUsdForPlan

/** @deprecated Use getIncludedUsdCapacityForDisplay. */
export const getCreditsCapacityForDisplay = getIncludedUsdCapacityForDisplay

/** @deprecated Use formatUsd. */
export const formatCredits = formatUsd
