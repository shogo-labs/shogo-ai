#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Create the Stripe objects the $99 Solo Founder offer needs (SHO-428).
 *
 *   bun scripts/create-solo-founder-prices.ts             # dry run, test mode
 *   bun scripts/create-solo-founder-prices.ts --apply     # create / update
 *
 * Two objects, both idempotent:
 *
 *  1. The one-time course price, `unit_amount` $21, `lookup_key`
 *     `solo_founder_course_v1`. Resolved by that lookup key at checkout
 *     (`stripe-price-lookup.service`), so the id never has to be deployed as an
 *     env var. A price with the same lookup key and amount is left alone; a
 *     price with the same key and a *different* amount is deactivated and
 *     replaced (Stripe prices are immutable).
 *
 *  2. The first-year coupon, id `solo-founder-first-year`: `amount_off` $78,
 *     `duration: 'once'`, `currency: 'usd'`. The id is fixed so the script is
 *     idempotent on retrieval.
 *
 * Offer *promo codes* (a beta cohort code that already includes the −$78) are
 * created by hand in the Stripe dashboard on a coupon whose metadata is
 * `offer: solo_founder`; the checkout only accepts codes that carry it.
 *
 * Test and live are separate runs: the script uses whichever key is in the
 * environment, and refuses to run against live without `--live`.
 */

import Stripe from 'stripe'
import { SOLO_FOUNDER_COUPON_ID, SOLO_FOUNDER_COURSE_LOOKUP_KEY } from '../apps/api/src/services/solo-founder.service'

const COURSE_PRODUCT_ID = 'solo_founder_course'
const COURSE_PRICE_USD = 21
const FIRST_YEAR_DISCOUNT_USD = 78

const apply = process.argv.includes('--apply')
const live = process.argv.includes('--live')

const key = process.env.STRIPE_SECRET_KEY
if (!key) {
  console.error('STRIPE_SECRET_KEY is not set')
  process.exit(1)
}
if (key.startsWith('sk_live_') && !live) {
  console.error('This looks like a live key. Re-run with --live to touch the live account.')
  process.exit(1)
}
if (!key.startsWith('sk_live_') && live) {
  console.error('--live was passed but the key is not a live key.')
  process.exit(1)
}

const stripe = new Stripe(key, { apiVersion: (process.env.STRIPE_API_VERSION ?? '2025-10-29.clover') as any })
const mode = key.startsWith('sk_live_') ? 'LIVE' : 'TEST'

async function ensureProduct(): Promise<string> {
  try {
    const existing = await stripe.products.retrieve(COURSE_PRODUCT_ID)
    if (!existing.active) {
      console.log(`product ${COURSE_PRODUCT_ID}: inactive, reactivating`)
      if (apply) await stripe.products.update(COURSE_PRODUCT_ID, { active: true })
    } else {
      console.log(`product ${COURSE_PRODUCT_ID}: exists`)
    }
    return COURSE_PRODUCT_ID
  } catch {
    console.log(`product ${COURSE_PRODUCT_ID}: creating`)
    if (!apply) return COURSE_PRODUCT_ID
    await stripe.products.create({
      id: COURSE_PRODUCT_ID,
      name: 'Solo Founder course',
      description: 'The Solo Founder course included in the $99 first-year offer.',
    })
    return COURSE_PRODUCT_ID
  }
}

async function ensureCoursePrice(productId: string): Promise<string | null> {
  const found = await stripe.prices.list({ lookup_keys: [SOLO_FOUNDER_COURSE_LOOKUP_KEY], active: true, limit: 10 })
  const cents = COURSE_PRICE_USD * 100
  const matching = found.data.find(
    (p) => p.unit_amount === cents && p.currency === 'usd' && p.type === 'one_time',
  )
  if (matching) {
    console.log(`price ${SOLO_FOUNDER_COURSE_LOOKUP_KEY}: exists as ${matching.id} ($${COURSE_PRICE_USD})`)
    return matching.id
  }
  for (const stale of found.data) {
    console.log(`price ${SOLO_FOUNDER_COURSE_LOOKUP_KEY}: ${stale.id} does not match $${COURSE_PRICE_USD}; deactivating`)
    if (apply) await stripe.prices.update(stale.id, { active: false })
  }
  console.log(`price ${SOLO_FOUNDER_COURSE_LOOKUP_KEY}: creating $${COURSE_PRICE_USD} one-time`)
  if (!apply) return null
  const created = await stripe.prices.create({
    product: productId,
    currency: 'usd',
    unit_amount: cents,
    lookup_key: SOLO_FOUNDER_COURSE_LOOKUP_KEY,
    nickname: 'Solo Founder course',
    metadata: { offer: 'solo_founder' },
  })
  return created.id
}

async function ensureFirstYearCoupon(): Promise<string | null> {
  const cents = FIRST_YEAR_DISCOUNT_USD * 100
  try {
    const existing = await stripe.coupons.retrieve(SOLO_FOUNDER_COUPON_ID)
    if (existing.amount_off === cents && existing.duration === 'once' && existing.currency === 'usd' && existing.valid) {
      console.log(`coupon ${SOLO_FOUNDER_COUPON_ID}: exists`)
      return existing.id
    }
    console.error(
      `coupon ${SOLO_FOUNDER_COUPON_ID} exists but does not match ($${FIRST_YEAR_DISCOUNT_USD} off once, usd). Coupons cannot be edited — delete it in Stripe and re-run.`,
    )
    return null
  } catch {
    console.log(`coupon ${SOLO_FOUNDER_COUPON_ID}: creating $${FIRST_YEAR_DISCOUNT_USD} off once`)
    if (!apply) return null
    const created = await stripe.coupons.create({
      id: SOLO_FOUNDER_COUPON_ID,
      amount_off: cents,
      currency: 'usd',
      duration: 'once',
      name: 'Solo Founder first year',
      metadata: { offer: 'solo_founder' },
    })
    return created.id
  }
}

async function main() {
  console.log(`[solo-founder] ${mode}${apply ? '' : ' (dry run — pass --apply to write)'}`)
  const productId = await ensureProduct()
  const coursePriceId = await ensureCoursePrice(productId)
  const couponId = await ensureFirstYearCoupon()
  console.log('')
  console.log('course price:', coursePriceId ?? '(would be created)')
  console.log('first-year coupon:', couponId ?? '(would be created)')
  if (!apply) console.log('\nNothing was written. Re-run with --apply.')
}

main().catch((err) => {
  console.error('[solo-founder] failed:', err?.message ?? err)
  process.exit(1)
})
