// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shogo credit — the bonus usage credit shown as a dollar balance in Billing.
 *
 * It replaces the single `usage_wallets.promoCreditUsd` balance (SHO-572) with
 * one row per grant, so each source carries its own remaining balance, expiry
 * and audit trail:
 *
 *   - `signup`       the staged $2 → $8 signup credit (30-day expiry)
 *   - `learn_reward` the learn.shogo.ai LinkedIn share rewards (never expire)
 *   - `admin`        a support top-up
 *
 * Two rules the whole feature hangs on:
 *
 * 1. **Hoshi only.** Credit pays for Hoshi model calls and nothing else, and
 *    it is *opt-in at the call site*: `checkUsageBalance` / `consumeUsage` only
 *    consider it when the caller says so (`{ shogoCredit: 'hoshi' }` /
 *    `shogoCreditModel`). Voice, media, published apps, VM/storage jobs and the
 *    hourly jobs pass nothing, so they can never spend it.
 * 2. **Never overdraw.** A debit is a conditional `updateMany` on
 *    `remainingUsd >= take`, so two concurrent consumes can never take the same
 *    cents twice, and expired or revoked grants are never selected.
 *
 * This is an internal service, not an agent tool.
 */

import { prisma } from '../lib/prisma'
import { normalizePublicModelId } from './public-models.service'

/** Where a grant came from. Stored as a plain string (validated here). */
export type ShogoCreditSource = 'signup' | 'learn_reward' | 'admin'

/**
 * The slice of the Prisma client this service needs, so callers can hand in
 * either `prisma` or an open `$transaction` client (SHO-573 grants inside its
 * own transaction).
 */
export type ShogoCreditClient = {
  shogoCreditGrant: {
    findFirst: typeof prisma.shogoCreditGrant.findFirst
    findMany: typeof prisma.shogoCreditGrant.findMany
    create: typeof prisma.shogoCreditGrant.create
    updateMany: typeof prisma.shogoCreditGrant.updateMany
    aggregate: typeof prisma.shogoCreditGrant.aggregate
    count: typeof prisma.shogoCreditGrant.count
  }
}

/** Float money: anything below this is rounding noise, not a charge. */
const EPSILON = 1e-9

/** How many grants one debit may walk before it gives up (safety valve). */
const MAX_GRANT_DEBITS = 100

/**
 * Whether a model is Hoshi, and so may be paid for with Shogo credit.
 *
 * `hoshi-1.0`, `hoshi-1-0`, `hoshi-2-0` and `hoshi-2.0` all normalise to a
 * `hoshi-*` public id (`normalizePublicModelId`), and the DB-defined models
 * (`hoshi-2-0`) are stored under the same prefix.
 *
 * ⚠️ The caller must pass **the model the user asked for**, never the backing
 * model a public alias forwards to (`claude-opus-4-7` behind `hoshi-1.0`).
 * Resolved after that swap, a Hoshi call would never look like one.
 */
export function isShogoCreditModel(modelId: string | null | undefined): boolean {
  if (typeof modelId !== 'string') return false
  const id = modelId.trim()
  if (!id) return false
  return /^hoshi-/i.test(normalizePublicModelId(id))
}

/** The `where` every live-balance read shares: spendable now, not revoked. */
function liveGrantWhere(workspaceId: string, now: Date) {
  return {
    workspaceId,
    remainingUsd: { gt: 0 },
    revokedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  }
}

/**
 * Shogo credit a workspace can still spend at `now`: the sum of every live
 * grant. Expired grants have been settled by the hourly job, but the predicate
 * makes a missed run harmless — an expired grant is simply not counted.
 */
export async function availableShogoCredit(
  client: ShogoCreditClient,
  workspaceId: string,
  now: Date = new Date(),
): Promise<number> {
  const sum = await client.shogoCreditGrant.aggregate({
    _sum: { remainingUsd: true },
    where: liveGrantWhere(workspaceId, now),
  })
  const total = sum._sum?.remainingUsd ?? 0
  return total > 0 ? total : 0
}

/**
 * When the credit shown in Billing stops being spendable: the soonest expiry
 * among live grants, or `null` when none of them expires (a learn reward) or
 * there is no credit at all.
 */
export async function soonestShogoCreditExpiry(
  client: ShogoCreditClient,
  workspaceId: string,
  now: Date = new Date(),
): Promise<Date | null> {
  const grant = await client.shogoCreditGrant.findFirst({
    where: liveGrantWhere(workspaceId, now),
    orderBy: { expiresAt: { sort: 'asc', nulls: 'last' } },
    select: { expiresAt: true },
  })
  return grant?.expiresAt ?? null
}

export interface GrantShogoCreditParams {
  workspaceId: string
  amountUsd: number
  source: ShogoCreditSource
  /**
   * Idempotency key within `source`: `signup:<workspaceId>:stage1`, a LinkedIn
   * share ref, and so on. Granting the same key twice pays once.
   */
  sourceRef: string
  /** `null` = never expires (learn rewards). */
  expiresAt: Date | null
}

/**
 * Add a grant. Idempotent on `(source, sourceRef)`: a retry, a duplicate reward
 * webhook or a concurrent grant returns the existing row instead of paying
 * twice (unique index → P2002).
 *
 * Pass `tx` to grant inside a caller's transaction (SHO-573 does).
 */
export async function grantShogoCredit(
  params: GrantShogoCreditParams,
  tx: ShogoCreditClient = prisma,
) {
  const { workspaceId, amountUsd, source, sourceRef, expiresAt } = params
  const amount = Math.max(0, amountUsd)
  if (amount <= 0) {
    throw new Error('grantShogoCredit: amountUsd must be positive')
  }
  try {
    return await tx.shogoCreditGrant.create({
      data: { workspaceId, source, sourceRef, amountUsd: amount, remainingUsd: amount, expiresAt },
    })
  } catch (err) {
    if ((err as { code?: string })?.code !== 'P2002') throw err
    const existing = await tx.shogoCreditGrant.findFirst({ where: { source, sourceRef } })
    if (!existing) throw err
    return existing
  }
}

export interface SpendShogoCreditResult {
  /** How much of the requested amount the grants actually covered. */
  spentUsd: number
  /** The grants debited, for the usage event's audit trail. */
  grantIds: string[]
}

/**
 * Debit `amountUsd` from a workspace's grants, soonest-expiring first and
 * never-expiring last.
 *
 * Each debit is conditional on the grant still holding that many cents
 * (`updateMany({ where: { id, remainingUsd: { gte: take } } })`): if a
 * concurrent consumer took them first the update matches nothing and the next
 * grant is tried, so `remainingUsd` can never go negative and the same cents
 * are never spent twice. A call larger than one grant spans as many as it
 * needs.
 *
 * Returns what it managed to take. The caller decides what an under-covered
 * debit means (both current call sites let the last of the balance absorb it).
 */
export async function spendShogoCredit(
  tx: ShogoCreditClient,
  workspaceId: string,
  amountUsd: number,
  now: Date = new Date(),
): Promise<SpendShogoCreditResult> {
  let remaining = Math.max(0, amountUsd)
  const grantIds: string[] = []
  let spentUsd = 0

  for (let attempt = 0; remaining > EPSILON && attempt < MAX_GRANT_DEBITS; attempt++) {
    const grant = await tx.shogoCreditGrant.findFirst({
      where: liveGrantWhere(workspaceId, now),
      orderBy: [{ expiresAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      select: { id: true, remainingUsd: true },
    })
    if (!grant) break

    const take = Math.min(remaining, grant.remainingUsd)
    if (take <= 0) break
    const res = await tx.shogoCreditGrant.updateMany({
      where: { id: grant.id, remainingUsd: { gte: take } },
      data: { remainingUsd: { decrement: take } },
    })
    // Lost the race for these cents: re-read and take what is there now.
    if (res.count === 0) continue

    remaining -= take
    spentUsd += take
    if (!grantIds.includes(grant.id)) grantIds.push(grant.id)
  }

  return { spentUsd, grantIds }
}

/**
 * Zero every live grant from one source and mark it revoked. Used by the
 * signup-risk admin path: a revoked signup cannot spend, and a later approval
 * can grant again (the "owed" maths reads the sum of unrevoked grants).
 */
export async function revokeShogoCredit(
  params: { workspaceId: string; source: ShogoCreditSource; now?: Date },
  tx: ShogoCreditClient = prisma,
): Promise<number> {
  const now = params.now ?? new Date()
  const live = await tx.shogoCreditGrant.findMany({
    where: { workspaceId: params.workspaceId, source: params.source, revokedAt: null, remainingUsd: { gt: 0 } },
    select: { id: true, remainingUsd: true },
  })
  const balance = live.reduce((sum, g) => sum + Math.max(0, g.remainingUsd), 0)
  if (balance <= 0) return 0
  const res = await tx.shogoCreditGrant.updateMany({
    where: { id: { in: live.map((g) => g.id) }, revokedAt: null },
    data: { remainingUsd: 0, revokedAt: now },
  })
  return res.count > 0 ? balance : 0
}

/**
 * What one source has granted a workspace, net of revokes. The admin approval
 * path uses it as "already granted", so approving twice pays once.
 */
export async function grantedShogoCreditUsd(
  client: ShogoCreditClient,
  workspaceId: string,
  source: ShogoCreditSource,
): Promise<number> {
  const sum = await client.shogoCreditGrant.aggregate({
    _sum: { amountUsd: true },
    where: { workspaceId, source, revokedAt: null },
  })
  return Math.max(0, sum._sum?.amountUsd ?? 0)
}

// ============================================================================
// Where a workspace's credit is spent
// ============================================================================
//
// Normally the workspace's own grants. But signup credit is granted on the
// user's *team* workspace, and a new user's first messages are just as likely
// to land in their *personal* one — without this fallback the free window
// blocks them while untouched credit sits one workspace over.

/** The reads a source resolution needs, from `prisma` or a tx client. */
type CreditSourceClient = ShogoCreditClient & {
  workspace: { findUnique: typeof prisma.workspace.findUnique }
  member: { findFirst: typeof prisma.member.findFirst }
}

/** Where a workspace's Shogo credit is spent, and how much is left. */
export interface ShogoCreditSource {
  workspaceId: string
  availableUsd: number
}

/**
 * Memoise the *resolution* (workspace kind + credit workspace), not the credit
 * itself: `consumeUsage` is the hottest write in billing and the two `member`
 * lookups almost never change, so a team workspace — the common case — costs
 * zero queries after the first call instead of three on every metered request.
 */
const sourceCache = new Map<
  string,
  { kind: string | null; creditWorkspaceId: string | null; expiresAt: number }
>()
const SOURCE_TTL_MS = 5 * 60 * 1000

/** Test seam: drop the memoised lookups. */
export function clearShogoCreditSourceCache() {
  sourceCache.clear()
}

/**
 * Resolve the workspace whose grants fund a call billed to
 * `billingWorkspaceId` (already parent-resolved by the caller).
 *
 * `ownAvailableUsd` is passed in because the caller has just read it; this only
 * decides *where else* to look. Returns `null` when no live credit exists
 * anywhere, or when the workspace declares zero credit (`allowZero`, used by
 * the billing read so the expiry can still be reported).
 */
export async function resolveShogoCreditSource(
  client: CreditSourceClient,
  billingWorkspaceId: string,
  ownAvailableUsd: number,
  now: Date,
): Promise<ShogoCreditSource | null> {
  if (ownAvailableUsd > 0) return { workspaceId: billingWorkspaceId, availableUsd: ownAvailableUsd }

  const cached = sourceCache.get(billingWorkspaceId)
  let entry = cached && cached.expiresAt > now.getTime() ? cached : null

  if (!entry) {
    const ws = await client.workspace.findUnique({
      where: { id: billingWorkspaceId },
      select: { kind: true },
    })
    let creditWorkspaceId: string | null = null
    if (ws?.kind === 'personal') {
      const owner = await client.member.findFirst({
        where: { workspaceId: billingWorkspaceId, role: 'owner', projectId: null },
        select: { userId: true },
      })
      if (owner?.userId) {
        // Same workspace `findSignupCreditWorkspaceId` resolves: the user's
        // first top-level team workspace is where sign-up granted the credit.
        const creditWorkspace = await client.member.findFirst({
          where: {
            userId: owner.userId,
            role: 'owner',
            projectId: null,
            workspace: { kind: 'team', parentWorkspaceId: null },
          },
          select: { workspaceId: true },
          orderBy: { createdAt: 'asc' },
        })
        const id = creditWorkspace?.workspaceId ?? null
        creditWorkspaceId = id && id !== billingWorkspaceId ? id : null
      }
    }
    entry = {
      kind: ws?.kind ?? null,
      creditWorkspaceId,
      expiresAt: now.getTime() + SOURCE_TTL_MS,
    }
    sourceCache.set(billingWorkspaceId, entry)
  }

  if (entry.kind !== 'personal' || !entry.creditWorkspaceId) return null

  // Credit only ever decreases, so this read is not cached: granting credit we
  // have already spent would be worse than one query.
  const available = await availableShogoCredit(client, entry.creditWorkspaceId, now)
  return available > 0 ? { workspaceId: entry.creditWorkspaceId, availableUsd: available } : null
}
