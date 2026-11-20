#!/usr/bin/env bun
/**
 * Create the Stripe prices for learn.shogo.ai courses sold on their own.
 *
 *   bun scripts/create-learn-course-prices.ts             # dry run, test mode
 *   bun scripts/create-learn-course-prices.ts --apply     # create / update
 *
 * One product + one one-time price per `standalone` offer in
 * `apps/api/src/config/learn-catalog.ts`. The checkout resolves the price by
 * its `lookup_key`, so no ids are deployed. A price with the same lookup key
 * and amount is left alone; one with a different amount is deactivated and
 * replaced (Stripe prices are immutable).
 *
 * Test and live are separate runs: the script uses whichever key is in the
 * environment, and refuses to run against live without `--live`.
 */

import Stripe from 'stripe'
import { LEARN_COURSES, type LearnStandaloneOffer } from '../apps/api/src/config/learn-catalog'

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

const offers: LearnStandaloneOffer[] = LEARN_COURSES.flatMap((c) =>
  c.access.kind === 'plan' && c.access.standalone ? [c.access.standalone] : [],
)

function productId(offer: LearnStandaloneOffer): string {
  return `learn_course_${offer.courseId.replace(/-/g, '_')}`
}

async function ensureProduct(offer: LearnStandaloneOffer): Promise<string> {
  const id = productId(offer)
  try {
    const existing = await stripe.products.retrieve(id)
    if (!existing.active || existing.name !== offer.title) {
      console.log(`product ${id}: updating (active, name "${offer.title}")`)
      if (apply) await stripe.products.update(id, { active: true, name: offer.title })
    } else {
      console.log(`product ${id}: exists`)
    }
  } catch {
    console.log(`product ${id}: creating "${offer.title}"`)
    if (apply) {
      await stripe.products.create({
        id,
        name: offer.title,
        description: `Lifetime access to "${offer.title}" on learn.shogo.ai.`,
        metadata: { offer: 'learn_course', learnCourseId: offer.courseId },
      })
    }
  }
  return id
}

async function ensurePrice(offer: LearnStandaloneOffer, product: string): Promise<void> {
  const cents = offer.priceUsd * 100
  const found = await stripe.prices.list({ lookup_keys: [offer.lookupKey], active: true, limit: 10 })
  const matching = found.data.find((p) => p.unit_amount === cents && p.currency === 'usd' && p.type === 'one_time')
  if (matching) {
    console.log(`price ${offer.lookupKey}: exists as ${matching.id} ($${offer.priceUsd})`)
    return
  }
  for (const stale of found.data) {
    console.log(`price ${offer.lookupKey}: ${stale.id} does not match $${offer.priceUsd}; deactivating`)
    if (apply) await stripe.prices.update(stale.id, { active: false })
  }
  console.log(`price ${offer.lookupKey}: creating $${offer.priceUsd} one-time`)
  if (!apply) return
  const created = await stripe.prices.create({
    product,
    currency: 'usd',
    unit_amount: cents,
    lookup_key: offer.lookupKey,
    transfer_lookup_key: true,
    nickname: offer.title,
    metadata: { offer: 'learn_course', learnCourseId: offer.courseId },
  })
  console.log(`price ${offer.lookupKey}: created ${created.id}`)
}

console.log(`${mode} mode, ${apply ? 'APPLY' : 'dry run'}; ${offers.length} course(s)`)
for (const offer of offers) {
  const product = await ensureProduct(offer)
  await ensurePrice(offer, product)
}
