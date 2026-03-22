// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Billing Service - Prisma-based billing operations
 * Replaces billingDomain.createStore() for subscriptions, credits, usage
 */

import { prisma, type Prisma, CreditSource, SubscriptionStatus, BillingInterval, PlanId } from '../lib/prisma';
import { DAILY_CREDITS, PLAN_CREDITS, getMonthlyCreditsForPlan } from '../config/credit-plans';

const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true'

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
 * Get credit ledger for a workspace
 */
export async function getCreditLedger(workspaceId: string) {
  return prisma.creditLedger.findUnique({
    where: { workspaceId },
  });
}

/**
 * Allocate free credits for a new workspace (daily + monthly starter credits)
 */
export async function allocateFreeCredits(workspaceId: string) {
  const now = new Date();

  // Check if ledger already exists
  const existing = await prisma.creditLedger.findUnique({
    where: { workspaceId },
  });

  if (existing) {
    return existing;
  }

  return prisma.creditLedger.create({
    data: {
      workspaceId,
      monthlyCredits: PLAN_CREDITS.free,
      dailyCredits: DAILY_CREDITS,
      rolloverCredits: 0,
      anniversaryDay: now.getDate(),
      lastDailyReset: now,
      lastMonthlyReset: now,
    },
  });
}

/**
 * Allocate monthly credits based on subscription plan
 */
export async function allocateMonthlyCredits(
  workspaceId: string,
  planId: string
) {
  const monthlyCredits = getMonthlyCreditsForPlan(planId);

  const now = new Date();

  return prisma.creditLedger.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      monthlyCredits,
      dailyCredits: DAILY_CREDITS,
      rolloverCredits: 0,
      anniversaryDay: now.getDate(),
      lastDailyReset: now,
      lastMonthlyReset: now,
    },
    update: {
      monthlyCredits,
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
 * Check if workspace has sufficient credits (without deducting).
 * Uses lazy daily reset logic for accurate balance.
 */
export async function hasCredits(workspaceId: string, minimumRequired = 0.5): Promise<boolean> {
  if (isLocalMode) return true

  let ledger = await prisma.creditLedger.findUnique({ where: { workspaceId } });
  if (!ledger) {
    ledger = await allocateFreeCredits(workspaceId);
  }
  if (!ledger) return false;

  const now = new Date();
  const needsReset = now.toDateString() !== new Date(ledger.lastDailyReset).toDateString();
  const daily = needsReset ? DAILY_CREDITS : ledger.dailyCredits;
  return (daily + ledger.monthlyCredits + ledger.rolloverCredits) >= minimumRequired;
}

const FK_RETRY_DELAYS = [1000, 2000, 4000]

function isFkConstraintError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    const prismaErr = err as { code: string; meta?: { field_name?: string } }
    return prismaErr.code === 'P2003' && prismaErr.meta?.field_name === 'usage_events_projectId_fkey'
  }
  return false
}

/**
 * Consume credits for an action.
 * Deduction order: daily → monthly → rollover → insufficient.
 * Retries on projectId FK constraint violations (race with project creation).
 */
export async function consumeCredits(
  workspaceId: string,
  projectId: string | null,
  memberId: string,
  actionType: string,
  creditCost: number,
  actionMetadata?: Record<string, unknown>
): Promise<{ success: boolean; error?: string; remainingCredits?: number }> {
  if (isLocalMode) return { success: true, remainingCredits: Infinity }

  for (let attempt = 0; ; attempt++) {
    try {
      return await _consumeCreditsTransaction(workspaceId, projectId, memberId, actionType, creditCost, actionMetadata)
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

async function _consumeCreditsTransaction(
  workspaceId: string,
  projectId: string | null,
  memberId: string,
  actionType: string,
  creditCost: number,
  actionMetadata?: Record<string, unknown>
): Promise<{ success: boolean; error?: string; remainingCredits?: number }> {
  return prisma.$transaction(async (tx) => {
    // Get current ledger (or lazy-create free tier for new workspaces)
    let ledger = await tx.creditLedger.findUnique({
      where: { workspaceId },
    });

    if (!ledger) {
      try {
        await allocateFreeCredits(workspaceId);
        ledger = await tx.creditLedger.findUnique({ where: { workspaceId } });
      } catch {
        // allocation failed, fall through
      }
      if (!ledger) {
        return { success: false, error: 'No credit ledger found for workspace' };
      }
    }

    // Lazy daily reset
    const now = new Date();
    const needsDailyReset = now.toDateString() !== new Date(ledger.lastDailyReset).toDateString();

    let dailyCredits = needsDailyReset ? DAILY_CREDITS : ledger.dailyCredits;
    let monthlyCredits = ledger.monthlyCredits;
    let rolloverCredits = ledger.rolloverCredits;

    // Deduction order: daily → monthly → rollover
    let creditSource: CreditSource;
    let balanceBefore: number;
    let balanceAfter: number;

    if (dailyCredits >= creditCost) {
      creditSource = 'daily';
      balanceBefore = dailyCredits;
      dailyCredits -= creditCost;
      balanceAfter = dailyCredits;
    } else if (monthlyCredits >= creditCost) {
      creditSource = 'monthly';
      balanceBefore = monthlyCredits;
      monthlyCredits -= creditCost;
      balanceAfter = monthlyCredits;
    } else if (rolloverCredits >= creditCost) {
      // Rollover credits (tracked as 'monthly' source since they originate from unused monthly)
      creditSource = 'monthly';
      balanceBefore = rolloverCredits;
      rolloverCredits -= creditCost;
      balanceAfter = rolloverCredits;
    } else {
      return {
        success: false,
        error: 'Insufficient credits',
        remainingCredits: dailyCredits + monthlyCredits + rolloverCredits,
      };
    }

    // Update the ledger
    await tx.creditLedger.update({
      where: { workspaceId },
      data: {
        dailyCredits,
        monthlyCredits,
        rolloverCredits,
        ...(needsDailyReset ? { lastDailyReset: now } : {}),
      },
    });

    // Record usage event
    await tx.usageEvent.create({
      data: {
        workspaceId,
        projectId,
        memberId,
        actionType,
        actionMetadata: actionMetadata as Prisma.InputJsonValue,
        creditCost,
        creditSource,
        balanceBefore,
        balanceAfter,
      },
    });

    return {
      success: true,
      remainingCredits: dailyCredits + monthlyCredits + rolloverCredits,
    };
  });
}

/**
 * Sync subscription from Stripe webhook data
 */
export async function syncFromStripe(data: {
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  workspaceId: string;
  planId: PlanId;
  status: SubscriptionStatus;
  billingInterval: BillingInterval;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd?: boolean;
}) {
  return prisma.subscription.upsert({
    where: { stripeSubscriptionId: data.stripeSubscriptionId },
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
