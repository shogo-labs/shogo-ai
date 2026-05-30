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
  FREE_DAILY_INCLUDED_USD,
  PLAN_INCLUDED_USD,
  PLAN_RANK,
  FIVE_HOUR_MS,
  SEVEN_DAY_MS,
  comparePlanRank,
  getDailyIncludedForPlan,
  getMonthlyIncludedForPlan,
  getWindowLimitsForPlan,
  normalizePlanId,
  type WindowLimits,
} from '../config/usage-plans';
import { getOveragePriceConfig } from '../config/stripe-prices';
const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true'

/**
 * USD source a usage event was charged against. Mirrors the DB enum.
 * `window` = charged against a rolling usage window (the time-gated
 * "unlimited" path); `overage` = beyond the window, metered to Stripe.
 * `daily`/`monthly` are retained for legacy events and local mode.
 */
export type UsageSource = 'daily' | 'monthly' | 'overage' | 'window'

/** Identifies which rolling window gated a request. */
export type UsageWindowKind = 'five_hour' | 'weekly'

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
 *
 * `planId` is the *highest* tier among any active grants that declared
 * one (via `comparePlanRank`). It's the plan the workspace should be
 * treated as on when there is no active paid subscription; the caller
 * is responsible for skipping it when a paid sub exists. `null` when
 * no grant has a planId — preserving the legacy "additive credit only"
 * semantics for callers that don't care about plan upgrades.
 */
export async function getActiveGrantsForWorkspace(
  workspaceId: string,
  now: Date = new Date(),
): Promise<{
  freeSeats: number
  monthlyIncludedUsd: number
  planId: string | null
  rowCount: number
}> {
  const rows = await prisma.workspaceGrant.findMany({
    where: {
      workspaceId,
      startsAt: { lte: now },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { freeSeats: true, monthlyIncludedUsd: true, planId: true },
  })
  let freeSeats = 0
  let monthlyIncludedUsd = 0
  let planId: string | null = null
  for (const r of rows) {
    freeSeats += r.freeSeats
    monthlyIncludedUsd += r.monthlyIncludedUsd
    if (r.planId && comparePlanRank(r.planId, planId) > 0) {
      planId = r.planId
    }
  }
  return { freeSeats, monthlyIncludedUsd, planId, rowCount: rows.length }
}

/**
 * Resolve the "effective" plan id for a workspace given its active
 * paid subscription (if any) and active grants. Returns the highest
 * tier from either source; falls back to `'free'` when neither is
 * present. Normalized via `normalizePlanId`, so callers get one of
 * `free|basic|pro|business|enterprise`.
 *
 * A paid subscription always wins over a grant's `planId` (the
 * subscription is what Stripe is actually billing); the grant only
 * meaningfully upgrades workspaces without a paid sub.
 */
export async function getEffectivePlanId(
  workspaceId: string,
  now: Date = new Date(),
): Promise<keyof typeof PLAN_RANK> {
  const sub = await prisma.subscription.findFirst({
    where: { workspaceId, status: { in: ['active', 'trialing'] } },
    select: { planId: true },
  })
  if (sub) {
    return normalizePlanId(sub.planId) ?? 'free'
  }
  const grant = await getActiveGrantsForWorkspace(workspaceId, now)
  return normalizePlanId(grant.planId) ?? 'free'
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
      dailyIncludedUsd: FREE_DAILY_INCLUDED_USD,
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
 * - Resolves the wallet's plan tier from the highest active grant
 *   `planId` (falling back to `free`), then computes monthly USD as
 *   `getMonthlyIncludedForPlan(plan, max(1, freeSeats)) +
 *   grant.monthlyIncludedUsd`. For grants with no `planId` this reduces
 *   to `PLAN_INCLUDED_USD.free + grant.monthlyIncludedUsd` — the legacy
 *   behavior.
 * - Resets `dailyUsedThisMonthUsd`, `overageAccumulatedUsd`,
 *   `overageBilledUsd` so the new period starts clean.
 * - Advances `lastMonthlyReset` to `now`. When a grant confers a paid
 *   plan we also turn `overageEnabled` on so trust-first overage applies
 *   the same as for paid Stripe plans.
 */
export async function applyGrantMonthlyAllocation(
  workspaceId: string,
  now: Date = new Date(),
) {
  const grant = await getActiveGrantsForWorkspace(workspaceId, now)
  const plan = normalizePlanId(grant.planId) ?? 'free'
  // Grant-conferred seats count toward the plan's per-seat included USD.
  // Free seats default to 1 so a plan-only grant still allocates at
  // least one seat's worth of USD.
  const grantSeats = Math.max(1, grant.freeSeats || 0)
  const monthlyIncludedUsd =
    getMonthlyIncludedForPlan(plan, grantSeats) + grant.monthlyIncludedUsd
  // Trust-first overage matches the paid-plan path only for grants that
  // actually confer a paid tier. Pure additive credit grants on free
  // workspaces stay on the prior `overageEnabled` value (handled below).
  const isPaidGrant = PLAN_RANK[plan] >= PLAN_RANK.basic

  return prisma.usageWallet.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      monthlyIncludedUsd,
      monthlyIncludedAllocationUsd: monthlyIncludedUsd,
      dailyIncludedUsd: getDailyIncludedForPlan(plan),
      anniversaryDay: now.getDate(),
      lastDailyReset: now,
      lastMonthlyReset: now,
      overageEnabled: isPaidGrant,
    },
    update: {
      monthlyIncludedUsd,
      monthlyIncludedAllocationUsd: monthlyIncludedUsd,
      dailyUsedThisMonthUsd: 0,
      overageAccumulatedUsd: 0,
      overageBilledUsd: 0,
      lastMonthlyReset: now,
      ...(isPaidGrant ? { overageEnabled: true } : {}),
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
      dailyIncludedUsd: getDailyIncludedForPlan(planId),
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
 * Check if workspace has an active paid plan (pro, business, enterprise).
 * Either an active Stripe subscription or a super-admin `WorkspaceGrant`
 * with a `planId` qualifies — grants are first-class plan upgrades, not
 * just additive credits. Free users have neither.
 *
 * In local mode we treat all workspaces as paid so devs can use any model.
 */
export async function hasPaidSubscription(workspaceId: string): Promise<boolean> {
  if (isLocalMode) return true
  const plan = await getEffectivePlanId(workspaceId)
  return PLAN_RANK[plan] >= PLAN_RANK.basic
}

/**
 * Check if workspace has a plan that grants access to advanced (non-economy) models.
 * Returns true for Pro, Business, Enterprise (whether granted via a paid
 * subscription or via a super-admin grant's `planId`). Returns false for
 * Basic and free.
 * In local mode returns true so all features are accessible during development.
 */
export async function hasAdvancedModelAccess(workspaceId: string): Promise<boolean> {
  if (isLocalMode) return true
  const plan = await getEffectivePlanId(workspaceId)
  return PLAN_RANK[plan] >= PLAN_RANK.pro
}

/**
 * Check if workspace has a Business or Enterprise plan, whether via
 * Stripe subscription or super-admin grant. Returns false for Pro,
 * free, or unconfigured workspaces.
 * In local mode returns true so all features are accessible during development.
 */
export async function isBusinessOrHigherPlan(workspaceId: string): Promise<boolean> {
  if (isLocalMode) return true
  const plan = await getEffectivePlanId(workspaceId)
  return PLAN_RANK[plan] >= PLAN_RANK.business
}

/** Snapshot of one rolling usage window for the usage endpoint / UI. */
export interface UsageWindowSnapshot {
  kind: UsageWindowKind
  usedUsd: number
  /** `null` when the plan is uncapped (enterprise). */
  limitUsd: number | null
  /** 0..1; always 0 for uncapped plans. */
  utilization: number
  /** When the window next resets, or `null` if it hasn't opened yet. */
  resetsAt: Date | null
}

/**
 * Compute the current state of a workspace's rolling windows, applying the
 * same lazy reset semantics as `consumeUsage` (without persisting). Returns
 * `null` per-window limit for uncapped plans.
 */
export async function getUsageWindows(
  workspaceId: string,
): Promise<{ fiveHour: UsageWindowSnapshot; weekly: UsageWindowSnapshot }> {
  const now = new Date()
  let wallet = await prisma.usageWallet.findUnique({ where: { workspaceId } })
  if (!wallet) wallet = await allocateFreeWallet(workspaceId)

  const limits = await resolveWorkspaceWindowLimits(prisma, workspaceId, now)
  const five = rollWindow(wallet?.fiveHourWindowStart, wallet?.fiveHourUsedUsd ?? 0, now, FIVE_HOUR_MS)
  const week = rollWindow(wallet?.weeklyWindowStart, wallet?.weeklyUsedUsd ?? 0, now, SEVEN_DAY_MS)

  const fiveOpened = !!wallet?.fiveHourWindowStart && five.start.getTime() === new Date(wallet.fiveHourWindowStart).getTime()
  const weekOpened = !!wallet?.weeklyWindowStart && week.start.getTime() === new Date(wallet.weeklyWindowStart).getTime()

  const snapshot = (
    kind: UsageWindowKind,
    state: RollingWindowState,
    limitUsd: number | null,
    durationMs: number,
    opened: boolean,
  ): UsageWindowSnapshot => ({
    kind,
    usedUsd: opened ? state.used : 0,
    limitUsd,
    utilization: limitUsd && limitUsd > 0 ? Math.min(1, (opened ? state.used : 0) / limitUsd) : 0,
    resetsAt: opened ? new Date(state.start.getTime() + durationMs) : null,
  })

  return {
    fiveHour: snapshot('five_hour', five, limits?.fiveHourUsd ?? null, FIVE_HOUR_MS, fiveOpened),
    weekly: snapshot('weekly', week, limits?.weeklyUsd ?? null, SEVEN_DAY_MS, weekOpened),
  }
}

/**
 * Check if workspace can spend at least `minimumRequiredUsd`. True when
 * either rolling window still has room, when the plan is uncapped, or when
 * metered overage is enabled and within its hard cap.
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
  const limits = await resolveWorkspaceWindowLimits(prisma, workspaceId, now);

  // Uncapped plan (enterprise): always has balance.
  if (limits == null) return true;

  const five = rollWindow(wallet.fiveHourWindowStart, wallet.fiveHourUsedUsd, now, FIVE_HOUR_MS);
  const week = rollWindow(wallet.weeklyWindowStart, wallet.weeklyUsedUsd, now, SEVEN_DAY_MS);
  const windowRoom = Math.min(limits.fiveHourUsd - five.used, limits.weeklyUsd - week.used);
  if (windowRoom >= minimumRequiredUsd) return true;

  // Windows exhausted — overage is the fallback when enabled and uncapped.
  if (!wallet.overageEnabled) return false;
  if (wallet.overageHardLimitUsd == null) return true;
  const overageRoom = Math.max(0, wallet.overageHardLimitUsd - wallet.overageAccumulatedUsd);
  return overageRoom >= minimumRequiredUsd;
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
  /**
   * Remaining USD before the gating limit after the debit. For the window
   * path this is the smaller of the two windows' remaining room; for overage
   * it reflects remaining included room (0 once windows are exhausted).
   */
  remainingIncludedUsd?: number
  /** How much of the debit hit overage (USD). */
  overageChargedUsd?: number
  /** Source of the deduction. */
  source?: UsageSource
  /**
   * When a request is blocked (or fell through to overage) because a rolling
   * window is exhausted, the UTC time the blocking window next resets.
   */
  resetsAt?: Date
  /** Which window was exhausted, when `resetsAt` is set. */
  window?: UsageWindowKind
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

    const now = new Date();

    // Resolve the workspace's rolling-window limits (plan + seats). `null`
    // means uncapped (enterprise): usage is unbounded within the windows.
    const limits = await resolveWorkspaceWindowLimits(tx, workspaceId, now);

    // Lazy window reset: a window "opens" on the first action and resets once
    // its full duration has elapsed (fixed-window-from-first-event).
    const five = rollWindow(wallet.fiveHourWindowStart, wallet.fiveHourUsedUsd, now, FIVE_HOUR_MS);
    const week = rollWindow(wallet.weeklyWindowStart, wallet.weeklyUsedUsd, now, SEVEN_DAY_MS);

    // Monthly boundary still governs overage bookkeeping (overage is invoiced
    // per Stripe period). The included USD pools are no longer drained — the
    // rolling windows are the gate — so we only reset overage accounting here.
    const needsMonthlyReset = isNewMonth(now, wallet.lastMonthlyReset);
    let overageAccumulatedUsd = needsMonthlyReset ? 0 : wallet.overageAccumulatedUsd;

    let source: UsageSource;
    let balanceBefore: number;
    let balanceAfter: number;
    let overageCharged = 0;
    let chargedToWindows = false;

    if (limits == null) {
      // Uncapped plan: always allowed, but still accrue window usage so the
      // usage endpoint can surface consumption.
      source = 'window';
      balanceBefore = Number.POSITIVE_INFINITY;
      balanceAfter = Number.POSITIVE_INFINITY;
      chargedToWindows = true;
    } else {
      const fiveRoom = limits.fiveHourUsd - five.used;
      const weekRoom = limits.weeklyUsd - week.used;
      const fitsFive = fiveRoom >= billedUsd;
      const fitsWeek = weekRoom >= billedUsd;

      if (fitsFive && fitsWeek) {
        source = 'window';
        balanceBefore = Math.min(fiveRoom, weekRoom);
        balanceAfter = balanceBefore - billedUsd;
        chargedToWindows = true;
      } else {
        // A window is exhausted. Compute which window blocks and when it
        // resets so the caller can surface a "resets in X" message.
        const { window, resetsAt } = blockingWindow(
          fitsFive,
          fitsWeek,
          five.start,
          week.start,
        );

        if (wallet.overageEnabled) {
          const overageRoom = wallet.overageHardLimitUsd == null
            ? Number.POSITIVE_INFINITY
            : Math.max(0, wallet.overageHardLimitUsd - overageAccumulatedUsd);
          if (overageRoom < billedUsd) {
            return {
              success: false,
              error: 'Usage hard limit reached',
              remainingIncludedUsd: 0,
              source: 'overage',
              window,
              resetsAt,
            };
          }
          // Beyond-window usage is metered to overage and does NOT accrue to
          // the windows (the window is already full).
          source = 'overage';
          balanceBefore = overageAccumulatedUsd;
          overageAccumulatedUsd += billedUsd;
          balanceAfter = overageAccumulatedUsd;
          overageCharged = billedUsd;
        } else {
          return {
            success: false,
            error: 'Usage limit reached',
            remainingIncludedUsd: 0,
            window,
            resetsAt,
          };
        }
      }
    }

    if (chargedToWindows) {
      five.used += billedUsd;
      week.used += billedUsd;
    }

    await tx.usageWallet.update({
      where: { workspaceId },
      data: {
        fiveHourWindowStart: five.start,
        fiveHourUsedUsd: five.used,
        weeklyWindowStart: week.start,
        weeklyUsedUsd: week.used,
        overageAccumulatedUsd,
        ...(needsMonthlyReset ? { lastMonthlyReset: now, overageBilledUsd: 0 } : {}),
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
        balanceBefore: Number.isFinite(balanceBefore) ? balanceBefore : 0,
        balanceAfter: Number.isFinite(balanceAfter) ? balanceAfter : 0,
      },
    });

    const remainingIncludedUsd = limits == null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.min(limits.fiveHourUsd - five.used, limits.weeklyUsd - week.used));

    return {
      success: true,
      remainingIncludedUsd,
      overageChargedUsd: overageCharged,
      source,
    };
  });
}

/** Mutable rolling-window state used inside the consume transaction. */
interface RollingWindowState {
  start: Date
  used: number
}

/**
 * Apply the lazy reset for a single rolling window. If the window has never
 * opened (`start == null`) or its duration has fully elapsed, it reopens at
 * `now` with zero usage; otherwise the existing start/used are preserved.
 */
function rollWindow(
  start: Date | null | undefined,
  used: number,
  now: Date,
  durationMs: number,
): RollingWindowState {
  if (!start || now.getTime() - new Date(start).getTime() >= durationMs) {
    return { start: now, used: 0 }
  }
  return { start: new Date(start), used }
}

/**
 * Determine which window blocked the request and when it next resets.
 * When both windows are full, the later reset wins (the request needs both
 * to clear), and we attribute it to the weekly window as the longer pole.
 */
function blockingWindow(
  fitsFive: boolean,
  fitsWeek: boolean,
  fiveStart: Date,
  weekStart: Date,
): { window: UsageWindowKind; resetsAt: Date } {
  const fiveResetsAt = new Date(fiveStart.getTime() + FIVE_HOUR_MS)
  const weekResetsAt = new Date(weekStart.getTime() + SEVEN_DAY_MS)
  if (!fitsFive && !fitsWeek) {
    return weekResetsAt.getTime() >= fiveResetsAt.getTime()
      ? { window: 'weekly', resetsAt: weekResetsAt }
      : { window: 'five_hour', resetsAt: fiveResetsAt }
  }
  if (!fitsWeek) return { window: 'weekly', resetsAt: weekResetsAt }
  return { window: 'five_hour', resetsAt: fiveResetsAt }
}

/**
 * Resolve a workspace's rolling-window limits from its effective plan and
 * seat count. Active Stripe subscription wins (seats from the sub); otherwise
 * the highest active grant's plan and free-seat count apply; otherwise free.
 * Returns `null` for uncapped (enterprise) plans.
 *
 * Reads are issued through the surrounding transaction client where possible
 * to stay consistent with the wallet read.
 */
async function resolveWorkspaceWindowLimits(
  tx: { subscription: { findFirst: typeof prisma.subscription.findFirst } },
  workspaceId: string,
  now: Date,
): Promise<WindowLimits | null> {
  const sub = await tx.subscription.findFirst({
    where: { workspaceId, status: { in: ['active', 'trialing'] } },
    select: { planId: true, seats: true },
  })
  if (sub) {
    const plan = normalizePlanId(sub.planId) ?? 'free'
    return getWindowLimitsForPlan(plan, sub.seats)
  }
  const grant = await getActiveGrantsForWorkspace(workspaceId, now)
  const plan = normalizePlanId(grant.planId) ?? 'free'
  const seats = Math.max(1, grant.freeSeats || 0)
  return getWindowLimitsForPlan(plan, seats)
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
      // Overage is a paid-plan feature, so seed with $0 here. The free-tier
      // daily allowance is applied via `allocateFreeWallet` for free
      // workspaces (which run that path before they'd hit this one).
      dailyIncludedUsd: 0,
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
