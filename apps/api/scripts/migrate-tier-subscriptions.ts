// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * migrate-tier-subscriptions.ts
 *
 * One-shot migration from the legacy tiered Stripe price ladder
 * (`pro_200`, `business_1200`, ...) to the new flat per-seat plan ladder.
 *
 * Mapping:
 *   - planType is preserved (basic stays basic, pro stays pro, business
 *     stays business).
 *   - For Pro/Business, seats = workspace.memberCount (>= 1).
 *   - Basic subscriptions are forced to seats = 1.
 *   - The price item is replaced with the new flat per-seat price for the
 *     same billing interval (`STRIPE_PRICES_*[plan][interval]`).
 *   - `proration_behavior=create_prorations` so customers get a prorated
 *     credit for the difference. Since the new model bills mostly on usage,
 *     this is intentional — we want to refund the unused portion of the
 *     legacy bundled allocation.
 *
 * Usage:
 *   bun apps/api/scripts/migrate-tier-subscriptions.ts \
 *     --env staging \
 *     [--dry-run] \
 *     [--workspace-id <uuid>]
 */

import Stripe from 'stripe'
import { prisma } from '../src/lib/prisma'
import {
  STRIPE_PRICES_STAGING,
  STRIPE_PRICES_PRODUCTION,
  decodeLegacyPriceId,
  type PlanType,
  type BillingInterval,
} from '../src/config/stripe-prices'

interface Cli {
  env: 'staging' | 'production'
  dryRun: boolean
  workspaceId?: string
}

function parseArgs(argv: string[]): Cli {
  let env: Cli['env'] = 'staging'
  let dryRun = false
  let workspaceId: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--env') {
      const next = argv[++i]
      if (next !== 'staging' && next !== 'production') throw new Error(`--env must be staging|production`)
      env = next
    } else if (a === '--dry-run') {
      dryRun = true
    } else if (a === '--workspace-id') {
      workspaceId = argv[++i]
    } else if (a === '--help' || a === '-h') {
      console.log(`Usage: migrate-tier-subscriptions.ts --env staging|production [--dry-run] [--workspace-id <uuid>]`)
      process.exit(0)
    }
  }
  return { env, dryRun, workspaceId }
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
    console.error(`Refusing to run --env production without a live key.`)
    process.exit(1)
  }

  const stripe = new Stripe(apiKey, { apiVersion: '2025-09-30.clover' as Stripe.LatestApiVersion })
  const newPrices = cli.env === 'production' ? STRIPE_PRICES_PRODUCTION : STRIPE_PRICES_STAGING

  // Pull active legacy subscriptions from the DB. We look at *all* statuses
  // except canceled/incomplete_expired so the customer keeps service.
  const where: any = {
    status: { in: ['active', 'trialing', 'past_due', 'paused'] },
  }
  if (cli.workspaceId) where.workspaceId = cli.workspaceId
  const subs = await prisma.subscription.findMany({
    where,
    include: {
      workspace: {
        include: { _count: { select: { members: true } } },
      },
    },
  })

  console.log(`[migrate] Found ${subs.length} candidate subscription(s) in ${cli.env}${cli.dryRun ? ' (dry-run)' : ''}`)

  let migrated = 0
  let skipped = 0
  let failed = 0

  for (const sub of subs) {
    const wsId = sub.workspaceId
    const planId = sub.planId
    const memberCount = Math.max(1, (sub.workspace as any)?._count?.members ?? 1)

    let stripeSub: Stripe.Subscription
    try {
      stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId)
    } catch (err: any) {
      console.error(`  ✗ ${wsId}: failed to retrieve Stripe subscription ${sub.stripeSubscriptionId}: ${err.message}`)
      failed++
      continue
    }

    const item = stripeSub.items.data[0]
    if (!item) {
      console.error(`  ✗ ${wsId}: subscription has no items`)
      failed++
      continue
    }
    const currentPriceId = item.price.id

    // Decide target plan + seats. If the price id is on the legacy map we
    // honor the planType encoded there; otherwise fall back to the DB
    // `planId` (which may already be flat — those rows are no-ops).
    const legacy = decodeLegacyPriceId(currentPriceId)
    let targetPlan: PlanType
    let targetInterval: BillingInterval

    if (legacy) {
      targetPlan = legacy.planType
      targetInterval = legacy.interval
    } else {
      const flat = planId.split('_')[0] as PlanType
      if (flat !== 'basic' && flat !== 'pro' && flat !== 'business') {
        console.log(`  · ${wsId}: skipping (unknown planId ${planId}, not on legacy map)`)
        skipped++
        continue
      }
      targetPlan = flat
      targetInterval = (sub.billingInterval as BillingInterval) ?? 'monthly'
    }

    const targetPriceId = newPrices[targetPlan]?.[targetInterval]
    if (!targetPriceId) {
      console.error(`  ✗ ${wsId}: no new price configured for ${targetPlan} ${targetInterval}`)
      failed++
      continue
    }
    const targetSeats = targetPlan === 'basic' ? 1 : memberCount

    // Idempotency: if already on the new flat price + correct quantity, skip.
    if (currentPriceId === targetPriceId && (item.quantity ?? 1) === targetSeats && sub.planId === targetPlan && sub.seats === targetSeats) {
      console.log(`  ✓ ${wsId}: already on ${targetPlan} ${targetInterval} × ${targetSeats} seat(s)`)
      skipped++
      continue
    }

    console.log(`  → ${wsId}: ${planId} (${currentPriceId}) → ${targetPlan} ${targetInterval} × ${targetSeats} seat(s) (${targetPriceId})`)

    if (cli.dryRun) {
      migrated++
      continue
    }

    try {
      await stripe.subscriptions.update(stripeSub.id, {
        items: [{ id: item.id, price: targetPriceId, quantity: targetSeats }],
        proration_behavior: 'create_prorations',
        metadata: {
          ...(stripeSub.metadata ?? {}),
          workspaceId: wsId,
          planId: targetPlan,
          billingInterval: targetInterval,
          seats: String(targetSeats),
          migrated_from: planId,
          migrated_at: new Date().toISOString(),
        },
      })
      await prisma.subscription.update({
        where: { workspaceId: wsId },
        data: {
          planId: targetPlan,
          seats: targetSeats,
          billingInterval: targetInterval,
        },
      })
      migrated++
    } catch (err: any) {
      console.error(`  ✗ ${wsId}: Stripe update failed: ${err.message}`)
      failed++
    }
  }

  console.log(`[migrate] migrated=${migrated} skipped=${skipped} failed=${failed}`)
  await prisma.$disconnect()
  if (failed > 0) process.exit(2)
}

main().catch(async (err) => {
  console.error(err)
  process.exit(1)
})
