// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Verify `Subscription.firstPaidAt` against Stripe (SHO-409).
 *
 * `firstPaidAt` gates overage: a workspace whose card has never paid a real
 * invoice must not fall through to overage, because the first charge on that
 * card would be our overage block invoice. The migration backfills it for
 * active / past_due subscriptions, and `invoice.payment_succeeded` sets it from
 * then on. This script is the safety net for a rollout: it asks Stripe, per
 * customer, whether a paid invoice with `amount_paid > 0` actually exists, and
 * reports any subscription whose `firstPaidAt` disagrees.
 *
 * Usage:
 *   bun scripts/verify-subscription-first-paid.ts           # dry-run report
 *   bun scripts/verify-subscription-first-paid.ts --apply   # fix mismatches
 *
 * `--apply` only ever *sets* `firstPaidAt` (to the earliest paid invoice's
 * date) for a subscription that has a paid invoice but a null `firstPaidAt`.
 * It never clears a value: a re-subscribe on the same customer keeps the paid
 * history, and clearing would re-block a paying workspace.
 */

import { prisma } from '../apps/api/src/lib/prisma'

const APPLY = process.argv.includes('--apply')

interface PaidInvoice {
  id: string
  created: number
  amountPaid: number
}

async function main() {
  const stripeKey = process.env.STRIPE_SECRET_KEY
  if (!stripeKey) {
    console.error('[first-paid] STRIPE_SECRET_KEY is not set; cannot verify against Stripe')
    process.exit(1)
  }
  const { default: Stripe } = (await import('stripe')) as unknown as {
    default: new (key: string, opts?: unknown) => any
  }
  const stripe = new Stripe(stripeKey)

  console.log(`[first-paid] mode=${APPLY ? 'apply' : 'dry-run'}`)

  const subs = await prisma.subscription.findMany({
    where: { status: { in: ['active', 'past_due', 'trialing'] } },
    select: {
      id: true,
      workspaceId: true,
      stripeCustomerId: true,
      status: true,
      firstPaidAt: true,
    },
  })
  console.log(`[first-paid] ${subs.length} active/past_due/trialing subscription(s)`)

  // One Stripe lookup per customer, not per subscription.
  const paidByCustomer = new Map<string, PaidInvoice | null>()
  async function earliestPaidInvoice(customerId: string): Promise<PaidInvoice | null> {
    if (paidByCustomer.has(customerId)) return paidByCustomer.get(customerId)!
    let earliest: PaidInvoice | null = null
    try {
      const invoices = await stripe.invoices.list({ customer: customerId, limit: 100 })
      for (const inv of invoices.data ?? []) {
        if (inv.status !== 'paid') continue
        if (!(typeof inv.amount_paid === 'number' && inv.amount_paid > 0)) continue
        if (!earliest || inv.created < earliest.created) {
          earliest = { id: inv.id, created: inv.created, amountPaid: inv.amount_paid }
        }
      }
    } catch (err: any) {
      console.warn(`[first-paid] could not list invoices for ${customerId}:`, err?.message ?? err)
      paidByCustomer.set(customerId, null)
      return null
    }
    paidByCustomer.set(customerId, earliest)
    return earliest
  }

  let missing = 0
  let unexpected = 0
  let fixed = 0

  for (const sub of subs) {
    const paid = await earliestPaidInvoice(sub.stripeCustomerId)
    if (paid && sub.firstPaidAt == null) {
      missing++
      console.log(
        `[first-paid] MISSING  ws=${sub.workspaceId} status=${sub.status} ` +
          `customer=${sub.stripeCustomerId} paidInvoice=${paid.id} ($${(paid.amountPaid / 100).toFixed(2)})`,
      )
      if (APPLY) {
        await prisma.subscription.update({
          where: { id: sub.id },
          data: { firstPaidAt: new Date(paid.created * 1000) },
        })
        fixed++
      }
    } else if (!paid && sub.firstPaidAt != null) {
      // Not an error: the invoice may predate the 100-invoice window, or the
      // customer may have been charged on another subscription. Report only.
      unexpected++
      console.log(
        `[first-paid] NO-PAID-INVOICE  ws=${sub.workspaceId} status=${sub.status} ` +
          `customer=${sub.stripeCustomerId} firstPaidAt=${sub.firstPaidAt.toISOString()}`,
      )
    }
  }

  console.log(
    `[first-paid] done: ${missing} missing, ${unexpected} without a visible paid invoice, ` +
      `${APPLY ? `${fixed} fixed` : 'dry-run (pass --apply to fix)'}`,
  )
}

main()
  .catch((err) => {
    console.error('[first-paid] failed:', err?.message ?? err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect?.())
