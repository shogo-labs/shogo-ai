// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reconcile DB subscriptions still marked active/trialing/past_due against
 * Stripe.
 *
 * `customer.subscription.deleted` used to skip seat-plan subscriptions, so
 * subscriptions canceled in Stripe stayed `active` in the DB and kept their
 * paid tier (and overage) indefinitely. The webhook now cancels them; this
 * script fixes the rows that desynced before that.
 *
 * `subscriptions` is replicated across regions, so run it once against the
 * primary:
 *
 *   STRIPE_SECRET_KEY=sk_live_... DATABASE_URL=<us primary> bun apps/api/scripts/reconcile-subscription-status.ts
 *   ... --apply   # write the changes
 */
import Stripe from 'stripe'
import { prisma } from '../src/lib/prisma'

const APPLY = process.argv.includes('--apply')

async function main() {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('STRIPE_SECRET_KEY is required')
  const stripe = new Stripe(key)

  const rows = await prisma.subscription.findMany({
    where: { status: { in: ['active', 'trialing', 'past_due'] } },
    select: { id: true, workspaceId: true, planId: true, status: true, stripeSubscriptionId: true },
  })

  const changes: Array<{ id: string; workspaceId: string; planId: string; from: string; to: string }> = []
  for (const row of rows) {
    if (!row.stripeSubscriptionId) continue
    let stripeStatus: string
    try {
      stripeStatus = (await stripe.subscriptions.retrieve(row.stripeSubscriptionId)).status
    } catch (err: any) {
      if (err?.code !== 'resource_missing') throw err
      stripeStatus = 'canceled'
    }
    const to =
      stripeStatus === 'incomplete_expired' ? 'canceled' : stripeStatus === 'unpaid' ? 'past_due' : stripeStatus
    if (to !== row.status && ['canceled', 'past_due', 'active', 'trialing', 'paused'].includes(to)) {
      changes.push({ id: row.id, workspaceId: row.workspaceId, planId: row.planId, from: row.status, to })
    }
  }

  console.table(changes)
  console.log(`[reconcile-subs] ${rows.length} checked, ${changes.length} out of sync`)
  if (!APPLY) {
    console.log('[reconcile-subs] dry run — re-run with --apply to write these statuses.')
    return
  }
  for (const c of changes) {
    await prisma.subscription.update({
      where: { id: c.id },
      data: { status: c.to as any, ...(c.to === 'canceled' ? { cancelAtPeriodEnd: false } : {}) },
    })
  }
  console.log(`[reconcile-subs] updated ${changes.length} subscriptions`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
