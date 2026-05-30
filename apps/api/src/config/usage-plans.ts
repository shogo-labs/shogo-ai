// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Central Usage Plan Configuration
 *
 * Single source of truth for USD usage allocations per plan. The plan ladder
 * is flat and per-seat, modeled on Cursor.com:
 *
 *   - Basic    $8/mo   single user, $5 of usage included
 *   - Pro      $20/seat/mo, $20 of usage included per seat
 *   - Business $40/seat/mo, $40 of usage included per seat
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
  basic: 5,
  pro: 20,
  business: 40,
  enterprise: 2000,
} as const

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
 * ── How the window limits are sized (don't-lose-money math) ──────────────
 *
 * Windows count *marked-up* USD (`billedUsd = providerRawCost × MARKUP`,
 * MARKUP = 1.20). Included usage is covered by the subscription — we don't
 * charge per unit inside a window — so our real cost for a maxed window is the
 * underlying provider COGS = `markedUp / MARKUP`.
 *
 * Worst case is a user who pins their windows continuously for a whole month.
 * Their monthly provider COGS is:
 *
 *     monthlyCogsRaw = weeklyUsd × WEEKS_PER_MONTH / MARKUP
 *
 * We size `weeklyUsd` so that this worst case stays at or below
 * `TARGET_COMPUTE_COST_RATIO` of the *list* monthly subscription price,
 * leaving headroom for the ~17% annual discount, ~3% payment fees, infra and
 * margin. Solving for the cap:
 *
 *     weeklyUsd ≤ TARGET_COMPUTE_COST_RATIO × monthlyPrice × MARKUP / WEEKS_PER_MONTH
 *
 * At MARKUP 1.20, ratio 0.75, prices basic $8 / pro $20 / business $40 the
 * caps are ≈ $1.66 / $4.14 / $8.28 per seat; the values below round *down* to
 * clean figures (worst-case COGS lands ≈72.5% of list / ≈87% of annual
 * revenue). 5-hour windows are sized at 40% of the weekly budget so a single
 * burst can't drain the whole week. `null` = uncapped (enterprise). Values are
 * intended to be tuned operationally — see `TARGET_COMPUTE_COST_RATIO`.
 */
export const TARGET_COMPUTE_COST_RATIO = 0.75

/**
 * Per-window included USD-of-compute per plan. Within these windows usage is
 * effectively unlimited (no finite monthly pool is drained); when a window is
 * exhausted, usage falls through to metered overage (if enabled) and otherwise
 * blocks until the window's `resetsAt`.
 *
 * `null` means uncapped (truly unlimited) — used by enterprise.
 *
 * For per-seat plans (`pro`, `business`) the limits below are *per seat* and
 * are multiplied by the seat count in `getWindowLimitsForPlan`. `free` and
 * `basic` are single-pool (not scaled by seats). `free` is a deliberate
 * loss-leader (no revenue) capped small.
 *
 * Values are USD of marked-up compute (see `usage-cost.ts`). See the block
 * comment above for the don't-lose-money derivation.
 */
export const ROLLING_WINDOW_LIMITS: Record<
  PlanId,
  { fiveHourUsd: number; weeklyUsd: number } | null
> = {
  free: { fiveHourUsd: 0.2, weeklyUsd: 0.5 },
  basic: { fiveHourUsd: 0.64, weeklyUsd: 1.6 },
  pro: { fiveHourUsd: 1.6, weeklyUsd: 4 },
  business: { fiveHourUsd: 3.2, weeklyUsd: 8 },
  enterprise: null,
}

/** Plans whose window limits scale linearly with the paid seat count. */
const PER_SEAT_WINDOW_PLANS: ReadonlySet<PlanId> = new Set<PlanId>(['pro', 'business'])

export interface WindowLimits {
  fiveHourUsd: number
  weeklyUsd: number
}

/**
 * Resolve the rolling-window limits for a (plan, seats) tuple.
 *
 * - Returns `null` for uncapped plans (enterprise) — callers treat `null`
 *   as "unlimited, no window enforcement".
 * - Per-seat plans (`pro`, `business`) multiply the per-seat limits by
 *   `max(1, seats)`. Single-pool plans (`free`, `basic`) ignore seats.
 * - Unknown / unrecognized plan ids fall back to the `free` limits so a
 *   brand-new workspace whose plan hasn't resolved still gets the safety-net
 *   window.
 */
export function getWindowLimitsForPlan(
  planId: string | null | undefined,
  seats: number = 1,
): WindowLimits | null {
  const normalized = normalizePlanId(planId) ?? 'free'
  const base = ROLLING_WINDOW_LIMITS[normalized]
  if (base == null) return null
  if (!PER_SEAT_WINDOW_PLANS.has(normalized)) {
    return { fiveHourUsd: base.fiveHourUsd, weeklyUsd: base.weeklyUsd }
  }
  const safeSeats = Math.max(1, Math.floor(seats || 1))
  return {
    fiveHourUsd: base.fiveHourUsd * safeSeats,
    weeklyUsd: base.weeklyUsd * safeSeats,
  }
}

/**
 * Effective monthly included usage (marked-up USD) implied by the weekly
 * rolling window for a (plan, seats) tuple. The weekly window is the binding
 * monthly constraint, so for back-to-back windows the monthly ceiling is
 * `weeklyUsd × WEEKS_PER_MONTH`.
 *
 * This is the *upper bound* of included usage assuming continuous use — pausing
 * pushes each window's reset later, fitting fewer full weekly buckets per
 * month. It is the included/unlimited zone only; usage beyond it falls through
 * to metered overage. Returns `null` for uncapped plans (enterprise).
 *
 * Intended for internal/finance/admin surfaces — the customer UI shows usage
 * relative to the window (utilization %), not this dollar figure.
 */
export function getMonthlyIncludedEquivalent(
  planId: string | null | undefined,
  seats: number = 1,
): number | null {
  const limits = getWindowLimitsForPlan(planId, seats)
  if (limits == null) return null
  return limits.weeklyUsd * WEEKS_PER_MONTH
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
