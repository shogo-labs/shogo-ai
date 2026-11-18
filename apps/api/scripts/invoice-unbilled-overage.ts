// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Invoice overage that was never billed (SHO-408).
 *
 * Two cases used to carry forward forever:
 *   A. A spend cap at or below the block size: the debit that would cross the
 *      cap is refused, so `overageAccumulatedUsd` stops just under the block
 *      and `chargeOverageBlocks` never reaches its `unbilled >= block` line.
 *   B. A sub-block remainder when the subscription ends: nothing invoices it
 *      and `chargeOverageBlocks` defers while the sub is not active.
 *
 * Both now invoice at the cap / at subscription end. This script backfills the
 * wallets that got stuck before that fix.
 *
 * Dry run by default — it only prints what it would invoice:
 *
 *   DATABASE_URL=<us primary> bun apps/api/scripts/invoice-unbilled-overage.ts
 *   ... --apply   # actually raise the invoices (needs STRIPE_SECRET_KEY)
 *
 * `subscriptions` and `usage_wallets` are replicated across regions, so run it
 * once against the primary.
 */
import { prisma } from '../src/lib/prisma'
import {
  chargeOverage,
  overageBlockUsd,
  OVERAGE_MIN_INVOICE_USD,
} from '../src/services/billing.service'

const APPLY = process.argv.includes('--apply')

type Candidate = {
  workspaceId: string
  unbilledUsd: number
  capUsd: number | null
  subStatus: string | null
  reason: 'cap' | 'final'
}

async function main() {
  if (APPLY && !process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is required with --apply')
  }

  const wallets = await prisma.usageWallet.findMany({
    select: {
      workspaceId: true,
      overageAccumulatedUsd: true,
      overageBilledUsd: true,
      overagePaidBlocks: true,
      overageHardLimitUsd: true,
      overageOutstandingInvoiceId: true,
    },
  })

  const candidates: Candidate[] = []
  for (const w of wallets) {
    if (w.overageOutstandingInvoiceId) continue
    const unbilledUsd = w.overageAccumulatedUsd - w.overageBilledUsd
    if (unbilledUsd < OVERAGE_MIN_INVOICE_USD) continue

    const sub = await prisma.subscription.findFirst({
      where: { workspaceId: w.workspaceId },
      select: { status: true },
    })
    const capUsd = w.overageHardLimitUsd
    const capReached = capUsd != null && capUsd - w.overageAccumulatedUsd < 1.0
    const subEnded = sub?.status === 'canceled'

    if (!capReached && !subEnded) continue
    // A cap that is a whole number of blocks above what is billed is the
    // normal block path, not a stuck remainder.
    const blockUsd = overageBlockUsd(w.overagePaidBlocks)
    if (unbilledUsd >= blockUsd && !subEnded) continue

    candidates.push({
      workspaceId: w.workspaceId,
      unbilledUsd: Math.round(unbilledUsd * 100) / 100,
      capUsd,
      subStatus: sub?.status ?? null,
      reason: subEnded ? 'final' : 'cap',
    })
  }

  console.table(candidates)
  console.log(
    `[invoice-unbilled-overage] ${wallets.length} wallets checked, ${candidates.length} with unbilled overage`,
  )

  if (!APPLY) {
    console.log('[invoice-unbilled-overage] dry run — re-run with --apply to raise these invoices.')
    return
  }

  let invoiced = 0
  for (const c of candidates) {
    const n = await chargeOverage(c.workspaceId, c.reason)
    invoiced += n
    console.log(`[invoice-unbilled-overage] ${c.workspaceId} (${c.reason}): ${n > 0 ? 'invoiced' : 'skipped'}`)
  }
  console.log(`[invoice-unbilled-overage] ${invoiced} invoice(s) raised`)
}

main()
  .catch((err) => {
    console.error('[invoice-unbilled-overage] failed:', err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
