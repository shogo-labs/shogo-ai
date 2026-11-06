// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Stripe Price Configuration
 *
 * The product is on a simple per-seat ladder modeled on Cursor.com:
 *   - Basic: $8/mo single user ($78/yr), $10 of usage included.
 *   - Pro:      $20/seat/mo legacy,   $20 of usage included per seat.
 *   - Business: $16/seat/mo ($156/seat/yr), $20/seat/mo of usage included.
 * Every request is billed at provider cost * 1.20. See `usage-cost.ts` and
 * `usage-plans.ts`.
 *
 * v2.5.0 (SHO-312 Phase 5) moved Business from $40 to $16 and Basic annual
 * from $80 to $78. The old prices still exist and still resolve — they live in
 * `LEGACY_PLAN_PRICES` — because every subscription that predates the switch
 * keeps its old allowance until its next renewal moves it (see
 * `getPlanAllowance` in `usage-plans.ts`). Basic monthly is unchanged and is
 * the same price id in both maps.
 *
 * New price ids are created by `scripts/create-phase5-prices.ts` (idempotent on
 * `lookup_key`) and supplied through `STRIPE_PRICE_*` env vars, so a deploy can
 * be re-pointed without a code change. Until a v2 price id is configured,
 * `resolvePlanPriceId()` finds it by lookup key at checkout time rather than
 * silently falling back to the old (more expensive) price.
 *
 * Canonical product copy lives in `STRIPE_PRODUCT_COPY.md`. Keep these IDs
 * in sync with that file.
 */

export type PlanType = "basic" | "pro" | "business"
export type BillingInterval = "monthly" | "annual"

export interface PriceTier {
  monthly: string
  annual: string
}

export interface StripePriceConfig {
  basic: PriceTier
  pro: PriceTier
  business: PriceTier
}

/**
 * Staging (Test) environment Stripe price ids used for NEW checkouts.
 * Pro and Business are per-seat (`recurring.usage_type=licensed`,
 * checkout passes `quantity` = number of seats).
 *
 * `business.*` and `basic.annual` are the v2.5.0 prices. Their ids arrive from
 * `scripts/create-phase5-prices.ts`; an empty string means "not configured
 * here yet" and `resolvePlanPriceId()` resolves the id by lookup key instead.
 */
export const STRIPE_PRICES_STAGING: StripePriceConfig = {
  basic: {
    monthly: "price_1TRH5XAp5PDuxitp1Uqkjbcx",
    annual: envPrice("STRIPE_PRICE_BASIC_ANNUAL_V2"),
  },
  pro: {
    monthly: "price_1TRH5kAp5PDuxitpwN3MHPhD",
    annual: "price_1TRH5kAp5PDuxitpyUIn1Fh6",
  },
  business: {
    monthly: envPrice("STRIPE_PRICE_BUSINESS_MONTHLY_V2"),
    annual: envPrice("STRIPE_PRICE_BUSINESS_ANNUAL_V2"),
  },
}

/**
 * Production (Live) environment Stripe price ids used for NEW checkouts.
 * Created 2026-05-04 as part of the v1.5.0 rollout (see
 * `scripts/gate1-stripe-setup` in the release notes); the v2.5.0 Business and
 * Basic-annual ids are set from `STRIPE_PRICE_*` env vars.
 */
export const STRIPE_PRICES_PRODUCTION: StripePriceConfig = {
  basic: {
    monthly: "price_1TEdi4ADDMNd95Ggym2MWpEQ",
    annual: envPrice("STRIPE_PRICE_BASIC_ANNUAL_V2"),
  },
  pro: {
    monthly: "price_1TTIOfADDMNd95GgDyGQlaqH",
    annual: "price_1TTIOgADDMNd95GgwQGlpBLa",
  },
  business: {
    monthly: envPrice("STRIPE_PRICE_BUSINESS_MONTHLY_V2"),
    annual: envPrice("STRIPE_PRICE_BUSINESS_ANNUAL_V2"),
  },
}

/** Read a price id from the environment. `""` means "not configured". */
function envPrice(name: string): string {
  return (process.env[name] ?? "").trim()
}

/**
 * `lookup_key`s of the v2.5.0 prices. `scripts/create-phase5-prices.ts`
 * creates the prices with these keys and is idempotent on them, and
 * `resolvePlanPriceId()` falls back to a lookup by key when no static id is
 * configured for the environment.
 */
export const PLAN_PRICE_LOOKUP_KEYS = {
  basic: {
    monthly: "shogo_basic_monthly_v2",
    annual: "basic_annual_v2",
  },
  pro: {
    monthly: "shogo_pro_monthly_v2",
    annual: "shogo_pro_annual_v2",
  },
  business: {
    monthly: "business_seat_monthly_v2",
    annual: "business_seat_annual_v2",
  },
} as const satisfies StripePriceConfig

export function getStripePrices(): StripePriceConfig {
  const isProduction = process.env.NODE_ENV === "production"
  return isProduction ? STRIPE_PRICES_PRODUCTION : STRIPE_PRICES_STAGING
}

/**
 * Get the Stripe price id for a flat plan + billing interval.
 *
 * Returns `null` when the price has not been configured for this environment
 * yet (the v2.5.0 Business prices and Basic annual before
 * `scripts/create-phase5-prices.ts` has run and its ids were deployed).
 * Callers that need a usable id should use `resolvePlanPriceId()`.
 *
 * @param plan - One of `basic`, `pro`, `business`. Free is not a paid plan.
 * @param interval - `monthly` or `annual`.
 */
export function getPriceId(
  plan: PlanType,
  interval: BillingInterval
): string | null {
  const prices = getStripePrices()
  return prices[plan]?.[interval] || null
}

export function getPriceLookupKey(
  plan: PlanType,
  interval: BillingInterval
): string {
  return PLAN_PRICE_LOOKUP_KEYS[plan][interval]
}

/**
 * Resolve the price id to put on a new Checkout session.
 *
 * Prefers the statically configured id; otherwise looks the price up by
 * `lookup_key` through the supplied Stripe client (results are cached, so the
 * lookup costs one API call per environment). Returns `null` if no such price
 * exists yet — the caller must fail the checkout rather than charge the
 * legacy (higher) price.
 */
export async function resolvePlanPriceId(
  plan: PlanType,
  interval: BillingInterval,
  lookup: (lookupKey: string) => Promise<string | null>,
): Promise<string | null> {
  const configured = getPriceId(plan, interval)
  if (configured) return configured
  return lookup(getPriceLookupKey(plan, interval))
}

// =============================================================================
// LEGACY PLAN PRICES (read-only)
// =============================================================================
// The v1.5.0 flat ladder that v2.5.0 replaced:
//   - Basic $8/mo, $80/yr      ($80 annual replaced by $78)
//   - Pro   $20/seat/mo, $200  (unchanged; no longer offered at checkout)
//   - Business $40/seat/mo, $400  (replaced by $16 / $156)
//
// A subscription sitting on one of these keeps the allowance it was sold at
// (Business: $9.90/wk, $3.96/5h, $40/mo per seat) until its next renewal has
// been moved to the v2.5.0 price by `scripts/migrate-phase5-subscriptions.ts`.
// Kept in a separate map from the current prices so "is this sub still on the
// old price?" stays answerable even after the current map is re-pointed.

export const LEGACY_PLAN_PRICES: Record<"staging" | "production", StripePriceConfig> = {
  staging: {
    basic: {
      monthly: "price_1TRH5XAp5PDuxitp1Uqkjbcx",
      annual: "price_1TRH5XAp5PDuxitptfGAK6PB",
    },
    pro: {
      monthly: "price_1TRH5kAp5PDuxitpwN3MHPhD",
      annual: "price_1TRH5kAp5PDuxitpyUIn1Fh6",
    },
    business: {
      monthly: "price_1TRH5lAp5PDuxitpCRkOKz4h",
      annual: "price_1TRH5lAp5PDuxitpM51P3JNm",
    },
  },
  production: {
    basic: {
      monthly: "price_1TEdi4ADDMNd95Ggym2MWpEQ",
      annual: "price_1TEdi6ADDMNd95GgYZaoUHiQ",
    },
    pro: {
      monthly: "price_1TTIOfADDMNd95GgDyGQlaqH",
      annual: "price_1TTIOgADDMNd95GgwQGlpBLa",
    },
    business: {
      monthly: "price_1TTIOgADDMNd95Gg5DgR006y",
      annual: "price_1TTIOhADDMNd95Gg6JaJzKzZ",
    },
  },
}

function priceMapFor(label: "legacy" | "current"): StripePriceConfig {
  const env: "staging" | "production" =
    process.env.NODE_ENV === "production" ? "production" : "staging"
  return label === "legacy" ? LEGACY_PLAN_PRICES[env] : (env === "production" ? STRIPE_PRICES_PRODUCTION : STRIPE_PRICES_STAGING)
}

/**
 * True when `priceId` is one of the prices that predate v2.5.0 — i.e. the
 * subscription was sold the old allowance and must keep it until its next
 * renewal.
 *
 * `null` counts as legacy for a `business` subscription: every Business sub
 * that exists before this deploy is on $40, and the deploy→backfill gap must
 * not drop anyone to the smaller allowance. (New checkouts always write the
 * price id, so only pre-deploy rows can be `null`.)
 */
export function isLegacyPlanPriceId(
  priceId: string | null | undefined,
  opts: { plan?: PlanType; nullIsLegacy?: boolean } = {},
): boolean {
  if (!priceId) return opts.nullIsLegacy === true
  const legacy = priceMapFor("legacy")
  const current = priceMapFor("current")
  for (const plan of ["basic", "pro", "business"] as const) {
    const l = legacy[plan]
    const c = current[plan]
    if (priceId === l.monthly || priceId === l.annual) {
      // Basic monthly is the same price before and after v2.5.0 — it is not a
      // legacy allowance. Any other current+v2 match wins over the legacy map.
      if (priceId === c.monthly || priceId === c.annual) return false
      return true
    }
  }
  return false
}

/**
 * True when the price is the legacy (pre-v2.5.0) **Business** price. That is
 * the one tier whose included AI shrank, so it is the only one that keeps the
 * old allowance until it moves.
 */
export function isLegacyBusinessPriceId(priceId: string | null | undefined): boolean {
  if (!priceId) return true
  const legacy = priceMapFor("legacy").business
  const current = priceMapFor("current").business
  if (priceId === current.monthly || priceId === current.annual) return false
  return priceId === legacy.monthly || priceId === legacy.annual
}

/**
 * Map a Stripe price id to the plan it sells.
 *
 * Covers the current prices, the legacy flat ladder, and the deprecated
 * tiered ladder (`decodeLegacyPriceId`). Returns `null` for anything we do not
 * recognise — a price from another product, an instance/capacity add-on, or a
 * metered overage item.
 */
export function planFromPriceId(priceId: string | null | undefined): PlanType | null {
  if (!priceId) return null
  const current = priceMapFor("current")
  for (const plan of ["basic", "pro", "business"] as const) {
    if (priceId === current[plan].monthly || priceId === current[plan].annual) return plan
  }
  const legacy = priceMapFor("legacy")
  for (const plan of ["basic", "pro", "business"] as const) {
    if (priceId === legacy[plan].monthly || priceId === legacy[plan].annual) return plan
  }
  return decodeLegacyPriceId(priceId)?.planType ?? null
}

// =============================================================================
// LEGACY TIERED PRICES (read-only, used by migration only)
// =============================================================================
// The product previously sold 21 tiered SKUs (Basic + 10 Pro tiers + 10
// Business tiers). The maps below are kept ONLY so the migration script can
// recognize an active subscription holding a legacy price id and replace it
// with the corresponding flat per-seat price above. Do not use these for new
// checkouts.

interface LegacyPriceTier {
  monthly: string
  annual: string
}

interface LegacyTieredConfig {
  basic: Record<string, LegacyPriceTier>
  pro: Record<string, LegacyPriceTier>
  business: Record<string, LegacyPriceTier>
}

/** @deprecated Use STRIPE_PRICES_STAGING. Kept for migration only. */
export const STRIPE_LEGACY_TIER_PRICES_STAGING: LegacyTieredConfig = {
  basic: {
    "50": {
      monthly: "price_1TEdhNAp5PDuxitpqtb0329O",
      annual: "price_1TEdhPAp5PDuxitpUFOWqjLl",
    },
  },
  pro: {
    "100": { monthly: "price_1SpirrAp5PDuxitpm9Pm4z1X", annual: "price_1SpirrAp5PDuxitpUl9L3qVQ" },
    "200": { monthly: "price_1SpjBnAp5PDuxitpHis4NfbV", annual: "price_1SpjBnAp5PDuxitpvIWwgFEs" },
    "400": { monthly: "price_1SpjBpAp5PDuxitpJCtpsTna", annual: "price_1SpjBpAp5PDuxitpzzR64YDU" },
    "800": { monthly: "price_1SpjBqAp5PDuxitpgLKdfN9X", annual: "price_1SpjBrAp5PDuxitp1AD0ajTp" },
    "1200": { monthly: "price_1SpjBtAp5PDuxitpKpnISjKm", annual: "price_1SpjBtAp5PDuxitpCFOxab9E" },
    "2000": { monthly: "price_1SpjBuAp5PDuxitpipUuwvnj", annual: "price_1SpjBvAp5PDuxitpG5h8BMWg" },
    "3000": { monthly: "price_1SpjBwAp5PDuxitpi7vEYfTZ", annual: "price_1SpjBwAp5PDuxitpC9fjIC3R" },
    "5000": { monthly: "price_1SpjByAp5PDuxitpp0yzdoyB", annual: "price_1SpjByAp5PDuxitpMzlfdZPw" },
    "7500": { monthly: "price_1SpjC0Ap5PDuxitpNhn15qlw", annual: "price_1SpjC0Ap5PDuxitpF4kD9Mnp" },
    "10000": { monthly: "price_1SpjC1Ap5PDuxitppZAvufp4", annual: "price_1SpjC2Ap5PDuxitp4tr0dhqJ" },
  },
  business: {
    "100": { monthly: "price_1TCofXAp5PDuxitpVKyf2Qvk", annual: "price_1TCofXAp5PDuxitpRBUjXMYy" },
    "200": { monthly: "price_1TCofYAp5PDuxitpcEhmEpHm", annual: "price_1TCofYAp5PDuxitpbexSUYcJ" },
    "400": { monthly: "price_1TCofZAp5PDuxitptGIni7hO", annual: "price_1TCofZAp5PDuxitpOLGJFlBn" },
    "800": { monthly: "price_1TCofZAp5PDuxitpjItkTGBO", annual: "price_1TCofaAp5PDuxitpU7WA0tNk" },
    "1200": { monthly: "price_1TCofaAp5PDuxitpWoRGmm1o", annual: "price_1TCofbAp5PDuxitpy0HFmr47" },
    "2000": { monthly: "price_1TCofbAp5PDuxitpFoQFkbTs", annual: "price_1TCofbAp5PDuxitpxRGSOwmw" },
    "3000": { monthly: "price_1TCofcAp5PDuxitpkXKesyL3", annual: "price_1TCofcAp5PDuxitpmK6XRxbx" },
    "5000": { monthly: "price_1TCofdAp5PDuxitp6Gh50Qgd", annual: "price_1TCofdAp5PDuxitpLxYeFckf" },
    "7500": { monthly: "price_1TCofdAp5PDuxitplXKUEZI1", annual: "price_1TCofeAp5PDuxitp9vl4UfEw" },
    "10000": { monthly: "price_1TCofeAp5PDuxitpeCSHtymi", annual: "price_1TCoffAp5PDuxitpcjd8mHoD" },
  },
}

/** @deprecated Use STRIPE_PRICES_PRODUCTION. Kept for migration only. */
export const STRIPE_LEGACY_TIER_PRICES_PRODUCTION: LegacyTieredConfig = {
  basic: {
    "50": {
      monthly: "price_1TEdi4ADDMNd95Ggym2MWpEQ",
      annual: "price_1TEdi6ADDMNd95GgYZaoUHiQ",
    },
  },
  pro: {
    "100": { monthly: "price_1T6Ht1ADDMNd95GgzAqhbIJN", annual: "price_1T6Ht1ADDMNd95GgQYtajed3" },
    "200": { monthly: "price_1T6Ht2ADDMNd95Gg7QEN5DtS", annual: "price_1T6Ht2ADDMNd95GgueD8CeDi" },
    "400": { monthly: "price_1T6Ht2ADDMNd95GguxXoitCJ", annual: "price_1T6Ht3ADDMNd95Gg9V2yDELB" },
    "800": { monthly: "price_1T6Ht3ADDMNd95GgDjsDYHg3", annual: "price_1T6Ht3ADDMNd95Gg3JL67QTu" },
    "1200": { monthly: "price_1T6Ht4ADDMNd95GgbFWGI3gw", annual: "price_1T6Ht4ADDMNd95GgBgF3xmxZ" },
    "2000": { monthly: "price_1T6Ht5ADDMNd95GgEU7syDcX", annual: "price_1T6Ht5ADDMNd95GguMXj1iTk" },
    "3000": { monthly: "price_1T6Ht5ADDMNd95GgIBymcTvb", annual: "price_1T6Ht5ADDMNd95GgmbsYNOms" },
    "5000": { monthly: "price_1T6Ht6ADDMNd95GghPqlgO2p", annual: "price_1T6Ht6ADDMNd95GgHVDrV6JC" },
    "7500": { monthly: "price_1T6Ht6ADDMNd95GgFUj9A0tW", annual: "price_1T6Ht7ADDMNd95GgeR5Zy0YQ" },
    "10000": { monthly: "price_1T6Ht7ADDMNd95Ggq2iLjCay", annual: "price_1T6Ht7ADDMNd95Gg7d7BQwlZ" },
  },
  business: {
    "100": { monthly: "price_1TCofuADDMNd95GgosY40lHU", annual: "price_1TCofvADDMNd95Ggh5i7SgBy" },
    "200": { monthly: "price_1TCog3ADDMNd95GgrUYEU72G", annual: "price_1TCogFADDMNd95GgDVZvomnm" },
    "400": { monthly: "price_1TCogGADDMNd95Gg2KoA6wil", annual: "price_1TCogGADDMNd95GgwMjldSDl" },
    "800": { monthly: "price_1TCogGADDMNd95GgeCFnZBYO", annual: "price_1TCogHADDMNd95Gg72XoAZRM" },
    "1200": { monthly: "price_1TCogHADDMNd95Gg2VbK3x4d", annual: "price_1TCogIADDMNd95GgI5kL3q1g" },
    "2000": { monthly: "price_1TCogIADDMNd95GgJCgBrgjy", annual: "price_1TCogJADDMNd95GgnsQoFn1l" },
    "3000": { monthly: "price_1TCogJADDMNd95Ggolf50xp0", annual: "price_1TCogJADDMNd95Gg50S8Wdmg" },
    "5000": { monthly: "price_1TCogKADDMNd95GglPrqIWK8", annual: "price_1TCogKADDMNd95Gg0CT9w254" },
    "7500": { monthly: "price_1TCogKADDMNd95GgJvizgfeg", annual: "price_1TCogLADDMNd95GgnNeCD3dj" },
    "10000": { monthly: "price_1TCogLADDMNd95Gg8VpiOyTU", annual: "price_1TCogMADDMNd95GgdpAx0QoG" },
  },
}

function getLegacyTierPrices(): LegacyTieredConfig {
  return process.env.NODE_ENV === "production"
    ? STRIPE_LEGACY_TIER_PRICES_PRODUCTION
    : STRIPE_LEGACY_TIER_PRICES_STAGING
}

/**
 * Returns true if the given Stripe price id is one of the deprecated tiered
 * prices. Used by the migration script + webhook to detect legacy subs.
 */
export function isLegacyTierPriceId(priceId: string): boolean {
  const cfg = getLegacyTierPrices()
  const planMaps = [cfg.basic, cfg.pro, cfg.business]
  for (const planMap of planMaps) {
    for (const tier of Object.values(planMap) as LegacyPriceTier[]) {
      if (tier.monthly === priceId || tier.annual === priceId) return true
    }
  }
  return false
}

/**
 * Decode a legacy price id into `{ planType, tierKey, interval }`. Returns
 * null if the price id is not in the legacy maps. Used by the migration
 * script to compute the target flat plan.
 */
export function decodeLegacyPriceId(
  priceId: string
): { planType: PlanType; tierKey: string; interval: BillingInterval } | null {
  const cfg = getLegacyTierPrices()
  for (const planType of ["basic", "pro", "business"] as const) {
    const tiers = cfg[planType]
    for (const [tierKey, ids] of Object.entries(tiers)) {
      if (ids.monthly === priceId) return { planType, tierKey, interval: "monthly" }
      if (ids.annual === priceId) return { planType, tierKey, interval: "annual" }
    }
  }
  return null
}

// =============================================================================
// INSTANCE SIZE PRICES
// =============================================================================
// Create these products/prices in the Stripe dashboard before going live.
// Each paid instance size (small/medium/large/xlarge) is a separate subscription product.

export type PaidInstanceSize = "small" | "medium" | "large" | "xlarge"

export interface InstancePriceConfig {
  small: PriceTier
  medium: PriceTier
  large: PriceTier
  xlarge: PriceTier
}

export const INSTANCE_PRICES_STAGING: InstancePriceConfig = {
  small: { monthly: "price_1TJqi6Ap5PDuxitpNowm9sqG", annual: "price_1TJqiMAp5PDuxitpa8mylX4g" },
  medium: { monthly: "price_1TJqiNAp5PDuxitp4rr43sCg", annual: "price_1TJqiNAp5PDuxitpaaDpsSMR" },
  large: { monthly: "price_1TJqiOAp5PDuxitpN01Dz4qE", annual: "price_1TJqiOAp5PDuxitpFw4IrH9G" },
  xlarge: { monthly: "price_1TJqiPAp5PDuxitp9JrGz0nt", annual: "price_1TJqiPAp5PDuxitpU1U4pz6J" },
}

export const INSTANCE_PRICES_PRODUCTION: InstancePriceConfig = {
  small: { monthly: "price_instance_small_monthly_live", annual: "price_instance_small_annual_live" },
  medium: { monthly: "price_instance_medium_monthly_live", annual: "price_instance_medium_annual_live" },
  large: { monthly: "price_instance_large_monthly_live", annual: "price_instance_large_annual_live" },
  xlarge: { monthly: "price_instance_xlarge_monthly_live", annual: "price_instance_xlarge_annual_live" },
}

export function getInstancePrices(): InstancePriceConfig {
  const isProduction = process.env.NODE_ENV === "production"
  return isProduction ? INSTANCE_PRICES_PRODUCTION : INSTANCE_PRICES_STAGING
}

export function getInstancePriceId(
  size: PaidInstanceSize,
  billingInterval: BillingInterval
): string | null {
  const prices = getInstancePrices()
  return prices[size]?.[billingInterval] || null
}

// =============================================================================
// USAGE-BASED PRICING (OVERAGE)
// =============================================================================
// Marked-up usage beyond the monthly included $ amount is charged through a
// Stripe Meter (`billing.meter`) backed metered price. The Meter aggregates
// `meter_events` keyed by Stripe customer id; the metered price item attached
// to each workspace's subscription bills the resulting volume.
//
// Each meter event payload carries:
//   - stripe_customer_id  -- routes the event to the subscription
//   - value               -- non-negative integer quantity (cents @ $0.01/unit)

export interface OveragePriceConfig {
  priceId: string
  /**
   * Stripe Meter id (e.g. `mtr_test_...`). When set, overage is reported via
   * the Meter Events API; the legacy `usage_records.create` path is no longer
   * supported by Stripe API versions >= 2025-03-31.basil.
   */
  meterId: string
  /**
   * `event_name` configured on the Meter. We emit billing.meter_events with
   * this name, payload `{ stripe_customer_id, value }`.
   */
  meterEventName: string
  /**
   * Denominator for the reported value. 100 = cents (one unit = $0.01).
   */
  unitsPerDollar: number
}

export const OVERAGE_PRICE_STAGING: OveragePriceConfig = {
  priceId: "price_1TPrwgAp5PDuxitpra3BDHvR",
  meterId: "mtr_test_61UZFtwbFz7EF6Fo541Ap5PDuxitpJ5U",
  meterEventName: "usage_overage_cents",
  unitsPerDollar: 100,
}

export const OVERAGE_PRICE_PRODUCTION: OveragePriceConfig = {
  priceId: "price_1TTIP5ADDMNd95GgJ1GcpCVA",
  meterId: "mtr_61UcgM4v14tWWuwy541ADDMNd95GgJ4K",
  meterEventName: "usage_overage_cents",
  unitsPerDollar: 100,
}

/**
 * The overage price for a billing environment.
 *
 * Callers that already know their target environment must pass it: keying off
 * `NODE_ENV` alone made a `--env production` migration run from a normal shell
 * pair production plan prices with the staging metered price.
 */
export function getOveragePriceConfig(env?: "staging" | "production"): OveragePriceConfig {
  const target = env ?? (process.env.NODE_ENV === "production" ? "production" : "staging")
  return target === "production" ? OVERAGE_PRICE_PRODUCTION : OVERAGE_PRICE_STAGING
}

export function getOveragePriceId(): string {
  return getOveragePriceConfig().priceId
}
