// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Repair paid `usage_wallets` that were mis-provisioned as free, region by
 * region.
 *
 * Why this exists
 * ---------------
 * `usage_wallets` is NOT in the cross-region publication (`shogo_all_pub`), so
 * each region has kept its own independent wallet. The Stripe subscription
 * webhook provisions the paid wallet in whatever region terminates the webhook
 * (US primary) — that provisioning never reaches a workspace whose home region
 * is EU. The result is paid workspaces whose home-region wallet is still a
 * free-tier wallet (`overageEnabled=false`, `monthlyIncludedAllocationUsd=0`):
 * once a rolling window fills they hard-block with "Usage limit reached"
 * despite an active paid subscription (incident 2026-07-07).
 *
 * Scope — deliberately narrow
 * ---------------------------
 * We ONLY touch wallets of PAID workspaces (active/trialing subscription, or a
 * super-admin grant conferring a paid tier) whose wallet config does not match
 * that paid plan. Detection compares the *allocation cap*
 * (`monthlyIncludedAllocationUsd`) and `overageEnabled` — NOT the running
 * balances (`monthlyIncludedUsd`, `dailyIncludedUsd`), which are drained
 * through the period (see billing-alerts.service `allocation - monthlyIncludedUsd`
 * and voice-cost `dailyIncludedUsd + monthlyIncludedUsd`). Reconciling balances
 * would be a mass refill, so we never do it; free wallets are left alone
 * entirely.
 *
 * Repair reuses the authoritative provisioning functions the Stripe webhook /
 * grant refill already use (`allocateMonthlyIncluded` /
 * `applyGrantMonthlyAllocation`), so a repaired wallet is byte-for-byte what a
 * correct provision would have produced.
 *
 * Single-writer safety
 * --------------------
 * It only touches wallets whose `workspace.homeRegion` matches this region
 * (`REGION_ID`), writing them in that same region — so the repair is itself a
 * single-writer op that will not re-diverge and is safe once `usage_wallets`
 * rejoins the mesh. Run it once per home region:
 *
 *   REGION_ID=us-ashburn-1  DATABASE_URL=<us primary>  bun scripts/repair-usage-wallets.ts
 *   REGION_ID=eu-frankfurt-1 DATABASE_URL=<eu primary> bun scripts/repair-usage-wallets.ts
 *
 * Flags:
 *   (default)            dry run — print the diff, write nothing
 *   --apply              execute the reprovision
 *   --workspace <id>     restrict to a single workspace (debugging / validation)
 *   --force              apply even if REGION_ID is unset (single-region/dev)
 */

import { prisma } from '../apps/api/src/lib/prisma'
import {
  allocateMonthlyIncluded,
  applyGrantMonthlyAllocation,
} from '../apps/api/src/services/billing.service'
import {
  getMonthlyIncludedForPlan,
  normalizePlanId,
  comparePlanRank,
  PLAN_RANK,
} from '../apps/api/src/config/usage-plans'
import { PRIMARY_REGION, RAW_REGION_ID } from '../apps/api/src/lib/region'

const argv = process.argv.slice(2)
const args = new Set(argv)
const APPLY = args.has('--apply')
const FORCE = args.has('--force')
function argVal(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const ONLY_WORKSPACE = argVal('workspace') ?? argVal('workspaceId')

const REGION = RAW_REGION_ID

function usd(n: number | null | undefined): string {
  return `$${(n ?? 0).toFixed(2)}`
}
function approxEq(a: number, b: number, eps = 0.01): boolean {
  return Math.abs((a ?? 0) - (b ?? 0)) < eps
}

/** Active-grant rollup mirroring getActiveGrantsForWorkspace. */
function grantRollup(
  rows: Array<{ freeSeats: number; monthlyIncludedUsd: number; planId: string | null }>,
) {
  let freeSeats = 0
  let monthlyIncludedUsd = 0
  let planId: string | null = null
  for (const r of rows) {
    freeSeats += r.freeSeats
    monthlyIncludedUsd += r.monthlyIncludedUsd
    if (r.planId && comparePlanRank(r.planId, planId) > 0) planId = r.planId
  }
  return { freeSeats, monthlyIncludedUsd, planId }
}

interface Expected {
  plan: string
  source: 'subscription' | 'grant'
  allocationUsd: number
}

/**
 * The paid plan a workspace should be on and its expected allocation cap.
 * Returns null for free workspaces (no paid sub, no paid grant) — those are
 * out of scope. A paid subscription wins over a grant's plan tier; the grant's
 * flat USD + free seats always stack.
 */
function expectedPaid(
  sub: { planId: string; seats: number } | null,
  grant: { freeSeats: number; monthlyIncludedUsd: number; planId: string | null },
): Expected | null {
  if (sub) {
    const plan = normalizePlanId(sub.planId) ?? 'free'
    const seats = Math.max(1, Math.floor(sub.seats || 1)) + grant.freeSeats
    return {
      plan,
      source: 'subscription',
      allocationUsd: getMonthlyIncludedForPlan(sub.planId, seats) + grant.monthlyIncludedUsd,
    }
  }
  const grantPlan = normalizePlanId(grant.planId)
  if (grantPlan && PLAN_RANK[grantPlan] >= PLAN_RANK.basic) {
    const seats = Math.max(1, grant.freeSeats || 0)
    return {
      plan: grantPlan,
      source: 'grant',
      allocationUsd: getMonthlyIncludedForPlan(grantPlan, seats) + grant.monthlyIncludedUsd,
    }
  }
  return null
}

async function main() {
  const now = new Date()

  if (APPLY && !REGION && !FORCE) {
    console.error(
      '[repair-wallets] Refusing to apply: REGION_ID is unset. This script repairs ' +
        'the wallets whose home region matches REGION_ID and writes them locally ' +
        '(single-writer). Set REGION_ID=<us-ashburn-1|eu-frankfurt-1> against that ' +
        "region's primary, or pass --force for a single-region/dev database.",
    )
    process.exit(1)
  }

  const homeRegion = REGION ?? PRIMARY_REGION
  console.log(`\n=== repair-usage-wallets @ ${now.toISOString()} ===`)
  console.log(`region:        ${REGION ?? '(unset -> treating as ' + PRIMARY_REGION + ')'}`)
  console.log(`mode:          ${APPLY ? 'APPLY' : 'dry-run'}`)
  if (ONLY_WORKSPACE) console.log(`workspace:     ${ONLY_WORKSPACE} (restricted)`)

  const homeFilter =
    homeRegion === PRIMARY_REGION
      ? { OR: [{ homeRegion }, { homeRegion: null }] }
      : { homeRegion }

  const workspaces = await prisma.workspace.findMany({
    where: {
      ...(ONLY_WORKSPACE ? { id: ONLY_WORKSPACE } : {}),
      ...homeFilter,
      usageWallets: { some: {} },
    },
    select: { id: true },
  })
  const workspaceIds = workspaces.map((w) => w.id)
  console.log(`\nwallets owned by this region: ${workspaceIds.length}`)
  if (workspaceIds.length === 0) {
    console.log('[repair-wallets] nothing to do.')
    await prisma.$disconnect()
    return
  }

  const [wallets, subs, grants] = await Promise.all([
    prisma.usageWallet.findMany({
      where: { workspaceId: { in: workspaceIds } },
      select: {
        workspaceId: true,
        overageEnabled: true,
        monthlyIncludedAllocationUsd: true,
        monthlyIncludedUsd: true,
      },
    }),
    prisma.subscription.findMany({
      where: { workspaceId: { in: workspaceIds }, status: { in: ['active', 'trialing'] } },
      select: { workspaceId: true, planId: true, seats: true },
    }),
    prisma.workspaceGrant.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        startsAt: { lte: now },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { workspaceId: true, freeSeats: true, monthlyIncludedUsd: true, planId: true },
    }),
  ])

  const subByWs = new Map(subs.map((s) => [s.workspaceId, s]))
  const grantsByWs = new Map<string, typeof grants>()
  for (const g of grants) {
    const arr = grantsByWs.get(g.workspaceId) ?? []
    arr.push(g)
    grantsByWs.set(g.workspaceId, arr)
  }

  interface Repair {
    workspaceId: string
    plan: string
    source: 'subscription' | 'grant'
    sub: { planId: string; seats: number } | null
    reasons: string[]
  }
  const repairs: Repair[] = []

  for (const w of wallets) {
    const sub = subByWs.get(w.workspaceId) ?? null
    const grant = grantRollup(grantsByWs.get(w.workspaceId) ?? [])
    const exp = expectedPaid(sub, grant)
    if (!exp) continue // free workspace — out of scope

    const reasons: string[] = []
    if (w.overageEnabled !== true) reasons.push(`overageEnabled ${w.overageEnabled} -> true`)
    if (!approxEq(w.monthlyIncludedAllocationUsd, exp.allocationUsd)) {
      reasons.push(
        `monthlyIncludedAllocationUsd ${usd(w.monthlyIncludedAllocationUsd)} -> ${usd(exp.allocationUsd)}`,
      )
    }
    if (reasons.length === 0) continue // paid wallet already correct

    repairs.push({ workspaceId: w.workspaceId, plan: exp.plan, source: exp.source, sub, reasons })
  }

  console.log(`\npaid wallets mis-provisioned (to repair): ${repairs.length}`)
  for (const r of repairs) {
    console.log(`  ${r.workspaceId}  [${r.plan}/${r.source}]`)
    for (const reason of r.reasons) console.log(`      - ${reason}`)
  }

  if (!APPLY) {
    console.log('\n[repair-wallets] dry run — re-run with --apply to reprovision these wallets.')
    await prisma.$disconnect()
    return
  }

  let applied = 0
  for (const r of repairs) {
    if (r.source === 'subscription' && r.sub) {
      await allocateMonthlyIncluded(r.workspaceId, r.sub.planId, r.sub.seats)
    } else {
      await applyGrantMonthlyAllocation(r.workspaceId, now)
    }
    applied++
  }
  console.log(`\n[repair-wallets] applied. wallets reprovisioned: ${applied}`)
  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error('[repair-wallets] failed:', err)
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
