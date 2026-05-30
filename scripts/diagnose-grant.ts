// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Read-only diagnostic for a "credit grant applied but the user can't see it"
 * support ticket. Given a workspace id (and optionally a user id), it prints
 * everything that decides what a user sees vs. what was granted:
 *
 *   - workspace_grants rows (active AND inactive, with the reason)
 *   - the active-grant rollup (getActiveGrantsForWorkspace semantics)
 *   - the paid Stripe subscription (the authoritative plan for paid wsps)
 *   - the usage_wallet (the merged balance the UI actually reads)
 *   - the effective plan id + expected vs. actual monthly included USD
 *   - the rolling 5h / weekly windows (what Pro users are gated by)
 *
 * It then prints a short verdict pointing at the most likely cause.
 *
 * This script performs NO writes. (It deliberately reads usage_wallets
 * directly instead of calling getUsageWallet/getUsageWindows, which would
 * lazily create a free wallet as a side effect.)
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *     bun scripts/diagnose-grant.ts --workspace <workspaceId> [--user <userId>]
 */

import { prisma } from '../apps/api/src/lib/prisma'
import {
  getMonthlyIncludedForPlan,
  normalizePlanId,
  comparePlanRank,
  PLAN_RANK,
} from '../apps/api/src/config/usage-plans'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const WORKSPACE_ID = arg('workspace') ?? arg('workspaceId')
const USER_ID = arg('user') ?? arg('userId')

function usd(n: number | null | undefined): string {
  return `$${(n ?? 0).toFixed(2)}`
}

async function main() {
  if (!WORKSPACE_ID) {
    // eslint-disable-next-line no-console
    console.error('Missing --workspace <workspaceId>')
    process.exit(1)
  }
  const now = new Date()

  // eslint-disable-next-line no-console
  console.log(`\n=== diagnose-grant @ ${now.toISOString()} ===`)
  // eslint-disable-next-line no-console
  console.log(`workspace: ${WORKSPACE_ID}`)
  if (USER_ID) console.log(`user:      ${USER_ID}`)

  // --- workspace + membership sanity ---------------------------------------
  const workspace = await prisma.workspace.findUnique({
    where: { id: WORKSPACE_ID },
    select: { id: true, name: true, slug: true },
  })
  // eslint-disable-next-line no-console
  console.log('\n--- workspace ---')
  // eslint-disable-next-line no-console
  console.log(workspace ?? 'NOT FOUND')

  if (USER_ID) {
    const membership = await prisma.member.findFirst({
      where: { workspaceId: WORKSPACE_ID, userId: USER_ID },
      select: { role: true },
    }).catch(() => null)
    // Which workspace does the user actually look at by default? A common
    // ticket cause is the grant landing on a different workspace than the
    // one the user is viewing.
    const userWorkspaces = await prisma.member.findMany({
      where: { userId: USER_ID, workspaceId: { not: null } },
      select: { workspaceId: true, role: true },
    }).catch(() => [])
    // eslint-disable-next-line no-console
    console.log('\n--- user membership in THIS workspace ---')
    // eslint-disable-next-line no-console
    console.log(membership ?? 'USER IS NOT A MEMBER OF THIS WORKSPACE (!)')
    // eslint-disable-next-line no-console
    console.log('\n--- all workspaces this user belongs to ---')
    // eslint-disable-next-line no-console
    console.log(userWorkspaces)
  }

  // --- all grants for the workspace ----------------------------------------
  const grants = await prisma.workspaceGrant.findMany({
    where: { workspaceId: WORKSPACE_ID },
    orderBy: { startsAt: 'desc' },
  })
  // eslint-disable-next-line no-console
  console.log(`\n--- workspace_grants (${grants.length} row(s)) ---`)
  for (const g of grants) {
    const startsOk = g.startsAt <= now
    const notExpired = g.expiresAt == null || g.expiresAt > now
    const active = startsOk && notExpired
    const reason = active
      ? 'ACTIVE'
      : !startsOk
        ? `INACTIVE (startsAt ${g.startsAt.toISOString()} is in the FUTURE)`
        : `INACTIVE (expiresAt ${g.expiresAt?.toISOString()} is in the PAST)`
    // eslint-disable-next-line no-console
    console.log(
      `  ${active ? '✓' : '✗'} id=${g.id}\n` +
        `      freeSeats=${g.freeSeats} monthlyIncludedUsd=${usd(g.monthlyIncludedUsd)} planId=${g.planId ?? 'null'}\n` +
        `      startsAt=${g.startsAt.toISOString()} expiresAt=${g.expiresAt?.toISOString() ?? 'null'}\n` +
        `      note=${JSON.stringify(g.note ?? '')} createdBy=${g.createdByUserId ?? 'null'}\n` +
        `      -> ${reason}`,
    )
  }

  // --- active grant rollup (mirrors getActiveGrantsForWorkspace) -----------
  const activeRows = grants.filter(
    (g) => g.startsAt <= now && (g.expiresAt == null || g.expiresAt > now),
  )
  let grantFreeSeats = 0
  let grantMonthlyUsd = 0
  let grantPlanId: string | null = null
  for (const r of activeRows) {
    grantFreeSeats += r.freeSeats
    grantMonthlyUsd += r.monthlyIncludedUsd
    if (r.planId && comparePlanRank(r.planId, grantPlanId) > 0) grantPlanId = r.planId
  }
  // eslint-disable-next-line no-console
  console.log('\n--- active grant rollup ---')
  // eslint-disable-next-line no-console
  console.log({
    activeRows: activeRows.length,
    freeSeats: grantFreeSeats,
    monthlyIncludedUsd: grantMonthlyUsd,
    planId: grantPlanId,
  })

  // --- subscription --------------------------------------------------------
  const paidSub = await prisma.subscription.findFirst({
    where: { workspaceId: WORKSPACE_ID, status: { in: ['active', 'trialing'] } },
    select: { planId: true, seats: true, status: true, stripeSubscriptionId: true, updatedAt: true },
  })
  // eslint-disable-next-line no-console
  console.log('\n--- active paid subscription ---')
  // eslint-disable-next-line no-console
  console.log(paidSub ?? 'none')

  // --- wallet (what the UI reads) ------------------------------------------
  const wallet = await prisma.usageWallet.findUnique({ where: { workspaceId: WORKSPACE_ID } })
  // eslint-disable-next-line no-console
  console.log('\n--- usage_wallet ---')
  if (!wallet) {
    // eslint-disable-next-line no-console
    console.log('NO WALLET ROW (grant was never applied / wallet never created)')
  } else {
    // eslint-disable-next-line no-console
    console.log({
      monthlyIncludedUsd: usd(wallet.monthlyIncludedUsd),
      monthlyIncludedAllocationUsd: usd(wallet.monthlyIncludedAllocationUsd),
      dailyIncludedUsd: usd(wallet.dailyIncludedUsd),
      dailyUsedThisMonthUsd: usd(wallet.dailyUsedThisMonthUsd),
      overageEnabled: wallet.overageEnabled,
      lastMonthlyReset: wallet.lastMonthlyReset,
      fiveHourUsedUsd: usd(wallet.fiveHourUsedUsd),
      weeklyUsedUsd: usd(wallet.weeklyUsedUsd),
    })
  }

  // --- effective plan + expected allocation --------------------------------
  const effectivePlan = paidSub
    ? normalizePlanId(paidSub.planId) ?? 'free'
    : normalizePlanId(grantPlanId) ?? 'free'

  // Reproduce the allocation math the apply endpoint would use.
  let expectedMonthlyUsd: number
  if (paidSub) {
    const totalSeats = Math.max(1, Math.floor(paidSub.seats || 1)) + grantFreeSeats
    expectedMonthlyUsd = getMonthlyIncludedForPlan(paidSub.planId, totalSeats) + grantMonthlyUsd
  } else {
    const grantSeats = Math.max(1, grantFreeSeats || 0)
    expectedMonthlyUsd = getMonthlyIncludedForPlan(effectivePlan, grantSeats) + grantMonthlyUsd
  }

  // eslint-disable-next-line no-console
  console.log('\n--- plan / allocation ---')
  // eslint-disable-next-line no-console
  console.log({
    effectivePlan,
    planSource: paidSub ? 'subscription' : grantPlanId ? 'grant' : 'free',
    grantPlanIdIgnored: !!paidSub && !!grantPlanId,
    expectedMonthlyIncludedUsd: usd(expectedMonthlyUsd),
    actualMonthlyIncludedUsd: usd(wallet?.monthlyIncludedUsd),
    matches: wallet ? Math.abs((wallet.monthlyIncludedUsd ?? 0) - expectedMonthlyUsd) < 0.01 : false,
  })

  // --- verdict -------------------------------------------------------------
  // eslint-disable-next-line no-console
  console.log('\n=== verdict ===')
  const verdicts: string[] = []

  if (activeRows.length === 0 && grants.length > 0) {
    verdicts.push('All grants on this workspace are INACTIVE (future startsAt or past expiresAt). The user sees nothing because no grant is currently active.')
  }
  if (grants.length === 0) {
    verdicts.push('No workspace_grants rows exist for this workspace at all. Either the grant was applied to a DIFFERENT workspace, or it was never created. Cross-check the user\'s other workspaces listed above.')
  }
  if (activeRows.length > 0 && grantMonthlyUsd === 0 && grantFreeSeats === 0 && grantPlanId) {
    verdicts.push(`Active grant is PLAN-ONLY (planId=${grantPlanId}, $0 USD, 0 seats). On a workspace already on Pro this is a no-op — the subscription plan wins and there is no extra USD to show.`)
  }
  if (paidSub && grantPlanId) {
    verdicts.push(`Workspace has an active paid subscription (${paidSub.planId}); the grant's planId (${grantPlanId}) is IGNORED for plan tier. Only the grant's monthlyIncludedUsd / freeSeats matter here.`)
  }
  if (wallet && grantMonthlyUsd > 0 && Math.abs((wallet.monthlyIncludedUsd ?? 0) - expectedMonthlyUsd) >= 0.01) {
    verdicts.push(`Wallet monthlyIncludedUsd (${usd(wallet.monthlyIncludedUsd)}) does NOT match expected (${usd(expectedMonthlyUsd)}). The grant USD was likely never pushed to the wallet (the "Apply" step / Stripe webhook never ran), OR a later customer.subscription.updated webhook overwrote the wallet WITHOUT re-stacking grants (server.ts ~6338). Re-run the admin "Apply" action: POST /api/admin/workspace-grants/:id/apply`)
  }
  if (wallet && grantMonthlyUsd > 0 && Math.abs((wallet.monthlyIncludedUsd ?? 0) - expectedMonthlyUsd) < 0.01) {
    verdicts.push(`Wallet allocation is CORRECT and includes the grant (${usd(wallet.monthlyIncludedUsd)} = plan + grant ${usd(grantMonthlyUsd)}). For a PRO user the main Billing page shows rolling 5h/weekly WINDOWS, not a dollar balance — and grant USD does NOT widen those windows. So the user genuinely cannot "see" the grant on the billing page even though it is correctly applied. The extra USD appears only on the Settings → Billing tab / sidebar (which show $X / $Y), and only matters for overage, not window limits.`)
  }

  if (verdicts.length === 0) {
    verdicts.push('No obvious anomaly detected from the data; inspect the specific surface the user is looking at and the values printed above.')
  }
  for (const [i, v] of verdicts.entries()) {
    // eslint-disable-next-line no-console
    console.log(`  ${i + 1}. ${v}`)
  }
  // eslint-disable-next-line no-console
  console.log('')
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[diagnose-grant] failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
