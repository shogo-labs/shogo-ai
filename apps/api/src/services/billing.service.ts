// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Billing Service — USD usage wallet + Stripe metered overage.
 *
 * The product sells flat per-seat plans modeled on Cursor.com:
 *   - Basic    $8/mo   single user, $5 of usage included
 *   - Pro      $20/seat/mo, $20 of usage included per seat
 *   - Business $40/seat/mo, $40 of usage included per seat
 * Every action charges `provider_raw_cost * MARKUP_MULTIPLIER` (1.20).
 * Deduction order: daily included -> monthly included -> overage.
 *
 * Overage is opt-in per workspace. When enabled, marked-up USD beyond
 * monthly included accrues to `overageAccumulatedUsd` and is reported to
 * a Stripe metered subscription item (created lazily on the first overage
 * event). It is invoiced at period end by Stripe.
 */

import { prisma, SubscriptionStatus, BillingInterval } from '../lib/prisma';
import {
  DAILY_INCLUDED_USD,
  MONTHLY_DAILY_CAP_USD,
  PLAN_INCLUDED_USD,
  getMonthlyIncludedForPlan,
} from '../config/usage-plans';
import { getOveragePriceConfig } from '../config/stripe-prices';
const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true'

/**
 * USD source a usage event was charged against. Mirrors the DB enum.
 */
export type UsageSource = 'daily' | 'monthly' | 'overage'

/**
 * Get subscription for a workspace
 */
export async function getSubscription(workspaceId: string) {
  return prisma.subscription.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Get all subscriptions for a workspace
 */
export async function getSubscriptions(workspaceId: string) {
  return prisma.subscription.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Get USD usage wallet for a workspace.
 */
export async function getUsageWallet(workspaceId: string) {
  return prisma.usageWallet.findUnique({
    where: { workspaceId },
  });
}

/**
 * Sum the active super-admin-managed credit grants for a workspace.
 * "Active" means `startsAt <= now AND (expiresAt IS NULL OR expiresAt > now)`.
 * Multiple grants are summed so an admin can stack (e.g. a base 5 free
 * seats grant plus a one-off $500 promo).
 */
export async function getActiveGrantsForWorkspace(
  workspaceId: string,
  now: Date = new Date(),
): Promise<{ freeSeats: number; monthlyIncludedUsd: number; rowCount: number }> {
  const rows = await prisma.workspaceGrant.findMany({
    where: {
      workspaceId,
      startsAt: { lte: now },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { freeSeats: true, monthlyIncludedUsd: true },
  })
  let freeSeats = 0
  let monthlyIncludedUsd = 0
  for (const r of rows) {
    freeSeats += r.freeSeats
    monthlyIncludedUsd += r.monthlyIncludedUsd
  }
  return { freeSeats, monthlyIncludedUsd, rowCount: rows.length }
}

/**
 * Allocate free-tier wallet for a new workspace (daily included, no monthly).
 * If active super-admin grants exist for the workspace, their summed
 * `monthlyIncludedUsd` seeds the wallet on day one.
 */
export async function allocateFreeWallet(workspaceId: string) {
  const now = new Date();

  const existing = await prisma.usageWallet.findUnique({
    where: { workspaceId },
  });
  if (existing) return existing;

  const grant = await getActiveGrantsForWorkspace(workspaceId, now)
  const monthlyIncludedUsd = PLAN_INCLUDED_USD.free + grant.monthlyIncludedUsd

  return prisma.usageWallet.create({
    data: {
      workspaceId,
      monthlyIncludedUsd,
      monthlyIncludedAllocationUsd: monthlyIncludedUsd,
      dailyIncludedUsd: DAILY_INCLUDED_USD,
      anniversaryDay: now.getDate(),
      lastDailyReset: now,
      lastMonthlyReset: now,
    },
  });
}

/**
 * Refill a workspace's wallet from its active super-admin grants. Used by
 * the monthly-refill cron and by `consumeUsage` as a safety net for free
 * workspaces that wouldn't otherwise receive a Stripe invoice. Paid
 * workspaces normally pick up grants via `allocateMonthlyIncluded` on the
 * Stripe webhook; this function is intentionally idempotent and safe to
 * call repeatedly.
 *
 * Behavior:
 * - Resets `monthlyIncludedUsd` / `monthlyIncludedAllocationUsd` to
 *   `PLAN_INCLUDED_USD.free + grant.monthlyIncludedUsd` (the grant value
 *   alone for free workspaces, since `PLAN_INCLUDED_USD.free === 0`).
 * - Resets `dailyUsedThisMonthUsd`, `overageAccumulatedUsd`,
 *   `overageBilledUsd` so the new period starts clean.
 * - Advances `lastMonthlyReset` to `now`.
 */
export async function applyGrantMonthlyAllocation(
  workspaceId: string,
  now: Date = new Date(),
) {
  const grant = await getActiveGrantsForWorkspace(workspaceId, now)
  const monthlyIncludedUsd = PLAN_INCLUDED_USD.free + grant.monthlyIncludedUsd

  return prisma.usageWallet.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      monthlyIncludedUsd,
      monthlyIncludedAllocationUsd: monthlyIncludedUsd,
      dailyIncludedUsd: DAILY_INCLUDED_USD,
      anniversaryDay: now.getDate(),
      lastDailyReset: now,
      lastMonthlyReset: now,
    },
    update: {
      monthlyIncludedUsd,
      monthlyIncludedAllocationUsd: monthlyIncludedUsd,
      dailyUsedThisMonthUsd: 0,
      overageAccumulatedUsd: 0,
      overageBilledUsd: 0,
      lastMonthlyReset: now,
    },
  })
}


/**
 * Trust-first overage block ladder. The first mid-cycle invoice is `$100`;
 * subsequent blocks step up by `$100` each as the workspace proves it pays
 * (extending trust), capped at `$500` so a single mid-cycle charge never
 * spikes too aggressively. So the n-th block is `min(OVERAGE_BLOCK_MAX_USD,
 * OVERAGE_BLOCK_STEP_USD * n)`, and cumulative billed after N blocks is
 * `100, 300, 600, 1000, 1500, 2000, 2500, ...`.
 */
export const OVERAGE_BLOCK_STEP_USD = 100
export const OVERAGE_BLOCK_MAX_USD = 500
/** @deprecated retained for any caller that imports the legacy constant. */
export const OVERAGE_BLOCK_USD = OVERAGE_BLOCK_STEP_USD

/**
 * Compute the size of the next overage block to bill, given how much has
 * already been invoiced this period in trust blocks. The block size grows
 * with cumulative billed history: `$100 → $200 → $300 → $400 → $500 → $500 → …`
 */
export function nextOverageBlockUsd(overageBilledUsd: number): number {
  let remainder = Math.max(0, overageBilledUsd)
  let blockIdx = 1
  // Bounded loop: once `blockIdx > 5`, every block is the cap. Heavy hitters
  // bail after a handful of iterations, but we keep an outer guard so a
  // pathological wallet state can't loop forever.
  while (blockIdx < 10_000) {
    const size = Math.min(OVERAGE_BLOCK_MAX_USD, OVERAGE_BLOCK_STEP_USD * blockIdx)
    if (remainder < size) return size
    remainder -= size
    blockIdx++
  }
  return OVERAGE_BLOCK_MAX_USD
}

/**
 * Allocate the monthly included USD for a subscription plan and seat count.
 * `seats` is the number of *paying* seats on the Stripe subscription
 * (Pro/Business are per-seat plans; Basic is always 1). Resets accumulated
 * overage so the upcoming period starts clean (any flushed overage should
 * have already been billed via `chargeOverageBlocks` mid-cycle).
 *
 * Super-admin grants stack on top: free-seat counts contribute their
 * per-seat plan-included USD (Pro/Business only) and the grant's flat
 * `monthlyIncludedUsd` is added on top.
 */
export async function allocateMonthlyIncluded(
  workspaceId: string,
  planId: string,
  seats: number = 1,
) {
  const now = new Date();
  const grant = await getActiveGrantsForWorkspace(workspaceId, now)
  // Free seats from a grant get the same per-seat plan included USD.
  const totalSeats = Math.max(1, Math.floor(seats || 1)) + grant.freeSeats
  const monthlyIncludedUsd =
    getMonthlyIncludedForPlan(planId, totalSeats) + grant.monthlyIncludedUsd;

  return prisma.usageWallet.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      monthlyIncludedUsd,
      monthlyIncludedAllocationUsd: monthlyIncludedUsd,
      dailyIncludedUsd: DAILY_INCLUDED_USD,
      anniversaryDay: now.getDate(),
      lastDailyReset: now,
      lastMonthlyReset: now,
      // Trust-first: paid plans default to overage on. The hard cap is
      // optional and still respected.
      overageEnabled: true,
    },
    update: {
      monthlyIncludedUsd,
      monthlyIncludedAllocationUsd: monthlyIncludedUsd,
      overageAccumulatedUsd: 0,
      overageBilledUsd: 0,
      // Re-enable trust-first on plan refresh so anyone who got a `false`
      // from the legacy default before the migration starts the next period
      // billed correctly.
      overageEnabled: true,
      lastMonthlyReset: now,
    },
  });
}

/**
 * Check if workspace has an active paid subscription (pro, business, enterprise).
 * Free users have no subscription record.
 * In local mode we treat all workspaces as paid so devs can use any model.
 */
export async function hasPaidSubscription(workspaceId: string): Promise<boolean> {
  if (isLocalMode) return true
  const sub = await prisma.subscription.findFirst({
    where: {
      workspaceId,
      status: { in: ['active', 'trialing'] },
    },
  });
  return !!sub;
}

/**
 * Check if workspace has a plan that grants access to advanced (non-economy) models.
 * Returns true for Pro, Business, Enterprise. Returns false for Basic and free.
 * In local mode returns true so all features are accessible during development.
 */
export async function hasAdvancedModelAccess(workspaceId: string): Promise<boolean> {
  if (isLocalMode) return true
  const sub = await prisma.subscription.findFirst({
    where: {
      workspaceId,
      status: { in: ['active', 'trialing'] },
    },
    select: { planId: true },
  });
  if (!sub) return false
  return sub.planId !== 'basic'
}

/**
 * Check if workspace has a Business or Enterprise plan (active/trialing).
 * Returns false for Pro, free, or no subscription.
 * In local mode returns true so all features are accessible during development.
 */
export async function isBusinessOrHigherPlan(workspaceId: string): Promise<boolean> {
  if (isLocalMode) return true
  const sub = await prisma.subscription.findFirst({
    where: {
      workspaceId,
      status: { in: ['active', 'trialing'] },
    },
    select: { planId: true },
  });
  if (!sub) return false
  const plan = sub.planId.toLowerCase()
  return plan.startsWith('business') || plan.startsWith('enterprise')
}

/**
 * Check if workspace has sufficient USD to cover `minimumRequiredUsd`.
 * Applies the same lazy daily reset logic `consumeUsage` uses, including
 * the monthly cap on daily dispensing (`MONTHLY_DAILY_CAP_USD`). Overage
 * is treated as available when it's enabled AND the hard cap allows it.
 */
export async function hasBalance(
  workspaceId: string,
  minimumRequiredUsd = 0.001,
): Promise<boolean> {
  if (isLocalMode) return true

  let wallet = await prisma.usageWallet.findUnique({ where: { workspaceId } });
  if (!wallet) {
    wallet = await allocateFreeWallet(workspaceId);
  }
  if (!wallet) return false;

  const now = new Date();
  const needsDailyReset = now.toDateString() !== new Date(wallet.lastDailyReset).toDateString();

  let daily = wallet.dailyIncludedUsd;
  if (needsDailyReset) {
    const dispensed = isNewMonth(now, wallet.lastMonthlyReset) ? 0 : wallet.dailyUsedThisMonthUsd;
    daily = dispensed + DAILY_INCLUDED_USD <= MONTHLY_DAILY_CAP_USD ? DAILY_INCLUDED_USD : 0;
  }

  const included = daily + wallet.monthlyIncludedUsd;
  if (included >= minimumRequiredUsd) return true;

  if (!wallet.overageEnabled) return false;
  if (wallet.overageHardLimitUsd == null) return true;
  const overageRoom = Math.max(0, wallet.overageHardLimitUsd - wallet.overageAccumulatedUsd);
  return included + overageRoom >= minimumRequiredUsd;
}


function isNewMonth(now: Date, lastMonthlyReset: Date): boolean {
  return now.getUTCMonth() !== lastMonthlyReset.getUTCMonth() ||
         now.getUTCFullYear() !== lastMonthlyReset.getUTCFullYear()
}

const FK_RETRY_DELAYS = [1000, 2000, 4000]

function isFkConstraintError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    const prismaErr = err as { code: string; meta?: { field_name?: string } }
    return prismaErr.code === 'P2003' && prismaErr.meta?.field_name === 'usage_events_projectId_fkey'
  }
  return false
}

export interface ConsumeUsageParams {
  workspaceId: string
  projectId: string | null
  memberId: string
  actionType: string
  /** Raw provider cost in USD (no markup). Optional — falls back to billedUsd. */
  rawUsd?: number
  /** Marked-up USD to charge the workspace. */
  billedUsd: number
  actionMetadata?: Record<string, unknown>
}

export interface ConsumeUsageResult {
  success: boolean
  error?: string
  /** Remaining included USD after the debit (daily + monthly). */
  remainingIncludedUsd?: number
  /** How much of the debit hit overage (USD). */
  overageChargedUsd?: number
  /** Source of the deduction. */
  source?: UsageSource
}

/**
 * Consume USD for an action.
 * Deduction order: daily included -> monthly included -> overage (if enabled).
 * Retries on projectId FK constraint violations (race with project creation).
 */
export async function consumeUsage(
  params: ConsumeUsageParams,
): Promise<ConsumeUsageResult> {
  const { workspaceId, projectId, memberId, actionType, billedUsd, actionMetadata } = params
  const rawUsd = params.rawUsd ?? null

  if (isLocalMode) {
    try {
      await prisma.usageEvent.create({
        data: {
          workspaceId,
          projectId,
          memberId,
          actionType,
          rawUsd,
          billedUsd: 0,
          source: 'daily',
          balanceBefore: 0,
          balanceAfter: 0,
          actionMetadata: actionMetadata ?? null,
        },
      })
    } catch (e) {
      console.warn('[billing] Failed to record local usage event:', e)
    }
    return { success: true, remainingIncludedUsd: Infinity, overageChargedUsd: 0, source: 'daily' }
  }

  for (let attempt = 0; ; attempt++) {
    try {
      const result = await _consumeUsageTransaction(params)
      if (result.success && (result.overageChargedUsd ?? 0) > 0) {
        // Fire-and-forget mid-cycle block charging. We invoice the user in
        // $100 trust blocks as accumulated overage crosses each boundary;
        // any leftover sub-$100 amount carries over and gets billed on the
        // next crossing or end-of-period reconciliation.
        chargeOverageBlocks(workspaceId).catch((err) =>
          console.error('[billing] failed to charge overage blocks:', err),
        )
      }
      return result
    } catch (err) {
      if (projectId && isFkConstraintError(err) && attempt < FK_RETRY_DELAYS.length) {
        console.warn(`[billing] Project ${projectId} not found yet, retrying in ${FK_RETRY_DELAYS[attempt]}ms (attempt ${attempt + 1}/${FK_RETRY_DELAYS.length})`)
        await new Promise(r => setTimeout(r, FK_RETRY_DELAYS[attempt]))
        continue
      }
      throw err
    }
  }
}

/**
 * Legacy-compatible positional shim. Prefer `consumeUsage` above.
 * Treats `creditCost` as a raw credit amount and converts at $0.10/credit
 * to maintain wire compatibility during the rollout. New callers should
 * pass `billedUsd` directly via `consumeUsage`.
 *
 * @deprecated
 */
export async function consumeCredits(
  workspaceId: string,
  projectId: string | null,
  memberId: string,
  actionType: string,
  creditCost: number,
  actionMetadata?: Record<string, unknown>,
): Promise<{ success: boolean; error?: string; remainingCredits?: number }> {
  const billedUsd = creditCost * 0.10
  const res = await consumeUsage({
    workspaceId,
    projectId,
    memberId,
    actionType,
    billedUsd,
    actionMetadata,
  })
  return {
    success: res.success,
    error: res.error,
    remainingCredits: res.remainingIncludedUsd != null ? res.remainingIncludedUsd / 0.10 : undefined,
  }
}

async function _consumeUsageTransaction(
  params: ConsumeUsageParams,
): Promise<ConsumeUsageResult> {
  const { workspaceId, projectId, memberId, actionType, billedUsd, actionMetadata } = params
  const rawUsd = params.rawUsd ?? null

  return prisma.$transaction(async (tx) => {
    let wallet = await tx.usageWallet.findUnique({
      where: { workspaceId },
    });

    if (!wallet) {
      try {
        await allocateFreeWallet(workspaceId);
        wallet = await tx.usageWallet.findUnique({ where: { workspaceId } });
      } catch {
        // allocation failed, fall through
      }
      if (!wallet) {
        return { success: false, error: 'No usage wallet found for workspace' };
      }
    }

    // Lazy daily + monthly reset
    const now = new Date();
    const needsDailyReset = now.toDateString() !== new Date(wallet.lastDailyReset).toDateString();
    const needsMonthlyReset = isNewMonth(now, wallet.lastMonthlyReset);

    // Free-tier safety net: paid plans are refilled by `allocateMonthlyIncluded`
    // on `invoice.payment_succeeded`, but workspaces without a Stripe
    // subscription would otherwise drift forever. On a month rollover, refill
    // `monthlyIncludedUsd` from the active grants for free workspaces. We
    // skip paid workspaces here so we don't double-allocate over the
    // webhook (which has authoritative seat counts).
    let monthlyIncludedRefill: number | null = null
    if (needsMonthlyReset) {
      const paidSub = await tx.subscription.findFirst({
        where: { workspaceId, status: { in: ['active', 'trialing'] } },
        select: { id: true },
      })
      if (!paidSub) {
        const grant = await getActiveGrantsForWorkspace(workspaceId, now)
        monthlyIncludedRefill = PLAN_INCLUDED_USD.free + grant.monthlyIncludedUsd
      }
    }

    let dailyUsedThisMonthUsd = needsMonthlyReset ? 0 : wallet.dailyUsedThisMonthUsd;
    let dailyIncludedUsd: number;

    if (needsDailyReset) {
      if (dailyUsedThisMonthUsd + DAILY_INCLUDED_USD <= MONTHLY_DAILY_CAP_USD) {
        dailyIncludedUsd = DAILY_INCLUDED_USD;
        dailyUsedThisMonthUsd += DAILY_INCLUDED_USD;
      } else {
        dailyIncludedUsd = 0;
      }
    } else {
      dailyIncludedUsd = wallet.dailyIncludedUsd;
    }

    let monthlyIncludedUsd =
      monthlyIncludedRefill != null ? monthlyIncludedRefill : wallet.monthlyIncludedUsd;
    let overageAccumulatedUsd = needsMonthlyReset ? 0 : wallet.overageAccumulatedUsd;

    // Deduction order: daily -> monthly -> overage (if enabled).
    let source: UsageSource;
    let balanceBefore: number;
    let balanceAfter: number;
    let overageCharged = 0;

    if (dailyIncludedUsd >= billedUsd) {
      source = 'daily';
      balanceBefore = dailyIncludedUsd;
      dailyIncludedUsd -= billedUsd;
      balanceAfter = dailyIncludedUsd;
    } else if (monthlyIncludedUsd >= billedUsd) {
      source = 'monthly';
      balanceBefore = monthlyIncludedUsd;
      monthlyIncludedUsd -= billedUsd;
      balanceAfter = monthlyIncludedUsd;
    } else if (wallet.overageEnabled) {
      const overageRoom = wallet.overageHardLimitUsd == null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, wallet.overageHardLimitUsd - overageAccumulatedUsd);
      if (overageRoom < billedUsd) {
        return {
          success: false,
          error: 'Usage hard limit reached',
          remainingIncludedUsd: dailyIncludedUsd + monthlyIncludedUsd,
          source: 'overage',
        };
      }
      source = 'overage';
      balanceBefore = overageAccumulatedUsd;
      overageAccumulatedUsd += billedUsd;
      balanceAfter = overageAccumulatedUsd;
      overageCharged = billedUsd;
    } else {
      return {
        success: false,
        error: 'Usage limit reached',
        remainingIncludedUsd: dailyIncludedUsd + monthlyIncludedUsd,
      };
    }

    await tx.usageWallet.update({
      where: { workspaceId },
      data: {
        dailyIncludedUsd,
        monthlyIncludedUsd,
        overageAccumulatedUsd,
        dailyUsedThisMonthUsd,
        ...(needsDailyReset ? { lastDailyReset: now } : {}),
        ...(needsMonthlyReset ? { lastMonthlyReset: now } : {}),
        ...(monthlyIncludedRefill != null
          ? {
              monthlyIncludedAllocationUsd: monthlyIncludedRefill,
              overageBilledUsd: 0,
            }
          : {}),
      },
    });

    await tx.usageEvent.create({
      data: {
        workspaceId,
        projectId,
        memberId,
        actionType,
        actionMetadata: actionMetadata ?? null,
        rawUsd,
        billedUsd,
        source,
        balanceBefore,
        balanceAfter,
      },
    });

    return {
      success: true,
      remainingIncludedUsd: dailyIncludedUsd + monthlyIncludedUsd,
      overageChargedUsd: overageCharged,
      source,
    };
  });
}

/**
 * Charge whole overage blocks the workspace has crossed since the last
 * block was billed this period. Trust-first model with an escalating
 * ladder:
 *
 *   `overageAccumulatedUsd` is the marked-up USD the workspace has consumed
 *   beyond their included usage. `overageBilledUsd` is how much of that has
 *   already been invoiced + paid this period. The block size starts at
 *   `$100` and steps up by `$100` per successfully billed block, capped at
 *   `$500` (so trust grows with proven payment history but never spikes the
 *   card by more than `$500` in a single mid-cycle charge).
 *
 *   Sub-block leftovers carry to the next crossing or end-of-period
 *   reconciliation. If usage races past several thresholds at once we
 *   bundle them into a single invoice so customers don't get a flurry of
 *   small statements.
 *
 * Returns the number of blocks billed (zero is the steady state). Best
 * effort: logs and swallows errors so a missed Stripe call never blocks
 * usage from being recorded — `overageAccumulatedUsd` stays as the source
 * of truth and a future call (or end-of-period reconciler) will catch up.
 */
export async function chargeOverageBlocks(workspaceId: string): Promise<number> {
  const stripeKey = process.env.STRIPE_SECRET_KEY
  if (!stripeKey) {
    console.warn('[billing] STRIPE_SECRET_KEY unset; skipping overage block charge')
    return 0
  }

  const wallet = await prisma.usageWallet.findUnique({
    where: { workspaceId },
    select: {
      id: true,
      overageAccumulatedUsd: true,
      overageBilledUsd: true,
    },
  })
  if (!wallet) return 0

  // Walk the ladder against the unbilled balance: peel off as many full
  // blocks as fit, leaving any sub-block remainder for next time.
  const blockSizes: number[] = []
  let billedSimulated = wallet.overageBilledUsd
  let unbilled = wallet.overageAccumulatedUsd - wallet.overageBilledUsd
  while (unbilled > 0) {
    const size = nextOverageBlockUsd(billedSimulated)
    if (unbilled < size) break
    blockSizes.push(size)
    unbilled -= size
    billedSimulated += size
  }
  if (blockSizes.length === 0) return 0

  const sub = await prisma.subscription.findFirst({
    where: { workspaceId, status: { in: ['active', 'trialing'] } },
    select: { stripeCustomerId: true },
  })
  if (!sub?.stripeCustomerId) {
    console.warn(`[billing] no active Stripe customer for workspace ${workspaceId}; deferring overage block charge`)
    return 0
  }

  const { default: Stripe } = await import('stripe') as unknown as {
    default: new (key: string, opts?: unknown) => any
  }
  const stripe = new Stripe(stripeKey)

  const totalUsd = blockSizes.reduce((a, b) => a + b, 0)
  const blocksDue = blockSizes.length

  // Idempotency: keyed on (workspace, billed snapshot, total). Re-running
  // with the same prior state hits the same key, so Stripe dedupes a retry
  // even if our local update was rolled back.
  const idempotencyKey = `overage:${workspaceId}:${Math.round(wallet.overageBilledUsd)}:${Math.round(totalUsd)}`

  const blockBreakdown = blockSizes.map((s) => `$${s}`).join(' + ')
  const description = blocksDue === 1
    ? `Usage overage block (${blockBreakdown})`
    : `Usage overage (${blocksDue} blocks: ${blockBreakdown})`

  try {
    await stripe.invoiceItems.create(
      {
        customer: sub.stripeCustomerId,
        amount: totalUsd * 100, // cents
        currency: 'usd',
        description,
        metadata: {
          workspaceId,
          blocks: String(blocksDue),
          blockSizes: blockSizes.join(','),
          kind: 'overage_block',
        },
      },
      { idempotencyKey: `${idempotencyKey}:item` },
    )

    const invoice = await stripe.invoices.create(
      {
        customer: sub.stripeCustomerId,
        auto_advance: true,
        collection_method: 'charge_automatically',
        description: 'Mid-cycle usage overage',
        metadata: {
          workspaceId,
          kind: 'overage_block',
          blocks: String(blocksDue),
          blockSizes: blockSizes.join(','),
        },
      },
      { idempotencyKey: `${idempotencyKey}:invoice` },
    )
    await stripe.invoices.finalizeInvoice(invoice.id)
    try {
      await stripe.invoices.pay(invoice.id)
    } catch (payErr: any) {
      console.warn('[billing] overage invoice pay attempt failed (will retry via Stripe dunning):', payErr?.message ?? payErr)
    }

    await prisma.usageWallet.update({
      where: { workspaceId },
      data: { overageBilledUsd: { increment: totalUsd } },
    })

    console.log('[billing] Charged overage blocks:', {
      workspaceId,
      blocks: blocksDue,
      blockSizes,
      totalUsd,
    })
    return blocksDue
  } catch (err: any) {
    console.error('[billing] chargeOverageBlocks failed:', err?.message ?? err)
    return 0
  }
}

/**
 * @deprecated Trust-first overage now charges in $100 blocks via
 * `chargeOverageBlocks`. The Stripe Meter Events path is kept as a no-op
 * shim for callers that still import this symbol; it will be removed in a
 * follow-up after migration data is verified.
 */
export async function reportOverageToStripe(
  workspaceId: string,
  _amountUsd: number,
) {
  await chargeOverageBlocks(workspaceId)
}

/**
 * Sync subscription from Stripe webhook data.
 * One row per workspace (@@unique(workspaceId)); upsert updates stripeSubscriptionId when it changes.
 */
export async function syncFromStripe(data: {
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  workspaceId: string;
  planId: string;
  /** Number of paying seats. Defaults to 1. Basic is always 1. */
  seats?: number;
  status: SubscriptionStatus;
  billingInterval: BillingInterval;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd?: boolean;
}) {
  const seats = Math.max(1, Math.floor(data.seats ?? 1));
  return prisma.subscription.upsert({
    where: { workspaceId: data.workspaceId },
    create: {
      workspaceId: data.workspaceId,
      stripeSubscriptionId: data.stripeSubscriptionId,
      stripeCustomerId: data.stripeCustomerId,
      planId: data.planId,
      seats,
      status: data.status,
      billingInterval: data.billingInterval,
      currentPeriodStart: data.currentPeriodStart,
      currentPeriodEnd: data.currentPeriodEnd,
      cancelAtPeriodEnd: data.cancelAtPeriodEnd ?? false,
    },
    update: {
      stripeSubscriptionId: data.stripeSubscriptionId,
      stripeCustomerId: data.stripeCustomerId,
      planId: data.planId,
      seats,
      status: data.status,
      billingInterval: data.billingInterval,
      currentPeriodStart: data.currentPeriodStart,
      currentPeriodEnd: data.currentPeriodEnd,
      cancelAtPeriodEnd: data.cancelAtPeriodEnd ?? false,
    },
  });
}

/**
 * Get usage events for a workspace
 */
export async function getUsageEvents(
  workspaceId: string,
  options?: {
    projectId?: string;
    memberId?: string;
    limit?: number;
    offset?: number;
  }
) {
  return prisma.usageEvent.findMany({
    where: {
      workspaceId,
      ...(options?.projectId ? { projectId: options.projectId } : {}),
      ...(options?.memberId ? { memberId: options.memberId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: options?.limit ?? 100,
    skip: options?.offset ?? 0,
  });
}

/**
 * Get billing account for a workspace
 */
export async function getBillingAccount(workspaceId: string) {
  return prisma.billingAccount.findUnique({
    where: { workspaceId },
  });
}

/**
 * Create or update billing account
 */
export async function upsertBillingAccount(
  workspaceId: string,
  data: {
    stripeCustomerId?: string;
    taxId?: string;
  }
) {
  return prisma.billingAccount.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      stripeCustomerId: data.stripeCustomerId,
      taxId: data.taxId,
    },
    update: {
      stripeCustomerId: data.stripeCustomerId,
      taxId: data.taxId,
    },
  });
}

/**
 * Count the distinct active workspace-level members (excludes project-only
 * memberships and pending invites). This is the denominator for active-seat
 * billing.
 */
export async function countActiveWorkspaceMembers(workspaceId: string): Promise<number> {
  const rows = await prisma.member.findMany({
    where: { workspaceId, projectId: null },
    select: { userId: true },
  })
  const unique = new Set(rows.map((r: any) => r.userId))
  return Math.max(1, unique.size)
}

/**
 * Sync the Stripe seat quantity for a workspace's subscription so it matches
 * the count of distinct active workspace-level members.
 *
 * - Pro/Business plans: updates the existing per-seat subscription item with
 *   `proration_behavior: 'always_invoice'`, so additions are billed
 *   immediately (Cursor-style active seats) and removals appear as account
 *   credit on the next invoice.
 * - Basic plan: no-op (single user only).
 * - No active subscription: no-op (free tier; seats not billed).
 *
 * Returns `{ ok, planId, seats }` on success or `{ ok: false, reason }`
 * when the sync was skipped. Errors are caught and logged, never thrown.
 */
export async function syncSeatsFromMembership(
  workspaceId: string,
): Promise<{ ok: boolean; planId?: string; seats?: number; reason?: string }> {
  if (isLocalMode) return { ok: false, reason: 'local_mode' }

  try {
    const sub = await prisma.subscription.findFirst({
      where: { workspaceId, status: { in: ['active', 'trialing'] } },
    })
    if (!sub) return { ok: false, reason: 'no_active_subscription' }

    const planId = sub.planId.toLowerCase()
    if (planId === 'basic' || planId.startsWith('basic')) {
      return { ok: false, reason: 'basic_plan_single_seat' }
    }

    const totalMembers = await countActiveWorkspaceMembers(workspaceId)
    const grant = await getActiveGrantsForWorkspace(workspaceId)
    // v1: enforce a minimum of 1 paid Stripe seat. If a grant exceeds the
    // member count we still bill 1 seat so the Stripe subscription stays
    // active. Revisit later by pausing the seat item entirely when a
    // grant fully covers all members.
    const desiredStripeSeats = Math.max(1, totalMembers - grant.freeSeats)
    // The wallet's included USD reflects total seats (paid + granted).
    const includedUsd =
      getMonthlyIncludedForPlan(sub.planId, totalMembers) + grant.monthlyIncludedUsd

    if (desiredStripeSeats === sub.seats) {
      // Already in sync — still ensure the wallet allocation matches.
      await prisma.usageWallet.updateMany({
        where: { workspaceId },
        data: {
          monthlyIncludedUsd: includedUsd,
          monthlyIncludedAllocationUsd: includedUsd,
        },
      })
      return { ok: true, planId: sub.planId, seats: desiredStripeSeats }
    }

    const stripeKey = process.env.STRIPE_SECRET_KEY
    if (!stripeKey) {
      console.warn('[billing] STRIPE_SECRET_KEY unset; updating local seats only')
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { seats: desiredStripeSeats },
      })
      await prisma.usageWallet.updateMany({
        where: { workspaceId },
        data: {
          monthlyIncludedUsd: includedUsd,
          monthlyIncludedAllocationUsd: includedUsd,
        },
      })
      return { ok: true, planId: sub.planId, seats: desiredStripeSeats, reason: 'stripe_unconfigured' }
    }

    const { default: Stripe } = await import('stripe') as unknown as {
      default: new (key: string, opts?: unknown) => any
    }
    const stripe = new Stripe(stripeKey)

    // Find the per-seat licensed subscription item — it's the one whose price
    // is not the metered overage price. We avoid hard-coding the price id so
    // monthly/annual swaps don't break sync.
    const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId)
    const overageCfg = getOveragePriceConfig()
    const seatItem = stripeSub.items?.data?.find(
      (it: any) => it.price?.id !== overageCfg.priceId
        && it.price?.recurring?.usage_type !== 'metered',
    )
    if (!seatItem) {
      console.warn(`[billing] no seat item found on subscription ${sub.stripeSubscriptionId}`)
      return { ok: false, reason: 'no_seat_item' }
    }

    await stripe.subscriptionItems.update(seatItem.id, {
      quantity: desiredStripeSeats,
      // Bill the difference immediately on add, credit on remove. This matches
      // Cursor-style "billing adjusts immediately" behavior and avoids
      // surprise lump sums at period end.
      proration_behavior: 'always_invoice',
    })

    await prisma.subscription.update({
      where: { id: sub.id },
      data: { seats: desiredStripeSeats },
    })

    await prisma.usageWallet.updateMany({
      where: { workspaceId },
      data: {
        monthlyIncludedUsd: includedUsd,
        monthlyIncludedAllocationUsd: includedUsd,
      },
    })

    console.log('[billing] Synced seats from membership:', {
      workspaceId,
      planId: sub.planId,
      previousSeats: sub.seats,
      newStripeSeats: desiredStripeSeats,
      totalMembers,
      grantedFreeSeats: grant.freeSeats,
    })
    return { ok: true, planId: sub.planId, seats: desiredStripeSeats }
  } catch (err: any) {
    console.error('[billing] syncSeatsFromMembership failed:', err?.message ?? err)
    return { ok: false, reason: 'error' }
  }
}

/**
 * Toggle usage-based pricing (overage) and optional hard limit for a workspace.
 */
export async function setUsageBasedPricing(
  workspaceId: string,
  options: { overageEnabled: boolean; overageHardLimitUsd?: number | null },
) {
  return prisma.usageWallet.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      monthlyIncludedUsd: 0,
      dailyIncludedUsd: DAILY_INCLUDED_USD,
      overageEnabled: options.overageEnabled,
      overageHardLimitUsd: options.overageHardLimitUsd ?? null,
      anniversaryDay: new Date().getDate(),
      lastDailyReset: new Date(),
      lastMonthlyReset: new Date(),
    },
    update: {
      overageEnabled: options.overageEnabled,
      overageHardLimitUsd: options.overageHardLimitUsd ?? null,
    },
  });
}
