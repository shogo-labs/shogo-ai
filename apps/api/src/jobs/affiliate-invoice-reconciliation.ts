// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Daily reconciliation cron for the native MLM affiliate program.
 *
 * Stripe webhooks are reliable but not perfect — delivery can fail
 * because of network blips, our pod dying mid-handler, or a bad deploy
 * landing during a payment spike. The commission engine itself is
 * idempotent on the `(invoice, affiliate, level)` unique key, so we
 * can safely re-run `recordCommissionsForInvoice` for any invoice we
 * might have missed without doubling commissions.
 *
 * This job lists Stripe invoices paid in a sliding 7-day window and
 * pushes each one through the commission engine. Operations that
 * already wrote rows return 0 changes; operations that missed the
 * webhook get caught up.
 *
 * Wrapped in `withGlobalJobLock('affiliate-invoice-reconciliation')`
 * so only one region runs per tick — the same multiregion safety
 * pattern as the other globally-aggregating crons.
 */

import Stripe from 'stripe'

import { withGlobalJobLock } from '../lib/global-job-lock'
import * as affiliateService from '../services/affiliate.service'

export interface AffiliateReconciliationSummary {
  /** Total invoices the reconciliation walk inspected. */
  invoicesScanned: number
  /** New commission rows written across all walked invoices. */
  commissionsCreated: number
  /** Invoices that errored during the per-invoice call. */
  failed: number
  lockSkipped?: boolean
}

const RECONCILIATION_WINDOW_DAYS = 7
const PAGE_LIMIT = 100

export interface ReconciliationOptions {
  now?: Date
  stripeFactory?: () => Stripe | null
  /** Override the window (in days) — useful for backfills. */
  windowDays?: number
}

export async function runAffiliateInvoiceReconciliation(
  options: ReconciliationOptions = {},
): Promise<AffiliateReconciliationSummary> {
  const now = options.now ?? new Date()
  const windowDays = options.windowDays ?? RECONCILIATION_WINDOW_DAYS

  const lockResult = await withGlobalJobLock('affiliate-invoice-reconciliation', async () => {
    const summary: AffiliateReconciliationSummary = {
      invoicesScanned: 0,
      commissionsCreated: 0,
      failed: 0,
    }

    if (process.env.SHOGO_AFFILIATES_NATIVE !== 'true') {
      // Native rollout flag off — nothing to reconcile.
      return summary
    }

    const stripeFactory = options.stripeFactory ?? (() => {
      const key = process.env.STRIPE_SECRET_KEY
      if (!key) return null
      return new Stripe(key, { apiVersion: '2025-04-30.basil' as any })
    })
    const stripe = stripeFactory()
    if (!stripe) {
      console.warn('[Affiliate reconciliation] STRIPE_SECRET_KEY unset; skipping')
      return summary
    }

    const since = Math.floor((now.getTime() - windowDays * 24 * 60 * 60 * 1000) / 1000)

    // Paginated walk through all paid invoices in the window. Stripe's
    // list API caps at 100 per page; we iterate via `starting_after`
    // until exhausted. For the typical Shogo invoice volume this is a
    // handful of pages per day, well under any Stripe rate limit.
    let cursor: string | undefined
    let safetyCounter = 0
    const MAX_PAGES = 500 // ~50k invoices/window — paranoid upper bound

    while (safetyCounter < MAX_PAGES) {
      safetyCounter++
      const page = await stripe.invoices.list({
        limit: PAGE_LIMIT,
        status: 'paid',
        created: { gte: since },
        ...(cursor ? { starting_after: cursor } : {}),
      })
      for (const invoice of page.data) {
        summary.invoicesScanned++
        try {
          const created = await affiliateService.recordCommissionsForInvoice(invoice as any, stripe, now)
          summary.commissionsCreated += created
        } catch (err: any) {
          summary.failed++
          console.error('[Affiliate reconciliation] invoice failed', {
            invoiceId: invoice.id,
            err: err?.message ?? err,
          })
        }
      }
      if (!page.has_more || page.data.length === 0) break
      cursor = page.data[page.data.length - 1]?.id
      if (!cursor) break
    }

    return summary
  })

  if (!lockResult.acquired) {
    return {
      invoicesScanned: 0,
      commissionsCreated: 0,
      failed: 0,
      lockSkipped: true,
    }
  }
  return lockResult.result
}

/**
 * Schedule the reconciliation cron. Daily by default; the sliding
 * window is 7 days so even a multi-day outage gets caught up.
 */
export function startAffiliateInvoiceReconciliationCron(
  intervalMs: number = 24 * 60 * 60 * 1000,
) {
  setTimeout(() => {
    runAffiliateInvoiceReconciliation().catch((err) =>
      console.error('[AffiliateReconciliation] initial run failed:', err),
    )
    setInterval(() => {
      runAffiliateInvoiceReconciliation().catch((err) =>
        console.error('[AffiliateReconciliation] periodic run failed:', err),
      )
    }, intervalMs)
  }, 35_000)
  console.log(
    `[AffiliateReconciliation] cron scheduled (every ${Math.round(intervalMs / 3600000)}h)`,
  )
}
