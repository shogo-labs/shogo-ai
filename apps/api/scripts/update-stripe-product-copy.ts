// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * update-stripe-product-copy.ts
 *
 * Idempotently sync product names, descriptions, and metadata in Stripe to
 * match the canonical copy in `src/config/STRIPE_PRODUCT_COPY.md`. Uses the
 * Stripe Node SDK directly so it can be run from CI or locally.
 *
 * Usage:
 *   bun apps/api/scripts/update-stripe-product-copy.ts \
 *     --env staging \
 *     [--dry-run]
 *
 * Notes:
 *   - The product IDs are sourced from `stripe-prices.ts` (staging) or the
 *     STRIPE_LIVE_*_PRODUCT_ID env vars (production).
 *   - Re-running the script is a no-op when Stripe already matches.
 *   - The script does NOT create products or prices — those are one-shot
 *     CLI operations recorded in STRIPE_PRODUCT_COPY.md.
 */

import Stripe from 'stripe'

interface ProductCopy {
  id: string
  name: string
  description: string
  metadata: Record<string, string>
}

interface PriceCopy {
  /** Stripe price id (used to look up the price). */
  id: string
  /** Human-friendly nickname shown in the Stripe Dashboard. */
  nickname: string
  metadata: Record<string, string>
  /** Optional lookup_key to set/keep in sync. */
  lookupKey?: string
}

const STAGING_PRODUCTS: ProductCopy[] = [
  {
    id: 'prod_UD3oRbXK7sLA8p',
    name: 'Shogo Basic',
    description: '$5 of monthly AI usage + $0.50/day. All usage billed at raw provider cost plus a flat 20% markup. Single user — no seats. No credits, no unit conversions.',
    metadata: { plan: 'basic', included_usd: '5', per_seat: 'false', markup: '0.20' },
  },
  {
    id: 'prod_TnJUJPgKdcWPUD',
    name: 'Shogo Pro',
    description: "Includes $20 of AI usage per seat per month. Every request billed at the AI provider's raw cost plus a flat 20% markup. Opt-in usage-based overage with a hard cap. No credits, no unit conversions.",
    metadata: { plan: 'pro', included_usd_per_seat: '20', per_seat: 'true', markup: '0.20' },
  },
  {
    id: 'prod_TnJUouAXCoO5ke',
    name: 'Shogo Business',
    description: "Includes $40 of AI usage per seat per month. Team analytics, SSO, audit logs, per-member spending limits. Every request billed at the AI provider's raw cost plus a flat 20% markup. No credits, no unit conversions.",
    metadata: { plan: 'business', included_usd_per_seat: '40', per_seat: 'true', markup: '0.20' },
  },
  {
    id: 'prod_UOfGeWglG4weLp',
    name: 'Shogo Usage Overage',
    description: "Metered overage beyond your plan's included monthly usage. Charged at provider cost + 20% with an optional hard cap.",
    metadata: { purpose: 'usage_overage', currency: 'usd', markup: '0.20' },
  },
]

const STAGING_PRICES: PriceCopy[] = [
  { id: 'price_1TRH5XAp5PDuxitp1Uqkjbcx', nickname: 'Basic (monthly)',                lookupKey: 'shogo_basic_monthly_v2',    metadata: { plan: 'basic',    interval: 'monthly', included_usd: '5',  per_seat: 'false' } },
  { id: 'price_1TRH5XAp5PDuxitptfGAK6PB', nickname: 'Basic (annual)',                 lookupKey: 'shogo_basic_annual_v2',     metadata: { plan: 'basic',    interval: 'annual',  included_usd: '5',  per_seat: 'false' } },
  { id: 'price_1TRH5kAp5PDuxitpwN3MHPhD', nickname: 'Pro (monthly per seat)',         lookupKey: 'shogo_pro_monthly_v2',      metadata: { plan: 'pro',      interval: 'monthly', included_usd_per_seat: '20', per_seat: 'true' } },
  { id: 'price_1TRH5kAp5PDuxitpyUIn1Fh6', nickname: 'Pro (annual per seat)',          lookupKey: 'shogo_pro_annual_v2',       metadata: { plan: 'pro',      interval: 'annual',  included_usd_per_seat: '20', per_seat: 'true' } },
  { id: 'price_1TRH5lAp5PDuxitpCRkOKz4h', nickname: 'Business (monthly per seat)',    lookupKey: 'shogo_business_monthly_v2', metadata: { plan: 'business', interval: 'monthly', included_usd_per_seat: '40', per_seat: 'true' } },
  { id: 'price_1TRH5lAp5PDuxitpM51P3JNm', nickname: 'Business (annual per seat)',     lookupKey: 'shogo_business_annual_v2',  metadata: { plan: 'business', interval: 'annual',  included_usd_per_seat: '40', per_seat: 'true' } },
]

const PRODUCTION_PRODUCTS: ProductCopy[] = [
  {
    id: 'prod_UD3pguoX3NJ9Q6',
    name: 'Shogo Basic',
    description: '$5 of monthly AI usage + $0.50/day. All usage billed at raw provider cost plus a flat 20% markup. Single user — no seats. No credits, no unit conversions.',
    metadata: { plan: 'basic', included_usd: '5', per_seat: 'false', markup: '0.20' },
  },
  {
    id: 'prod_U4QkVZtCUtKWOw',
    name: 'Shogo Pro',
    description: "Includes $20 of AI usage per seat per month. Every request billed at the AI provider's raw cost plus a flat 20% markup. Opt-in usage-based overage with a hard cap. No credits, no unit conversions.",
    metadata: { plan: 'pro', included_usd_per_seat: '20', per_seat: 'true', markup: '0.20' },
  },
  {
    id: 'prod_U4QkWE1XUGKOvb',
    name: 'Shogo Business',
    description: "Includes $40 of AI usage per seat per month. Team analytics, SSO, audit logs, per-member spending limits. Every request billed at the AI provider's raw cost plus a flat 20% markup. No credits, no unit conversions.",
    metadata: { plan: 'business', included_usd_per_seat: '40', per_seat: 'true', markup: '0.20' },
  },
  {
    id: 'prod_USCo7QeG0HkY8s',
    name: 'Shogo Usage Overage',
    description: "Metered overage beyond your plan's included monthly usage. Charged at provider cost + 20% with an optional hard cap.",
    metadata: { purpose: 'usage_overage', currency: 'usd', markup: '0.20' },
  },
]

const PRODUCTION_PRICES: PriceCopy[] = [
  { id: 'price_1TEdi4ADDMNd95Ggym2MWpEQ', nickname: 'Basic (monthly)',                lookupKey: 'shogo_basic_monthly_v2',    metadata: { plan: 'basic',    interval: 'monthly', included_usd: '5',  per_seat: 'false' } },
  { id: 'price_1TEdi6ADDMNd95GgYZaoUHiQ', nickname: 'Basic (annual)',                 lookupKey: 'shogo_basic_annual_v2',     metadata: { plan: 'basic',    interval: 'annual',  included_usd: '5',  per_seat: 'false' } },
  { id: 'price_1TTIOfADDMNd95GgDyGQlaqH', nickname: 'Pro (monthly per seat)',         lookupKey: 'shogo_pro_monthly_v2',      metadata: { plan: 'pro',      interval: 'monthly', included_usd_per_seat: '20', per_seat: 'true' } },
  { id: 'price_1TTIOgADDMNd95GgwQGlpBLa', nickname: 'Pro (annual per seat)',          lookupKey: 'shogo_pro_annual_v2',       metadata: { plan: 'pro',      interval: 'annual',  included_usd_per_seat: '20', per_seat: 'true' } },
  { id: 'price_1TTIOgADDMNd95Gg5DgR006y', nickname: 'Business (monthly per seat)',    lookupKey: 'shogo_business_monthly_v2', metadata: { plan: 'business', interval: 'monthly', included_usd_per_seat: '40', per_seat: 'true' } },
  { id: 'price_1TTIOhADDMNd95Gg6JaJzKzZ', nickname: 'Business (annual per seat)',     lookupKey: 'shogo_business_annual_v2',  metadata: { plan: 'business', interval: 'annual',  included_usd_per_seat: '40', per_seat: 'true' } },
]

interface Cli {
  env: 'staging' | 'production'
  dryRun: boolean
}

function parseArgs(argv: string[]): Cli {
  let env: Cli['env'] = 'staging'
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--env') {
      const next = argv[++i]
      if (next !== 'staging' && next !== 'production') {
        throw new Error(`--env must be 'staging' or 'production', got: ${next}`)
      }
      env = next
    } else if (a === '--dry-run') {
      dryRun = true
    } else if (a === '--help' || a === '-h') {
      console.log(`Usage: update-stripe-product-copy.ts --env staging|production [--dry-run]`)
      process.exit(0)
    }
  }
  return { env, dryRun }
}

function shallowEqual(a: Record<string, string> | null, b: Record<string, string>): boolean {
  if (!a) return false
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length < bKeys.length) return false
  for (const k of bKeys) {
    if (a[k] !== b[k]) return false
  }
  return true
}

async function main() {
  const cli = parseArgs(process.argv.slice(2))

  const apiKey = process.env.STRIPE_SECRET_KEY
  if (!apiKey) {
    console.error('STRIPE_SECRET_KEY not set in environment.')
    process.exit(1)
  }
  if (cli.env === 'staging' && !apiKey.startsWith('sk_test_')) {
    console.error(`Refusing to run --env staging with a non-test key (${apiKey.slice(0, 8)}...).`)
    process.exit(1)
  }
  if (cli.env === 'production' && !apiKey.startsWith('sk_live_')) {
    console.error(`Refusing to run --env production with a non-live key (${apiKey.slice(0, 8)}...).`)
    process.exit(1)
  }

  const stripe = new Stripe(apiKey, { apiVersion: '2025-09-30.clover' as Stripe.LatestApiVersion })
  const products = cli.env === 'production' ? PRODUCTION_PRODUCTS : STAGING_PRODUCTS
  const prices = cli.env === 'production' ? PRODUCTION_PRICES : STAGING_PRICES

  console.log(`[stripe-copy] Syncing ${products.length} products and ${prices.length} prices in ${cli.env}${cli.dryRun ? ' (dry-run)' : ''}`)

  for (const wanted of products) {
    const current = await stripe.products.retrieve(wanted.id)
    const nameDiff = current.name !== wanted.name
    const descDiff = current.description !== wanted.description
    const metaDiff = !shallowEqual(current.metadata, wanted.metadata)
    if (!nameDiff && !descDiff && !metaDiff) {
      console.log(`  ✓ product ${wanted.id} (${wanted.name}) already up to date`)
      continue
    }
    console.log(`  → product ${wanted.id} (${wanted.name}): name=${nameDiff} desc=${descDiff} meta=${metaDiff}`)
    if (!cli.dryRun) {
      await stripe.products.update(wanted.id, {
        name: wanted.name,
        description: wanted.description,
        metadata: wanted.metadata,
      })
    }
  }

  for (const wanted of prices) {
    const current = await stripe.prices.retrieve(wanted.id)
    const nickDiff = current.nickname !== wanted.nickname
    const metaDiff = !shallowEqual(current.metadata, wanted.metadata)
    const keyDiff = !!wanted.lookupKey && current.lookup_key !== wanted.lookupKey
    if (!nickDiff && !metaDiff && !keyDiff) {
      console.log(`  ✓ price ${wanted.id} (${wanted.nickname}) already up to date`)
      continue
    }
    console.log(`  → price ${wanted.id} (${wanted.nickname}): nickname=${nickDiff} meta=${metaDiff} lookup_key=${keyDiff}`)
    if (!cli.dryRun) {
      await stripe.prices.update(wanted.id, {
        nickname: wanted.nickname,
        metadata: wanted.metadata,
        ...(wanted.lookupKey ? { lookup_key: wanted.lookupKey, transfer_lookup_key: true } : {}),
      })
    }
  }

  console.log(`[stripe-copy] Done.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
