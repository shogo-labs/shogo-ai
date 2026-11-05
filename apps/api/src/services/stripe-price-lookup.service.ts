// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Resolve the Stripe price id to use for a new Checkout session.
 *
 * `stripe-prices.ts` holds the id statically once
 * `scripts/create-phase5-prices.ts` has run and its ids are deployed. Until
 * then the price is looked up by `lookup_key` — the same key the creation
 * script is idempotent on — so a checkout can never fall back to the legacy
 * (more expensive) price just because an env var was not set yet.
 *
 * Lookups are cached per process: a price id does not change, so this costs at
 * most one Stripe call per (plan, interval) per deploy.
 */

import {
  getPriceLookupKey,
  resolvePlanPriceId,
  type BillingInterval,
  type PlanType,
} from '../config/stripe-prices'

export interface StripePriceLookupClient {
  prices: {
    list(params: {
      lookup_keys: string[]
      active?: boolean
      limit?: number
    }): Promise<{ data: Array<{ id: string }> }>
  }
}

const priceIdCache = new Map<string, string | null>()

/** @internal test-only — clear the per-process lookup cache. */
export function __resetPriceLookupCacheForTesting(): void {
  priceIdCache.clear()
}

export async function lookupPriceIdByLookupKey(
  stripe: StripePriceLookupClient,
  lookupKey: string,
): Promise<string | null> {
  if (priceIdCache.has(lookupKey)) return priceIdCache.get(lookupKey) ?? null
  try {
    const prices = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 })
    const id = prices.data?.[0]?.id ?? null
    // Cache misses too: a missing price is a deploy-ordering problem, and
    // hammering Stripe on every checkout attempt hides it.
    priceIdCache.set(lookupKey, id)
    if (!id) console.error(`[billing] no Stripe price with lookup_key "${lookupKey}"`)
    return id
  } catch (err: any) {
    console.error(`[billing] failed to look up Stripe price "${lookupKey}":`, err?.message ?? err)
    return null
  }
}

/**
 * The price id for a new Checkout session, or `null` when the v2.5.0 price has
 * not been created in this Stripe account yet. Callers must fail the checkout
 * with a clear error rather than charging the legacy price.
 */
export async function resolveCheckoutPriceId(
  stripe: StripePriceLookupClient,
  plan: PlanType,
  interval: BillingInterval,
): Promise<string | null> {
  try {
    return await resolvePlanPriceId(plan, interval, (key) =>
      lookupPriceIdByLookupKey(stripe, key),
    )
  } catch (err: any) {
    console.error('[billing] price resolution failed:', err?.message ?? err)
    return null
  }
}

export function priceLookupKeyFor(plan: PlanType, interval: BillingInterval): string {
  return getPriceLookupKey(plan, interval)
}
