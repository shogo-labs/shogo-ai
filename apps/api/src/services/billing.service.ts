// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Billing Service — USD usage wallet + Stripe metered overage.
 *
 * Replaces the legacy credit-based ledger. Spend is tracked in USD; every
 * action charges raw provider cost times `MARKUP_MULTIPLIER` (Cursor-style).
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
import { USAGE_OVERAGE_METERING_ENABLED } from '../config/feature-flags';

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
 *
 * Kept under the legacy name `getCreditLedger` as a thin compat alias below
 * so external callers don't break during the rollout.
 */
export async function getUsageWallet(workspaceId: string) {
  return prisma.usageWallet.findUnique({
    where: { workspaceId },
  });
}

/** @deprecated Use getUsageWallet. */
export const getCreditLedger = getUsageWallet;

/**
 * Allocate free-tier wallet for a new workspace (daily included, no monthly).
 */
export async function allocateFreeWallet(workspaceId: string) {
  const now = new Date();

  const existing = await prisma.usageWallet.findUnique({
    where: { workspaceId },
  });
  if (existing) return existing;

  return prisma.usageWallet.create({
    data: {
      workspaceId,
      monthlyIncludedUsd: PLAN_INCLUDED_USD.free,
      dailyIncludedUsd: DAILY_INCLUDED_USD,
      anniversaryDay: now.getDate(),
      lastDailyReset: now,
      lastMonthlyReset: now,
    },
  });
}

/** @deprecated Use allocateFreeWallet. */
export const allocateFreeCredits = allocateFreeWallet;

/**
 * Allocate the monthly included USD for a subscription plan. Resets
 * accumulated overage so the upcoming period starts clean (the flushed
 * overage should have already been reported to Stripe by `consumeUsage`).
 */
export async function allocateMonthlyIncluded(
  workspaceId: string,
  planId: string,
) {
  const monthlyIncludedUsd = getMonthlyIncludedForPlan(planId);
  const now = new Date();

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
      overageAccumulatedUsd: 0,
      lastMonthlyReset: now,
    },
  });
}

/** @deprecated Use allocateMonthlyIncluded. */
export const allocateMonthlyCredits = allocateMonthlyIncluded;

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

/** @deprecated Use hasBalance. Legacy credit name. */
export const hasCredits = hasBalance;

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
        // Fire-and-forget metered report. Stripe is eventually-consistent.
        reportOverageToStripe(workspaceId, result.overageChargedUsd!).catch((err) =>
          console.error('[billing] failed to report overage to Stripe:', err),
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

    let monthlyIncludedUsd = wallet.monthlyIncludedUsd;
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
 * Report marked-up overage in USD to Stripe via the Meter Events API.
 *
 * Stripe API versions >= 2025-03-31.basil require metered prices to be backed
 * by a `billing.meter`; the legacy `subscription_items.create_usage_record`
 * path no longer accepts new prices. We emit a `billing.meter_event` with the
 * payload `{ stripe_customer_id, value }` and Stripe routes the volume to
 * the metered price item attached to the customer's subscription.
 *
 * Lazily ensures the metered price item is attached to the active subscription
 * (and stamps `usageWallet.stripeMeteredItemId` on first attach so we have a
 * cheap idempotency check).
 *
 * Best-effort: logs and swallows errors. The amount stays in
 * `overageAccumulatedUsd` so a reconciler can retry later.
 */
export async function reportOverageToStripe(
  workspaceId: string,
  amountUsd: number,
) {
  if (amountUsd <= 0) return

  if (!USAGE_OVERAGE_METERING_ENABLED) {
    // Feature flag off during staged rollout: keep the overage in
    // `overageAccumulatedUsd` so a later reconciler can flush it.
    return
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY
  if (!stripeKey) {
    console.warn('[billing] STRIPE_SECRET_KEY unset; skipping overage report')
    return
  }

  const sub = await prisma.subscription.findFirst({
    where: { workspaceId, status: { in: ['active', 'trialing'] } },
    select: { stripeSubscriptionId: true, stripeCustomerId: true },
  })
  if (!sub?.stripeSubscriptionId || !sub.stripeCustomerId) {
    console.warn(`[billing] no active Stripe subscription/customer for workspace ${workspaceId}; overage not reported`)
    return
  }

  const wallet = await prisma.usageWallet.findUnique({
    where: { workspaceId },
    select: { stripeMeteredItemId: true },
  })

  const { default: Stripe } = await import('stripe') as unknown as {
    default: new (key: string, opts?: unknown) => any
  }
  const stripe = new Stripe(stripeKey)

  const cfg = getOveragePriceConfig()
  let subscriptionItemId = wallet?.stripeMeteredItemId ?? null

  if (!subscriptionItemId) {
    const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId)
    const existingItem = stripeSub.items?.data?.find(
      (it: any) => it.price?.id === cfg.priceId,
    )
    if (existingItem) {
      subscriptionItemId = existingItem.id
    } else {
      const created = await stripe.subscriptionItems.create({
        subscription: sub.stripeSubscriptionId,
        price: cfg.priceId,
      })
      subscriptionItemId = created.id
    }
    await prisma.usageWallet.update({
      where: { workspaceId },
      data: { stripeMeteredItemId: subscriptionItemId },
    })
  }

  const value = Math.max(1, Math.round(amountUsd * cfg.unitsPerDollar))
  // Idempotency: Stripe dedupes meter events by `identifier` within a 24h
  // window. Pair workspace + minute + value to absorb retries while still
  // keeping legitimate distinct events.
  const identifier = `${workspaceId}-${Math.floor(Date.now() / 60000)}-${value}`

  await stripe.billing.meterEvents.create({
    event_name: cfg.meterEventName,
    payload: {
      stripe_customer_id: sub.stripeCustomerId,
      value: String(value),
    },
    identifier,
  })
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
  status: SubscriptionStatus;
  billingInterval: BillingInterval;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd?: boolean;
}) {
  return prisma.subscription.upsert({
    where: { workspaceId: data.workspaceId },
    create: {
      workspaceId: data.workspaceId,
      stripeSubscriptionId: data.stripeSubscriptionId,
      stripeCustomerId: data.stripeCustomerId,
      planId: data.planId,
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
