// SPDX-License-Identifier: MIT
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

/**
 * Rolling usage-window durations (ms). Usage is "unlimited" within these two
 * parallel windows (time-gated, like Codex / Claude Code); when a window is
 * exhausted, usage falls through to metered overage and otherwise blocks
 * until the window resets. Mirrors the backend `usage-plans.ts`.
 */
export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000
export const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000

export interface WindowLimits {
  fiveHourUsd: number
  weeklyUsd: number
}

/** Per-window included USD of compute per plan. `null` = uncapped. */
export const ROLLING_WINDOW_LIMITS: Record<PlanId, WindowLimits | null> = {
  free: { fiveHourUsd: 0.5, weeklyUsd: 2 },
  basic: { fiveHourUsd: 2, weeklyUsd: 10 },
  pro: { fiveHourUsd: 8, weeklyUsd: 40 },
  business: { fiveHourUsd: 20, weeklyUsd: 120 },
  enterprise: null,
}

/**
 * Window limits for a (plan, seats) pair. Pro/Business scale per seat; Free
 * and Basic are single-pool; Enterprise is uncapped (`null`). Mirrors the
 * backend `getWindowLimitsForPlan`.
 */
export function getWindowLimitsForPlan(
  planId: string | null | undefined,
  seats: number = 1,
): WindowLimits | null {
  const normalized = String(planId ?? 'free').toLowerCase().trim()
  const key: PlanId = normalized.startsWith('enterprise') ? 'enterprise'
    : normalized.startsWith('business') ? 'business'
    : normalized.startsWith('pro') ? 'pro'
    : normalized.startsWith('basic') ? 'basic'
    : 'free'
  const base = ROLLING_WINDOW_LIMITS[key]
  if (base == null) return null
  if (key === 'pro' || key === 'business') {
    const s = Math.max(1, Math.floor(seats || 1))
    return { fiveHourUsd: base.fiveHourUsd * s, weeklyUsd: base.weeklyUsd * s }
  }
  return { fiveHourUsd: base.fiveHourUsd, weeklyUsd: base.weeklyUsd }
}

/**
 * Human-readable countdown to when a window resets, e.g. "2h 13m" or "3d 4h".
 * Returns "now" when the reset is in the past / imminent and "" when there is
 * no reset time (window not yet opened).
 */
export function formatResetCountdown(resetsAt: string | Date | null | undefined, now: number = Date.now()): string {
  if (!resetsAt) return ''
  const target = typeof resetsAt === 'string' ? Date.parse(resetsAt) : resetsAt.getTime()
  if (Number.isNaN(target)) return ''
  const ms = target - now
  if (ms <= 0) return 'now'
  const totalMinutes = Math.ceil(ms / 60000)
  const days = Math.floor(totalMinutes / (60 * 24))
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
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
  'Unlimited usage (fair-use 5-hour & weekly limits)',
  'Basic AI model (fast responses)',
  'Unlimited domains',
  'Single user — no seats',
]

export const PRO_FEATURES = [
  'Unlimited usage with higher 5-hour & weekly limits (per seat)',
  'All AI models',
  'Auto-billed overage in $100→$500 trust blocks (cap optional)',
  'Unlimited domains',
  'Custom domains',
  'Remove branding',
  'User roles & permissions',
]

export const BUSINESS_FEATURES = [
  'Everything in Pro, plus:',
  'Highest 5-hour & weekly usage limits (per seat)',
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
  'Uncapped usage — no 5-hour or weekly limits',
  'Dedicated support',
  'Onboarding services',
  'Custom connections',
  'Group-based access control',
  'SCIM provisioning',
  'Custom design systems',
]

/**
 * Daily included USD for the free plan. The daily allowance is a free-tier
 * only safety net — paid plans rely on their monthly included pool and
 * receive $0 from `getDailyIncludedForPlan`.
 */
export const FREE_DAILY_INCLUDED_USD = 1

/** Monthly cap on dispensed daily USD (free tier). */
export const MONTHLY_DAILY_CAP_USD = 5

/**
 * Daily included USD for a given plan. Only the free tier gets a daily
 * allowance; every paid plan returns 0. Mirrors the backend helper in
 * `apps/api/src/config/usage-plans.ts`.
 *
 * Missing / unrecognized plan ids fall back to the free amount so a
 * brand-new workspace whose plan hasn't been resolved still shows the
 * safety-net allowance.
 */
export function getDailyIncludedForPlan(planId: string | null | undefined): number {
  if (!planId) return FREE_DAILY_INCLUDED_USD
  const normalized = String(planId).toLowerCase().trim()
  if (normalized.startsWith('free')) return FREE_DAILY_INCLUDED_USD
  if (
    normalized.startsWith('basic') ||
    normalized.startsWith('pro') ||
    normalized.startsWith('business') ||
    normalized.startsWith('enterprise')
  ) {
    return 0
  }
  return FREE_DAILY_INCLUDED_USD
}

/**
 * Compute the included monthly USD for a (planId, seats) pair.
 *
 * The free-tier daily allowance is added in for display purposes; paid
 * plans show only their monthly included pool.
 *
 * Backwards-compat with legacy tier ids (`pro_200`, `business_1200`) that
 * may still appear on grandfathered subscriptions.
 */
export function getIncludedUsdForPlan(planId: string | undefined, seats: number = 1): number {
  const dailyForPlan = getDailyIncludedForPlan(planId)
  if (!planId) return dailyForPlan

  const normalizedId = planId.toLowerCase()
  const safeSeats = Math.max(1, Math.floor(seats || 1))

  if (normalizedId in SEAT_INCLUDED_USD) {
    const base = SEAT_INCLUDED_USD[normalizedId as PlanId]
    if (normalizedId === 'free' || normalizedId === 'basic') return base + dailyForPlan
    return base * safeSeats + dailyForPlan
  }

  // Legacy tier suffix (e.g. `pro_200`) — interpret as USD at $0.10/credit
  // so grandfathered subscriptions still display reasonable totals while we
  // wait for the migration script to bump them.
  const match = normalizedId.match(/^(free|basic|pro|business|enterprise)_(\d+)$/)
  if (match) return parseInt(match[2], 10) * 0.1 + dailyForPlan

  return dailyForPlan
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
    return monthlyIncludedAllocationUsd + getDailyIncludedForPlan(planId)
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
