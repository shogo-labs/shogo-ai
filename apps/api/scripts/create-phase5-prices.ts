// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * create-phase5-prices.ts
 *
 * Create the v2.5.0 plan prices in Stripe (SHO-339 / SHO-312 Phase 5):
 *
 *   - Business  $16 / seat / month   (licensed, per-seat)   business_seat_monthly_v2
 *   - Business  $156 / seat / year   (licensed, per-seat)   business_seat_annual_v2
 *   - Basic     $78 / year           (licensed, 1 seat)     basic_annual_v2
 *
 * Basic monthly ($8) is unchanged and is NOT touched — it keeps
 * `price_1TEdi4…` (live) / `price_1TRH5X…` (test).
 *
 * Idempotent on `lookup_key`: re-running finds the existing price instead of
 * creating a duplicate, and prints the id to put in the environment.
 *
 * Creating a price is inert until a checkout or the subscription migration uses
 * it, so this is safe to run before the PR merges.
 *
 * Usage:
 *   bun apps/api/scripts/create-phase5-prices.ts --env staging [--dry-run]
 *   bun apps/api/scripts/create-phase5-prices.ts --env production --apply
 *
 * The live run needs a human yes (see the card's Q4); `--apply` is required for
 * `--env production` so a stray invocation cannot create live prices.
 */

import Stripe from 'stripe'

interface Cli {
  env: 'staging' | 'production'
  apply: boolean
  dryRun: boolean
}

interface DesiredPrice {
  plan: 'basic' | 'business'
  lookupKey: string
  nickname: string
  /** Amount in the smallest currency unit. */
  unitAmount: number
  interval: 'month' | 'year'
  perSeat: boolean
  /** Env var the deploy reads the created id from. */
  envVar: string
}

export const PHASE5_PRICES: DesiredPrice[] = [
  {
    plan: 'business',
    lookupKey: 'business_seat_monthly_v2',
    nickname: 'Business (monthly per seat)',
    unitAmount: 1600,
    interval: 'month',
    perSeat: true,
    envVar: 'STRIPE_PRICE_BUSINESS_MONTHLY_V2',
  },
  {
    plan: 'business',
    lookupKey: 'business_seat_annual_v2',
    nickname: 'Business (annual per seat)',
    unitAmount: 15600,
    interval: 'year',
    perSeat: true,
    envVar: 'STRIPE_PRICE_BUSINESS_ANNUAL_V2',
  },
  {
    plan: 'basic',
    lookupKey: 'basic_annual_v2',
    nickname: 'Basic (annual)',
    unitAmount: 7800,
    interval: 'year',
    perSeat: false,
    envVar: 'STRIPE_PRICE_BASIC_ANNUAL_V2',
  },
]

/** Product ids that own the prices, per environment. */
export const PHASE5_PRODUCTS: Record<Cli['env'], { basic: string; business: string }> = {
  staging: {
    basic: 'prod_UD3oRbXK7sLA8p',
    business: 'prod_TnJUouAXCoO5ke',
  },
  production: {
    basic: 'prod_UD3pguoX3NJ9Q6',
    business: 'prod_U4QkWE1XUGKOvb',
  },
}

function parseArgs(argv: string[]): Cli {
  let env: Cli['env'] = 'staging'
  let apply = false
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--env') {
      const next = argv[++i]
      if (next !== 'staging' && next !== 'production') throw new Error('--env must be staging|production')
      env = next
    } else if (a === '--apply') {
      apply = true
    } else if (a === '--dry-run') {
      dryRun = true
    } else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: create-phase5-prices.ts --env staging|production [--dry-run] [--apply]',
      )
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${a}`)
    }
  }
  return { env, apply: apply && !dryRun, dryRun }
}

interface PriceLookup {
  prices: {
    list(params: {
      lookup_keys?: string[]
      limit?: number
      expand?: string[]
    }): Promise<{ data: Stripe.Price[] }>
    create(params: Stripe.PriceCreateParams): Promise<Stripe.Price>
  }
}

export interface CreatePricesResult {
  lookupKey: string
  priceId: string
  created: boolean
  amount: number
  interval: string
}

/**
 * Ensure every desired price exists. Pure over the Stripe client, so the unit
 * tests drive it with a fake.
 */
export async function ensurePhase5Prices(
  stripe: PriceLookup,
  opts: { env: Cli['env']; dryRun: boolean },
): Promise<CreatePricesResult[]> {
  const products = PHASE5_PRODUCTS[opts.env]
  const results: CreatePricesResult[] = []

  for (const desired of PHASE5_PRICES) {
    const existing = await stripe.prices.list({ lookup_keys: [desired.lookupKey], limit: 1 })
    const found = existing.data?.[0]
    if (found) {
      results.push({
        lookupKey: desired.lookupKey,
        priceId: found.id,
        created: false,
        amount: found.unit_amount ?? desired.unitAmount,
        interval: found.recurring?.interval ?? desired.interval,
      })
      continue
    }
    if (opts.dryRun) {
      results.push({
        lookupKey: desired.lookupKey,
        priceId: '(would create)',
        created: false,
        amount: desired.unitAmount,
        interval: desired.interval,
      })
      continue
    }
    const created = await stripe.prices.create({
      product: products[desired.plan],
      currency: 'usd',
      unit_amount: desired.unitAmount,
      recurring: { interval: desired.interval, usage_type: 'licensed' },
      lookup_key: desired.lookupKey,
      nickname: desired.nickname,
      transfer_lookup_key: true,
      metadata: {
        plan: desired.plan,
        interval: desired.interval,
        per_seat: String(desired.perSeat),
        price_phase: 'v2.5.0',
      },
    })
    results.push({
      lookupKey: desired.lookupKey,
      priceId: created.id,
      created: true,
      amount: desired.unitAmount,
      interval: desired.interval,
    })
  }

  return results
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
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
    console.error('Refusing to run --env production without a live key.')
    process.exit(1)
  }
  if (cli.env === 'production' && !cli.apply) {
    console.error(
      'Refusing to create LIVE prices without --apply (Russell must approve live writes; see SHO-339 Q4).\n' +
        'Run with --dry-run to preview, then --apply once approved.',
    )
    process.exit(1)
  }

  const stripe = new Stripe(apiKey, { apiVersion: '2025-09-30.clover' as Stripe.LatestApiVersion })
  const results = await ensurePhase5Prices(stripe as unknown as PriceLookup, {
    env: cli.env,
    dryRun: cli.dryRun,
  })

  console.log(`\n[phase5-prices] ${cli.env}${cli.dryRun ? ' (dry-run)' : ''}\n`)
  for (const r of results) {
    const flag = r.created ? 'created' : cli.dryRun ? 'would create' : 'exists'
    console.log(`  ${r.lookupKey.padEnd(28)} ${formatUsd(r.amount).padStart(10)} / ${r.interval.padEnd(5)}  ${r.priceId.padEnd(32)} ${flag}`)
  }

  const envLines = results
    .map((r, i) => `${PHASE5_PRICES[i].envVar}=${r.priceId}`)
    .join('\n')
  console.log('\nDeploy these (set them in the environment, do not commit them):\n')
  console.log(envLines)
  console.log('')
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
