// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Billing Configuration — single source of truth for the per-seat plan
 * ladder and usage constants on mobile.
 *
 * Pricing model (Cursor.com style):
 *   - Basic    $8/mo   single user, $5 of usage included
 *   - Pro      $20/seat/mo, $20 of usage included per seat
 *   - Business $40/seat/mo, $40 of usage included per seat
 *
 * Every request is billed at provider raw cost + 20% markup; see
 * `usage-cost.ts` and `usage-plans.ts` on the backend.
 */

export type PlanId = 'free' | 'basic' | 'pro' | 'business' | 'enterprise'

/** Included USD per seat per month. Free has no monthly pool; daily-only. */
export const SEAT_INCLUDED_USD: Record<PlanId, number> = {
  free: 0,
  basic: 5,
  pro: 20,
  business: 40,
  enterprise: 2000,
}

export interface PlanPricing {
  /** Monthly subscription price in USD (per seat for `perSeat: true`). */
  monthly: number
  /** Annual subscription price in USD (per seat for `perSeat: true`). */
  annual: number
  /** True if quantity is the seat count, false for fixed single-user plans. */
  perSeat: boolean
  /** Lookup key in Stripe so we can resolve the actual price id. */
  monthlyLookupKey: string
  annualLookupKey: string
}

export const PLAN_PRICING: Record<'basic' | 'pro' | 'business', PlanPricing> = {
  basic: {
    monthly: 8,
    annual: 80,
    perSeat: false,
    monthlyLookupKey: 'shogo_basic_monthly_v2',
    annualLookupKey: 'shogo_basic_annual_v2',
  },
  pro: {
    monthly: 20,
    annual: 200,
    perSeat: true,
    monthlyLookupKey: 'shogo_pro_monthly_v2',
    annualLookupKey: 'shogo_pro_annual_v2',
  },
  business: {
    monthly: 40,
    annual: 400,
    perSeat: true,
    monthlyLookupKey: 'shogo_business_monthly_v2',
    annualLookupKey: 'shogo_business_annual_v2',
  },
}

export const BASIC_FEATURES = [
  '$5 of monthly usage',
  '$0.50 of daily usage (up to $3/month)',
  'Basic AI model (fast responses)',
  'Unlimited domains',
  'Single user — no seats',
]

export const PRO_FEATURES = [
  '$20 of monthly usage per seat',
  '$0.50 of daily usage (up to $3/month)',
  'All AI models',
  'Auto-billed overage in $100→$500 trust blocks (cap optional)',
  'Unlimited domains',
  'Custom domains',
  'Remove branding',
  'User roles & permissions',
]

export const BUSINESS_FEATURES = [
  'Everything in Pro, plus:',
  '$40 of monthly usage per seat',
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

/** Daily included USD that refills every day on every plan. */
export const DAILY_INCLUDED_USD = 0.5

/** Monthly cap on dispensed daily USD (free tier). */
export const MONTHLY_DAILY_CAP_USD = 3.0

/**
 * Compute the included monthly USD for a (planId, seats) pair.
 *
 * Includes the always-on daily allowance for display purposes.
 * Backwards-compat with legacy tier ids (`pro_200`, `business_1200`) that
 * may still appear on grandfathered subscriptions.
 */
export function getIncludedUsdForPlan(planId: string | undefined, seats: number = 1): number {
  if (!planId) return DAILY_INCLUDED_USD

  const normalizedId = planId.toLowerCase()
  const safeSeats = Math.max(1, Math.floor(seats || 1))

  if (normalizedId in SEAT_INCLUDED_USD) {
    const base = SEAT_INCLUDED_USD[normalizedId as PlanId]
    if (normalizedId === 'free' || normalizedId === 'basic') return base + DAILY_INCLUDED_USD
    return base * safeSeats + DAILY_INCLUDED_USD
  }

  // Legacy tier suffix (e.g. `pro_200`) — interpret as USD at $0.10/credit
  // so grandfathered subscriptions still display reasonable totals while we
  // wait for the migration script to bump them.
  const match = normalizedId.match(/^(free|basic|pro|business|enterprise)_(\d+)$/)
  if (match) return parseInt(match[2], 10) * 0.1 + DAILY_INCLUDED_USD

  return DAILY_INCLUDED_USD
}

/**
 * Compute "total capacity" for the "remaining / total" usage indicator.
 * Prefers the wallet's locked allocation when present.
 *
 * Uses a named-argument object to prevent positional confusion between
 * `seats` (an integer) and `remainingTotal` (a USD balance) — historic
 * positional callers passed the remaining balance as `seats`, which
 * produced absurd capacity totals (e.g. `$40.50 / $1,600.50`).
 */
export function getIncludedUsdCapacityForDisplay(opts: {
  planId: string | undefined
  seats: number
  remainingTotal?: number
  monthlyIncludedAllocationUsd?: number
}): number {
  const { planId, seats, remainingTotal, monthlyIncludedAllocationUsd } = opts
  if (monthlyIncludedAllocationUsd && monthlyIncludedAllocationUsd > 0) {
    return monthlyIncludedAllocationUsd + DAILY_INCLUDED_USD
  }

  const baseline = getIncludedUsdForPlan(planId, seats)
  if (remainingTotal === undefined) return baseline
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

/** Display-friendly plan name from a plan id (e.g. "pro" → "Pro"). */
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
