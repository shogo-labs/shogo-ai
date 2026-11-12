// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { MARKUP_MULTIPLIER } from '../lib/usage-cost'
import { isLegacyBusinessPriceId, isLegacyPlanPriceId } from './stripe-prices'
/**
 * Central Usage Plan Configuration
 *
 * Single source of truth for USD usage allocations per plan. The plan ladder is
 * Slack-shaped: the seat price buys the workspace, every seat carries its own
 * fixed weekly AI allowance, and usage past the allowance is metered overage.
 *
 *   - Basic    $8/mo       1 seat,   $10 of AI/mo ($2.30 weekly)
 *   - Pro      $20/seat/mo legacy,   $20 of AI/mo ($4.90 weekly) — existing holders
 *   - Business $16/seat/mo,          $20/seat/mo ($4.60 weekly per seat)
 *
 * Both offered tiers include AI worth 125% of the seat price at full burn: the
 * seat breaks even at 96% allowance utilization and earns a 50% gross margin at
 * 48%. That is the deliberate Slack bet — see `getBreakEvenUtilization` and
 * `getUtilizationForMargin`, which the pricing tests pin down.
 *
 * Used by: billing.service.ts (backend allocation), webhook (monthly refills).
 *
 * All values are in USD. LLM / voice / image usage is metered at the raw
 * provider cost plus `MARKUP_MULTIPLIER` (see `usage-cost.ts`).
 */

/**
 * Daily included USD for the free plan. Refills every day on the free
 * tier only — paid plans (basic, pro, business, enterprise) get their
 * monthly included pool instead and no daily top-up.
 */
export const FREE_DAILY_INCLUDED_USD = 1.00

/** Monthly cap on dispensed daily USD (free tier). */
export const MONTHLY_DAILY_CAP_USD = 5.00

/**
 * Included USD per *seat* per month. Basic is single-user (always 1 seat).
 * Free is 0 (only the daily allowance applies).
 */
export const SEAT_INCLUDED_USD = {
  free: 0,
  basic: 10,
  pro: 20,
  business: 20,
  enterprise: 2000,
} as const

/**
 * List seat price per month (USD) for each tier, monthly billing. Used only for
 * the unit-economics assertions (`getBreakEvenUtilization`) and admin
 * reporting — never for enforcement. `null` = negotiated (enterprise).
 */
export const SEAT_PRICE_MONTHLY_USD: Record<PlanId, number | null> = {
  free: 0,
  basic: 8,
  pro: 20,
  business: 16,
  enterprise: null,
}

export type PlanId = keyof typeof SEAT_INCLUDED_USD

/**
 * Daily included USD for a given plan. Only the free tier receives a
 * daily allowance — every paid plan returns 0 so callers can use this
 * uniformly when allocating wallets or computing remaining balances.
 *
 * Unknown / unrecognized plan ids fall back to the free amount so that
 * brand-new workspaces (whose plan hasn't been resolved yet) still get
 * the safety-net allowance.
 */
export function getDailyIncludedForPlan(planId: string | null | undefined): number {
  const normalized = normalizePlanId(planId) ?? 'free'
  return normalized === 'free' ? FREE_DAILY_INCLUDED_USD : 0
}

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
    if (planId === 'free' || planId === 'basic') return base
    return base * safeSeats
  }
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
 * Tier order for comparing plan ids. Used to resolve the "effective"
 * plan for a workspace when both a paid subscription and one or more
 * `WorkspaceGrant` rows are present, and to compare granted plans
 * against each other.
 *
 * Tier names match `SEAT_INCLUDED_USD` keys; legacy / decorated plan
 * ids (`pro_200`, `Business-Annual`, etc.) are normalized via
 * `normalizePlanId` before lookup so any caller of `comparePlanRank`
 * can be planId-agnostic.
 */
export const PLAN_RANK = {
  free: 0,
  basic: 1,
  pro: 2,
  business: 3,
  enterprise: 4,
} as const satisfies Record<PlanId, number>

/**
 * Normalize an arbitrary planId string to one of the canonical tier
 * names in `PLAN_RANK`. Handles the legacy underscored ids
 * (`pro_200`, `business_1200`) and the various
 * `business-monthly`/`Business-Annual` / `Enterprise-XL` decorations
 * by prefix-matching against the canonical name.
 *
 * Returns `null` for ids that don't resolve to a known tier. Callers
 * that want a falsy fallback should use `?? 'free'` themselves.
 */
export function normalizePlanId(planId: string | null | undefined): PlanId | null {
  if (!planId) return null
  const lc = planId.toLowerCase().trim()
  if (lc.startsWith('enterprise')) return 'enterprise'
  if (lc.startsWith('business')) return 'business'
  if (lc.startsWith('pro')) return 'pro'
  if (lc.startsWith('basic')) return 'basic'
  if (lc.startsWith('free')) return 'free'
  return null
}

/**
 * Compare two plan ids by tier rank. Returns a number suitable for
 * `Array.sort`: negative if `a < b`, zero if equal, positive if
 * `a > b`. Unknown plans rank as `free` (`0`).
 */
export function comparePlanRank(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const ra = PLAN_RANK[normalizePlanId(a) ?? 'free']
  const rb = PLAN_RANK[normalizePlanId(b) ?? 'free']
  return ra - rb
}

/**
 * Always-on published-app slots included per *seat*, by plan.
 *
 * Slots are pooled per workspace: a workspace's total included slots =
 * `perSeat × entitledSeats` (see `getAlwaysOnAllowance`). An "always-on" app
 * runs its published Knative service at `min-scale=1` so it never scales to
 * zero — no cold-start delay for visitors (see `publish.ts`).
 *
 * `free`/`basic` get 0 (always-on is a paid upgrade gated to pro+). `null`
 * means unlimited (enterprise).
 */
export const ALWAYS_ON_SLOTS_PER_SEAT: Record<PlanId, number | null> = {
  free: 0,
  basic: 0,
  pro: 1,
  business: 1,
  enterprise: null,
}

/**
 * Agent replies that may be *working at once* in a workspace, by plan.
 *
 * This is an admission rule for new runs, not a cap on how many runs exist: a
 * run that is only blocked in `wait` (or any other open tool) gives its slot
 * back, so a busy workspace keeps admitting tagged agents (see
 * `agent-reply-slots.ts`). A workspace admin may lower it; the plan value is
 * the ceiling in the cloud.
 */
export const AGENT_REPLY_CONCURRENCY: Record<PlanId, number> = {
  free: 2,
  basic: 4,
  pro: 8,
  business: 12,
  enterprise: 24,
}

/**
 * Desktop's default, and its ceiling: local mode has no plan, so an admin may
 * set anything from 1 to this, and 24 is what a fresh workspace gets.
 */
export const LOCAL_AGENT_REPLY_CONCURRENCY = 24

/** Plans whose always-on slot allowance scales with the paid seat count. */
const PER_SEAT_ALWAYS_ON_PLANS: ReadonlySet<PlanId> = new Set<PlanId>(['pro', 'business'])

/**
 * Resolve the total number of always-on published-app slots a (plan, seats)
 * tuple is entitled to, pooled across the workspace.
 *
 * - Returns `Infinity` for uncapped plans (enterprise).
 * - Per-seat plans (`pro`, `business`) multiply the per-seat allowance by
 *   `max(1, seats)`.
 * - `free`/`basic` (and unknown ids) return 0.
 */
export function getAlwaysOnAllowance(
  planId: string | null | undefined,
  seats: number = 1,
): number {
  const normalized = normalizePlanId(planId) ?? 'free'
  const perSeat = ALWAYS_ON_SLOTS_PER_SEAT[normalized]
  if (perSeat == null) return Infinity
  if (!PER_SEAT_ALWAYS_ON_PLANS.has(normalized)) return perSeat
  const safeSeats = Math.max(1, Math.floor(seats || 1))
  return perSeat * safeSeats
}

/**
 * Rolling usage-window durations, in milliseconds. Usage is gated by two
 * independent windows that run in parallel (modeled on how Codex / Claude
 * Code time-gate "unlimited" plans): a short burst window and a longer
 * weekly window. Each window starts on the first metered action after the
 * previous window elapsed (fixed-window-from-first-event) and exposes a
 * `resetsAt = windowStart + duration`.
 */
export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000
export const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Average weeks per calendar month (365.25 / 12 / 7 ≈ 4.348). The weekly
 * rolling window is the binding constraint on monthly usage, so the
 * "effective monthly included" usage of a plan is `weeklyUsd × WEEKS_PER_MONTH`
 * for back-to-back windows. See `getMonthlyIncludedEquivalent`.
 */
export const WEEKS_PER_MONTH = 365.25 / 12 / 7

/**
 * ── How the window limits are sized (the Slack bet) ──────────────────────
 *
 * Windows count *marked-up* USD (`billedUsd = providerRawCost × MARKUP`,
 * MARKUP = 1.20). Included usage is covered by the subscription — we don't
 * charge per unit inside a window — so our real cost for a maxed window is the
 * underlying provider COGS = `markedUp / MARKUP`.
 *
 * A user who pins their windows continuously for a whole month costs:
 *
 *     monthlyCogsRaw = weeklyUsd × WEEKS_PER_MONTH / MARKUP
 *
 * Every offered tier is deliberately sized so that allowance ≈ 125% of the seat
 * price at full burn (basic $2.30/wk ≈ $10/mo of AI on an $8 seat; business
 * $4.60/wk ≈ $20/mo on a $16 seat). The seat is therefore *underwater* for the
 * last sliver of its allowance and the return comes from average utilization
 * plus metered overage past the allowance:
 *
 *   - break-even utilization (margin 0)      = 12 / (weeklyUsd × WEEKS_PER_MONTH)
 *   - utilization for a 50% gross margin     = half of that
 *
 * i.e. 96% to break even and 48% for a 50% margin — identical for both tiers
 * because the ratios match. `getBreakEvenUtilization` /
 * `getUtilizationForMargin` compute this, and the pricing tests fail if an
 * allowance change silently breaks it. 5-hour windows are sized at 40% of the
 * weekly allowance so a single burst can't drain the whole week.
 * `null` = uncapped (enterprise).
 */
export const ROLLING_WINDOW_LIMITS: Record<
  PlanId,
  { fiveHourUsd: number; weeklyUsd: number } | null
> = {
  free: { fiveHourUsd: 0.2, weeklyUsd: 0.5 },
  basic: { fiveHourUsd: 0.92, weeklyUsd: 2.3 },
  pro: { fiveHourUsd: 1.96, weeklyUsd: 4.9 },
  business: { fiveHourUsd: 1.84, weeklyUsd: 4.6 },
  enterprise: null,
}

/**
 * The allowance a Business seat was sold at *before* v2.5.0 (SHO-312 Phase 5):
 * $40 of AI per seat per month at $40/seat, i.e. $9.90/week and $3.96 per
 * 5-hour window.
 *
 * Every subscription still sitting on the legacy $40 price — or on no price at
 * all, which means it predates the price backfill — keeps this allowance until
 * its next renewal moves it to the $16 price. Without it, merging the new
 * allowances would silently halve what 5 paying workspaces bought. See
 * `getPlanAllowance` and `scripts/migrate-phase5-subscriptions.ts`.
 */
export const LEGACY_BUSINESS_ROLLING_WINDOW_LIMITS = {
  fiveHourUsd: 3.96,
  weeklyUsd: 9.9,
} as const

/** Included USD per seat per month on the legacy $40 Business price. */
export const LEGACY_BUSINESS_SEAT_INCLUDED_USD = 40

export interface WindowLimits {
  fiveHourUsd: number
  weeklyUsd: number
}

/**
 * Resolve the rolling-window limits for one seat on `planId`.
 *
 * These limits are **per seat**: every member's windows are metered against
 * their own counters, so one seat can never spend another's allowance. The
 * seat count is deliberately not accepted here — enforcement must never
 * multiply — and the workspace total (the sum of seats) lives in
 * `getMonthlyIncludedEquivalent` for finance / admin reporting only.
 *
 * - `null` for uncapped plans (enterprise).
 * - Unknown / unresolved plans fall back to the free tier's safety-net window.
 */
export function getWindowLimitsForPlan(
  planId: string | null | undefined,
): WindowLimits | null {
  const normalized = normalizePlanId(planId) ?? 'free'
  const base = ROLLING_WINDOW_LIMITS[normalized]
  if (base == null) return null
  return { fiveHourUsd: base.fiveHourUsd, weeklyUsd: base.weeklyUsd }
}

export interface PlanAllowance {
  /** Per-seat rolling-window limits. `null` = uncapped (enterprise). */
  windowLimits: WindowLimits | null
  /** Included USD per seat per month. */
  monthlyIncludedUsdPerSeat: number
  /**
   * True when the allowance comes from a price the subscription was sold
   * before v2.5.0 and has not been moved off yet.
   */
  legacy: boolean
}

/**
 * The allowance a (plan, price) pair is entitled to.
 *
 * Allowances follow the price, not just the plan name: a Business seat sold at
 * $40 keeps $9.90/week ($3.96/5h, $40/mo) until its next renewal moves it to
 * the $16 price, at which point the same `business` plan resolves to
 * $4.60/week ($1.84/5h, $20/mo). Everything else — Basic ($8 either way), Pro,
 * Enterprise, grants — resolves straight off today's ladder.
 *
 * A `null`/missing price on a Business subscription counts as legacy: those
 * rows predate the `stripePriceId` backfill and every one of them is on $40,
 * so the deploy→backfill gap can never drop a paying customer to the smaller
 * allowance. New checkouts always write the price id.
 */
export function getPlanAllowance(
  planId: string | null | undefined,
  stripePriceId?: string | null,
): PlanAllowance {
  const normalized = normalizePlanId(planId) ?? 'free'
  const legacy = normalized === 'business'
    ? isLegacyBusinessPriceId(stripePriceId)
    : isLegacyPlanPriceId(stripePriceId)
  if (legacy && normalized === 'business') {
    return {
      windowLimits: { ...LEGACY_BUSINESS_ROLLING_WINDOW_LIMITS },
      monthlyIncludedUsdPerSeat: LEGACY_BUSINESS_SEAT_INCLUDED_USD,
      legacy: true,
    }
  }
  return {
    windowLimits: getWindowLimitsForPlan(normalized),
    monthlyIncludedUsdPerSeat: SEAT_INCLUDED_USD[normalized],
    legacy: false,
  }
}

/**
 * Monthly included USD for a (plan, seats, price) tuple — the allocation the
 * wallet gets. Legacy tiered ids (`business_1200`, …) are delegated to
 * `getMonthlyIncludedForPlan` unchanged, since their credit count is a
 * workspace total rather than a per-seat amount.
 */
export function getMonthlyIncludedForPlanAndPrice(
  planId: string,
  seats: number = 1,
  stripePriceId?: string | null,
): number {
  if (/^(basic|pro|business)_\d+$/.test(planId)) {
    return getMonthlyIncludedForPlan(planId, seats)
  }
  const normalized = normalizePlanId(planId) ?? 'free'
  const allowance = getPlanAllowance(planId, stripePriceId)
  if (normalized === 'free' || normalized === 'basic') {
    return allowance.monthlyIncludedUsdPerSeat
  }
  const safeSeats = Math.max(1, Math.floor(seats || 1))
  return allowance.monthlyIncludedUsdPerSeat * safeSeats
}

/**
 * Effective monthly included usage (marked-up USD) implied by the weekly
 * rolling window for a (plan, seats) tuple — i.e. the workspace total across
 * seats. The weekly window is the binding monthly constraint, so for
 * back-to-back windows the monthly ceiling is `weeklyUsd × WEEKS_PER_MONTH`
 * per seat.
 *
 * This is the *upper bound* of included usage assuming continuous use — pausing
 * pushes each window's reset later, fitting fewer full weekly buckets per
 * month. It is the included/unlimited zone only; usage beyond it falls through
 * to metered overage. Returns `null` for uncapped plans (enterprise).
 *
 * Reporting only — never enforcement. Enforcement uses the per-seat
 * `getWindowLimitsForPlan` against each member's own counters. Intended for
 * internal/finance/admin surfaces; the customer UI shows the seat's usage
 * relative to its window (utilization %), not this dollar figure.
 */
export function getMonthlyIncludedEquivalent(
  planId: string | null | undefined,
  seats: number = 1,
): number | null {
  const limits = getWindowLimitsForPlan(planId)
  if (limits == null) return null
  const normalized = normalizePlanId(planId) ?? 'free'
  // `basic` and `free` are single-seat tiers; their seat count never multiplies.
  const safeSeats =
    normalized === 'basic' || normalized === 'free'
      ? 1
      : Math.max(1, Math.floor(seats || 1))
  return limits.weeklyUsd * WEEKS_PER_MONTH * safeSeats
}

/**
 * Fraction of a seat's allowance that has to be consumed for the seat to earn
 * `margin` (0..1) of its list price. Complements of each other:
 *
 *   - `getBreakEvenUtilization('basic')`    → 0.96 (margin 0)
 *   - `getUtilizationForMargin('basic', .5)` → 0.48 (50% gross margin)
 *
 * Cost of a fully consumed allowance is `weeklyUsd × WEEKS_PER_MONTH / MARKUP`;
 * the seat keeps `price × (1 - margin)`, so
 * `u = price × (1 - margin) × MARKUP / (weeklyUsd × WEEKS_PER_MONTH)`.
 *
 * Returns `null` for uncapped/unpriced tiers (enterprise). A value above 1 means
 * the seat still makes money at 100% utilization (legacy `pro` at $4.90/wk).
 */
export function getUtilizationForMargin(
  planId: string | null | undefined,
  margin: number = 0,
): number | null {
  const normalized = normalizePlanId(planId) ?? 'free'
  const limits = getWindowLimitsForPlan(normalized)
  const price = SEAT_PRICE_MONTHLY_USD[normalized]
  if (limits == null || price == null || price <= 0) return null
  const monthlyCogsAtFullBurn = (limits.weeklyUsd * WEEKS_PER_MONTH) / MARKUP_MULTIPLIER
  if (monthlyCogsAtFullBurn <= 0) return null
  return (price * (1 - margin)) / monthlyCogsAtFullBurn
}

/** Utilization at which a seat's gross margin is zero. See `getUtilizationForMargin`. */
export function getBreakEvenUtilization(
  planId: string | null | undefined,
): number | null {
  return getUtilizationForMargin(planId, 0)
}

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

/**
 * Signup promo credit (see `services/signup-credit.service.ts`).
 *
 * New cloud signups receive `SIGNUP_CREDIT_TOTAL_USD` of promo credit on
 * their team workspace, released in two stages:
 *   - `SIGNUP_CREDIT_INITIAL_USD` at signup (low-risk, email not yet verified)
 *   - the remainder once the email is verified
 * Credit expires `SIGNUP_CREDIT_TTL_DAYS` after the first grant. It is spent
 * after the rolling windows and before metered overage, and only while it has
 * not expired.
 */
export const SIGNUP_CREDIT_TOTAL_USD = 10
export const SIGNUP_CREDIT_INITIAL_USD = 2
export const SIGNUP_CREDIT_VERIFIED_USD = SIGNUP_CREDIT_TOTAL_USD - SIGNUP_CREDIT_INITIAL_USD
export const SIGNUP_CREDIT_TTL_DAYS = 30

/**
 * Free trial on paid plans. Stripe Checkout collects a card up front and bills
 * it when the trial ends. Only one trial per user, workspace and card.
 */
export const TRIAL_PERIOD_DAYS = 7
export const TRIAL_ELIGIBLE_PLANS: readonly PlanId[] = ['basic', 'pro', 'business']

/**
 * Promo credit that can still be spent at `now`. Zero once the credit has
 * expired or when there is no expiry, so a stray balance without an expiry
 * never becomes spendable.
 */
export function promoCreditAvailableUsd(
  wallet: { promoCreditUsd: number; promoCreditExpiresAt: Date | string | null } | null | undefined,
  now: Date = new Date(),
): number {
  if (!wallet?.promoCreditExpiresAt) return 0
  if (new Date(wallet.promoCreditExpiresAt).getTime() <= now.getTime()) return 0
  return Math.max(0, wallet.promoCreditUsd)
}

// =============================================================================
// Published-app plan caps (SHO-308 §9)
//
// Published apps run on Knative and are billed for real (see
// config/published-pricing.ts). These caps bound what a plan may request, so a
// free app can't ask for 20 replicas of an L pod. They sit next to
// ALWAYS_ON_SLOTS_PER_SEAT because they are the same kind of rule: a plan
// entitlement, not a runtime setting.
// =============================================================================

/** Max replicas a single published environment may request, by plan. */
export const PUBLISHED_MAX_REPLICAS: Record<PlanId, number | null> = {
  free: 1,
  basic: 1,
  pro: 5,
  business: 20,
  enterprise: null, // unlimited
}

/** Size tiers a plan may select for a published environment. */
export const PUBLISHED_SIZES: Record<PlanId, ReadonlyArray<'s' | 'm' | 'l'>> = {
  free: ['s'],
  basic: ['s'],
  pro: ['s', 'm'],
  business: ['s', 'm', 'l'],
  enterprise: ['s', 'm', 'l'],
}

/** Whether a plan may create a staging environment at all. */
export const PUBLISHED_STAGING_ENVS: Record<PlanId, boolean> = {
  free: false,
  basic: false,
  pro: true,
  business: true,
  enterprise: true,
}

export interface PublishedPlanCaps {
  plan: PlanId
  /** `null` = unlimited. */
  maxReplicas: number | null
  sizes: ReadonlyArray<'s' | 'm' | 'l'>
  staging: boolean
}

export function getPublishedPlanCaps(planId: string | null | undefined): PublishedPlanCaps {
  const plan = normalizePlanId(planId) ?? 'free'
  return {
    plan,
    maxReplicas: PUBLISHED_MAX_REPLICAS[plan],
    sizes: PUBLISHED_SIZES[plan],
    staging: PUBLISHED_STAGING_ENVS[plan],
  }
}

// =============================================================================
// Chat attachment size caps (SHO-370)
// =============================================================================
//
// The agent-chat attachment limit is a plan entitlement, not a runtime setting:
// Free is held to a hard 100 MB on every attachment (archives included), while
// every paid tier — and desktop/local mode, which resolves to a paid plan — gets
// the API's 500 MB body ceiling. These are the only two numbers; the API proxy,
// the runtime and the client all read them from here.

/** Hard per-attachment cap for the free plan, in bytes. */
export const FREE_CHAT_ATTACHMENT_BYTES = 100 * 1024 * 1024

/** Per-attachment cap for paid plans (and desktop/local), in bytes. */
export const PAID_CHAT_ATTACHMENT_BYTES = 500 * 1024 * 1024

/** Per-attachment cap for a plan id. Unknown plans fall back to free. */
export function getChatAttachmentCap(planId: string | null | undefined): number {
  const plan = normalizePlanId(planId) ?? 'free'
  return plan === 'free' ? FREE_CHAT_ATTACHMENT_BYTES : PAID_CHAT_ATTACHMENT_BYTES
}

/** Per-attachment cap from a resolved paid/free entitlement. */
export function getChatAttachmentCapForPaid(paid: boolean): number {
  return paid ? PAID_CHAT_ATTACHMENT_BYTES : FREE_CHAT_ATTACHMENT_BYTES
}
