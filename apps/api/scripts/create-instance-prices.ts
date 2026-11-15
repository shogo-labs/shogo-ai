// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * create-instance-prices.ts
 *
 * Create the paid instance-size prices in Stripe:
 *
 *   Small   $15 / mo   $150 / yr   instance_small_monthly  / instance_small_annual
 *   Medium  $40 / mo   $400 / yr   instance_medium_monthly / instance_medium_annual
 *   Large   $80 / mo   $800 / yr   instance_large_monthly  / instance_large_annual
 *   XLarge  $150 / mo  $1500 / yr  instance_xlarge_monthly / instance_xlarge_annual
 *
 * Amounts mirror `INSTANCE_SIZES[*].baseCostMonthly/baseCostAnnual` in
 * `apps/api/src/config/instance-sizes.ts` and the staging prices.
 *
 * Idempotent on `lookup_key`: re-running finds the existing price instead of
 * creating a duplicate. Creating a price is inert until a checkout uses it.
 *
 * Production never had these prices, so `INSTANCE_PRICES_PRODUCTION` held
 * placeholder strings and every upgrade failed with
 * `No such price: 'price_instance_large_monthly_live'`. Run this against the
 * live account, then put the printed ids in `INSTANCE_PRICES_PRODUCTION` (or
 * leave them empty — `resolveInstancePriceId()` finds them by lookup key).
 *
 * Usage:
 *   bun apps/api/scripts/create-instance-prices.ts --env staging [--dry-run]
 *   bun apps/api/scripts/create-instance-prices.ts --env production --apply
 */

import Stripe from 'stripe'

interface Cli {
  env: 'staging' | 'production'
  apply: boolean
  dryRun: boolean
}

export interface DesiredInstancePrice {
  size: 'small' | 'medium' | 'large' | 'xlarge'
  label: string
  lookupKey: string
  unitAmount: number
  interval: 'month' | 'year'
}

export const INSTANCE_PRICES: DesiredInstancePrice[] = [
  { size: 'small', label: 'Small', lookupKey: 'instance_small_monthly', unitAmount: 1500, interval: 'month' },
  { size: 'small', label: 'Small', lookupKey: 'instance_small_annual', unitAmount: 15000, interval: 'year' },
  { size: 'medium', label: 'Medium', lookupKey: 'instance_medium_monthly', unitAmount: 4000, interval: 'month' },
  { size: 'medium', label: 'Medium', lookupKey: 'instance_medium_annual', unitAmount: 40000, interval: 'year' },
  { size: 'large', label: 'Large', lookupKey: 'instance_large_monthly', unitAmount: 8000, interval: 'month' },
  { size: 'large', label: 'Large', lookupKey: 'instance_large_annual', unitAmount: 80000, interval: 'year' },
  { size: 'xlarge', label: 'XLarge', lookupKey: 'instance_xlarge_monthly', unitAmount: 15000, interval: 'month' },
  { size: 'xlarge', label: 'XLarge', lookupKey: 'instance_xlarge_annual', unitAmount: 150000, interval: 'year' },
]

export function productNameFor(label: string): string {
  return `Instance Size: ${label}`
}

function parseArgs(argv: string[]): Cli {
  const env = argv.includes('--env') ? argv[argv.indexOf('--env') + 1] : 'staging'
  if (env !== 'staging' && env !== 'production') throw new Error(`unknown --env ${env}`)
  return { env, apply: argv.includes('--apply'), dryRun: argv.includes('--dry-run') }
}

async function main() {
  const cli = parseArgs(process.argv.slice(2))
  if (cli.env === 'production' && !cli.apply) {
    throw new Error('refusing to touch the live account without --apply')
  }
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set')
  const stripe = new Stripe(key)

  const products = await stripe.products.list({ limit: 100 })
  const byName = new Map(products.data.map((p) => [p.name, p]))

  for (const want of INSTANCE_PRICES) {
    const existing = await stripe.prices.list({ lookup_keys: [want.lookupKey], limit: 1 })
    if (existing.data[0]) {
      console.log(`exists  ${want.lookupKey} -> ${existing.data[0].id}`)
      continue
    }
    if (cli.dryRun) {
      console.log(`would create ${want.lookupKey} (${want.unitAmount} / ${want.interval})`)
      continue
    }
    const name = productNameFor(want.label)
    let product = byName.get(name)
    if (!product) {
      product = await stripe.products.create({
        name,
        description: `Shogo project instance size: ${want.label}`,
      })
      byName.set(name, product)
      console.log(`created product ${product.id} (${name})`)
    }
    const price = await stripe.prices.create({
      product: product.id,
      currency: 'usd',
      unit_amount: want.unitAmount,
      recurring: { interval: want.interval },
      lookup_key: want.lookupKey,
      nickname: `Instance ${want.label} (${want.interval}ly)`,
    })
    console.log(`created ${want.lookupKey} -> ${price.id}`)
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err?.message ?? err)
    process.exit(1)
  })
}
