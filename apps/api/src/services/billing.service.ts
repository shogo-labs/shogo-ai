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
import { notifyOverageCharged, evaluateUsageAlerts } from './billing-alerts.service';
import {
  FREE_DAILY_INCLUDED_USD,
  PLAN_INCLUDED_USD,
  PLAN_RANK,
  FIVE_HOUR_MS,
  SEVEN_DAY_MS,
  comparePlanRank,
  getAlwaysOnAllowance,
  getDailyIncludedForPlan,
  getMonthlyIncludedForPlan,
  getWindowLimitsForPlan,
  normalizePlanId,
  promoCreditAvailableUsd,
  type WindowLimits,
} from '../config/usage-plans';
import { getOveragePriceConfig } from '../config/stripe-prices';
import { RAW_REGION_ID, PRIMARY_REGION, getPeer } from '../lib/region';
import { callPeerInternal } from '../lib/region-peer-proxy';
import {
  meetsMinimumInstanceSize,
  type InstanceSizeName,
} from '../config/instance-sizes';
import { getMinimumInstanceSize } from '@shogo/shared-runtime';
import { usageLimitErrorPayload, type BalanceCheck, type UsageBlockReason } from './usage-limits';
import { recordLocalUsage } from './billing-local';
import { invalidateAnalyticsCache } from '../lib/analytics-cache';
import { invalidateAgentReplyCapacity } from './agent-reply-capacity';
export { usageLimitErrorPayload, type BalanceCheck, type UsageBlockReason };
const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true'

/**
 * USD source a usage event was charged against. Mirrors the DB enum.
 * `window` = charged against a rolling usage window (the time-gated
 * "unlimited" path); `overage` = beyond the window, metered to Stripe.
 * `daily`/`monthly` are retained for legacy events and local mode.
 */
export type UsageSource = 'daily' | 'monthly' | 'overage' | 'window' | 'promo'

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
 * Resolve the workspace whose billing primitives (subscription, usage wallet,
 * grants, seats) actually govern `workspaceId`.
 *
 * A "child" workspace (one with a `parentWorkspaceId`) pools its parent's
 * plan, wallet, and seats — it has no subscription/wallet of its own. For such
 * a workspace this returns the parent id; otherwise it returns the id
 * unchanged. The `system` sentinel and local mode are passed through.
 *
 * Hierarchy is intentionally a single level: only Business/Enterprise (top-level)
 * workspaces may have children, so we never need to walk more than one hop.
 */
export async function resolveBillingWorkspaceId(workspaceId: string): Promise<string> {
  if (isLocalMode) return workspaceId
  if (workspaceId === SYSTEM_WORKSPACE_ID) return workspaceId
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { parentWorkspaceId: true },
  });
  return ws?.parentWorkspaceId ?? workspaceId;
}

/**
 * Get USD usage wallet for a workspace. Child workspaces resolve to the
 * parent's wallet (pooled billing).
 */
export async function getUsageWallet(workspaceId: string) {
  const billingWorkspaceId = await resolveBillingWorkspaceId(workspaceId);
  return prisma.usageWallet.findUnique({
    where: { workspaceId: billingWorkspaceId },
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
  // Child workspaces pool the parent's plan tier.
  const billingWorkspaceId = await resolveBillingWorkspaceId(workspaceId)
  const sub = await prisma.subscription.findFirst({
    where: { workspaceId: billingWorkspaceId, status: { in: ['active', 'trialing'] } },
    select: { planId: true },
  })
  if (sub) {
    return normalizePlanId(sub.planId) ?? 'free'
  }
  const grant = await getActiveGrantsForWorkspace(billingWorkspaceId, now)
  return normalizePlanId(grant.planId) ?? 'free'
}

/**
 * Allocate free-tier wallet for a new workspace (daily included, no monthly).
 * If active super-admin grants exist for the workspace, their summed
 * `monthlyIncludedUsd` seeds the wallet on day one.
 *
 * Overage is explicitly disabled for free wallets. The schema default for
 * `overageEnabled` is `true` (so paid plans created via `allocateMonthlyIncluded`
 * / `applyGrantMonthlyAllocation` keep working past included usage), but free
 * accounts have no payment method on file, so any spend beyond their rolling
 * window would be uncollectable loss. The window is the gate for free tier;
 * once it's exhausted the request is refused rather than billed to overage.
 */
export async function allocateFreeWallet(workspaceId: string) {
  const routed = await routeWalletProvision(workspaceId, { op: 'allocateFreeWallet' })
  if (routed.handled) return routed.wallet
  return allocateFreeWalletLocal(workspaceId)
}

export async function allocateFreeWalletLocal(workspaceId: string) {
  const now = new Date();

  // Child workspaces never get their own wallet — they pool the parent's.
  // Resolve here so any caller (lazy allocation, checkout) is pooling-safe.
  workspaceId = await resolveBillingWorkspaceId(workspaceId);

  const existing = await prisma.usageWallet.findUnique({
    where: { workspaceId },
  });
  if (existing) return existing;

  const grant = await getActiveGrantsForWorkspace(workspaceId, now)

  // A workspace can reach here with an active *paid* grant (e.g. a redeemed
  // license key) if this is the first wallet-touching call in this region
  // and it races ahead of the post-redemption `applyGrantMonthlyAllocation`
  // call (or that call landed in a different home region — see
  // `routeWalletProvision`). Provisioning a free-tier wallet in that case
  // would strand the workspace on free limits — sometimes permanently, since
  // the monthly refill cron skips wallets whose `lastMonthlyReset` already
  // falls in the current month. Delegate to the grant-aware path instead so
  // the very first wallet ever created here is already shaped correctly
  // (incident 2026-08-06).
  const grantPlan = normalizePlanId(grant.planId)
  if (grantPlan && PLAN_RANK[grantPlan] >= PLAN_RANK.basic) {
    return applyGrantMonthlyAllocationLocal(workspaceId, now)
  }

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
      overageEnabled: false,
    },
  });
}

/**
 * Sentinel workspace id embedded in the API server's own internal AI-proxy
 * token (see `lib/internal-proxy-config.ts`). Server-initiated LLM surfaces
 * (analytics digest, title generation) route through the metered proxy and
 * attribute their non-billable usage to this workspace.
 *
 * Historically this had no `Workspace` row, so the proxy had to be careful to
 * skip every workspace-FK'd write for it. That is fragile: a single missed tag
 * surfaces as `Foreign key constraint violated on ... credit_ledgers_workspaceId_fkey`
 * (the legacy constraint name for `usage_wallets.workspaceId`), and internal
 * cost-tracking `usage_events` were silently dropped. Ensuring a real row makes
 * the sentinel FK-valid everywhere.
 */
export const SYSTEM_WORKSPACE_ID = 'system'

let systemWorkspaceEnsured: Promise<void> | null = null

/**
 * Idempotently ensure the `system` sentinel Workspace row exists so internal
 * usage recording (and any wallet allocation that races the internal tag) does
 * not hit a foreign-key violation. Memoized after the first success; resets on
 * failure so a transient error can be retried. No-op in local/SQLite mode.
 */
export async function ensureSystemWorkspace(): Promise<void> {
  if (isLocalMode) return
  if (systemWorkspaceEnsured) return systemWorkspaceEnsured
  systemWorkspaceEnsured = (async () => {
    try {
      await prisma.workspace.upsert({
        where: { id: SYSTEM_WORKSPACE_ID },
        update: {},
        create: {
          id: SYSTEM_WORKSPACE_ID,
          name: 'System (internal)',
          slug: SYSTEM_WORKSPACE_ID,
        },
      })
    } catch (err) {
      console.warn('[billing] Failed to ensure system workspace row:', (err as any)?.message ?? err)
      systemWorkspaceEnsured = null
    }
  })()
  return systemWorkspaceEnsured
}

/**
 * Overage hard cap applied to paid plans conferred purely by a
 * `WorkspaceGrant` (license key redemption, admin comp) with no active
 * Stripe subscription backing them. There is no payment method on file
 * for these workspaces — `chargeOverageBlocks` requires an active
 * subscription's `stripeCustomerId` and silently defers otherwise (see
 * that function) — so leaving `overageHardLimitUsd` uncapped lets a
 * grant-only workspace run unbounded, uncollectable compute cost past
 * its included window. Real paying subscribers (`allocateMonthlyIncluded`,
 * driven by the Stripe webhook) are unaffected and stay uncapped by
 * default, same as before.
 *
 * $5 is a small buffer past the window (matches roughly one Pro 5-hour
 * window's worth of headroom) so a grant recipient isn't hard-blocked the
 * instant their window fills, while capping worst-case exposure per
 * grant-only workspace. Tune operationally if needed.
 */
export const GRANT_ONLY_OVERAGE_HARD_LIMIT_USD = 5

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
 *   the same as for paid Stripe plans — but capped at
 *   `GRANT_ONLY_OVERAGE_HARD_LIMIT_USD` unless the workspace also has an
 *   active paid Stripe subscription (which has a real payment method and
 *   is left uncapped, matching `allocateMonthlyIncluded`).
 */
export async function applyGrantMonthlyAllocation(
  workspaceId: string,
  now: Date = new Date(),
) {
  const routed = await routeWalletProvision(workspaceId, { op: 'applyGrantMonthlyAllocation' })
  if (routed.handled) return routed.wallet
  return applyGrantMonthlyAllocationLocal(workspaceId, now)
}

export async function applyGrantMonthlyAllocationLocal(
  workspaceId: string,
  now: Date = new Date(),
) {
  const [grant, activeSub] = await Promise.all([
    getActiveGrantsForWorkspace(workspaceId, now),
    prisma.subscription.findFirst({
      where: { workspaceId, status: { in: ['active', 'trialing'] } },
      select: { id: true },
    }),
  ])
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
  // No Stripe subscription backing this grant -> no payment method on
  // file -> cap overage instead of leaving it open-ended.
  const grantOnlyOverageCap = isPaidGrant && !activeSub ? GRANT_ONLY_OVERAGE_HARD_LIMIT_USD : null

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
      overageHardLimitUsd: grantOnlyOverageCap,
    },
    update: {
      monthlyIncludedUsd,
      monthlyIncludedAllocationUsd: monthlyIncludedUsd,
      dailyUsedThisMonthUsd: 0,
      overageAccumulatedUsd: 0,
      overageBilledUsd: 0,
      lastMonthlyReset: now,
      ...(isPaidGrant ? { overageEnabled: true } : {}),
      // Only touch the hard limit for the grant-only case; leave it alone
      // when a real subscription is present so an admin's manual
      // `setUsageBasedPricing` override isn't clobbered here.
      ...(isPaidGrant && !activeSub ? { overageHardLimitUsd: grantOnlyOverageCap } : {}),
    },
  })
}


/**
 * Paid-trust overage ladder. A block is both the invoice size and the most
 * unpaid overage a workspace can carry: once `overageBlockUsd` of overage is
 * unbilled, it is invoiced and further overage pauses until that invoice is
 * paid. Trust only grows with *paid* blocks (lifetime, never reset):
 *
 *   paid blocks 0–3 → $25, 4 → $100, 5 → $200, 6 → $300, 7 → $400, 8+ → $500
 */
export const OVERAGE_STARTER_BLOCK_USD = 25
export const OVERAGE_STARTER_BLOCKS = 4
export const OVERAGE_BLOCK_STEP_USD = 100
export const OVERAGE_BLOCK_MAX_USD = 500

export function overageBlockUsd(paidBlocks: number): number {
  const paid = Math.max(0, Math.floor(paidBlocks || 0))
  if (paid < OVERAGE_STARTER_BLOCKS) return OVERAGE_STARTER_BLOCK_USD
  return Math.min(OVERAGE_BLOCK_MAX_USD, OVERAGE_BLOCK_STEP_USD * (paid - OVERAGE_STARTER_BLOCKS + 1))
}

/**
 * Overage bookkeeping carried into a new period: whatever was accumulated
 * but not yet invoiced rolls forward instead of being forgiven.
 */
function carryOverageIntoNewPeriod(wallet: { overageAccumulatedUsd: number; overageBilledUsd: number }) {
  return {
    overageAccumulatedUsd: Math.max(0, wallet.overageAccumulatedUsd - wallet.overageBilledUsd),
    overageBilledUsd: 0,
  }
}

/**
 * Allocate the monthly included USD for a subscription plan and seat count.
 * `seats` is the number of *paying* seats on the Stripe subscription
 * (Pro/Business are per-seat plans; Basic is always 1). Starts a new overage
 * period, carrying any not-yet-invoiced overage forward.
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
  const routed = await routeWalletProvision(workspaceId, {
    op: 'allocateMonthlyIncluded',
    planId,
    seats,
  })
  if (routed.handled) return routed.wallet
  return allocateMonthlyIncludedLocal(workspaceId, planId, seats)
}

export async function allocateMonthlyIncludedLocal(
  workspaceId: string,
  planId: string,
  seats: number = 1,
) {
  const now = new Date();
  const [grant, existing] = await Promise.all([
    getActiveGrantsForWorkspace(workspaceId, now),
    prisma.usageWallet.findUnique({
      where: { workspaceId },
      select: { overageHardLimitUsd: true, overageAccumulatedUsd: true, overageBilledUsd: true },
    }),
  ])
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
      ...(existing
        ? carryOverageIntoNewPeriod(existing)
        : { overageAccumulatedUsd: 0, overageBilledUsd: 0 }),
      // Clear the proactive-alert dedupe ledger so threshold notifications
      // (approaching included / spend cap) can fire again next period. An
      // empty object resets it cleanly under both PG (Json) and SQLite (TEXT).
      alertsSentThisPeriod: {},
      // Re-enable trust-first on plan refresh so anyone who got a `false`
      // from the legacy default before the migration starts the next period
      // billed correctly.
      overageEnabled: true,
      // A workspace that reached a paid plan via a grant/license key carries
      // the grant-only overage cap (no card on file). Now that a real
      // subscription is backing it, release that cap — but only when it is
      // exactly the value we auto-applied, so a deliberate customer/admin
      // spend limit is preserved.
      ...(existing?.overageHardLimitUsd === GRANT_ONLY_OVERAGE_HARD_LIMIT_USD
        ? { overageHardLimitUsd: null }
        : {}),
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
 * Check if workspace may publish to a subdomain (`{subdomain}.shogo.one`).
 * Gated to Pro, Business, Enterprise (via paid subscription or a super-admin
 * grant's `planId`). Returns false for Basic and free.
 * In local mode returns true so publishing works during development.
 */
export async function canPublishSubdomain(workspaceId: string): Promise<boolean> {
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

/**
 * Total always-on published-app slots a workspace is entitled to, pooled
 * across all its published projects. Resolves the effective plan + entitled
 * seats (paid Stripe seats + granted free seats, min 1) and applies the
 * per-seat allowance from `ALWAYS_ON_SLOTS_PER_SEAT`. Returns `Infinity` for
 * uncapped plans (enterprise) and `Infinity` in local mode.
 */
export async function getAlwaysOnAllowanceForWorkspace(workspaceId: string): Promise<number> {
  if (isLocalMode) return Infinity
  const now = new Date()
  // Child workspaces inherit the parent's plan + pooled seats for entitlement.
  const billingWorkspaceId = await resolveBillingWorkspaceId(workspaceId)
  const [plan, sub, grant] = await Promise.all([
    getEffectivePlanId(billingWorkspaceId, now),
    prisma.subscription.findFirst({
      where: { workspaceId: billingWorkspaceId, status: { in: ['active', 'trialing'] } },
      select: { seats: true },
    }),
    getActiveGrantsForWorkspace(billingWorkspaceId, now),
  ])
  const seats = Math.max(1, (sub?.seats ?? 0) + (grant.freeSeats ?? 0))
  return getAlwaysOnAllowance(plan, seats)
}

/**
 * Count a workspace's currently-consumed always-on slots: live published
 * projects with `publishedAlwaysOn = true`. Pass `excludeProjectId` to omit
 * the project being toggled (so a no-op re-enable doesn't count itself).
 */
export async function countAlwaysOnUsed(
  workspaceId: string,
  excludeProjectId?: string,
): Promise<number> {
  return prisma.project.count({
    where: {
      workspaceId,
      publishedAlwaysOn: true,
      publishStatus: 'live',
      ...(excludeProjectId ? { id: { not: excludeProjectId } } : {}),
    },
  })
}

/**
 * Decide whether `projectId` may enable always-on. Returns the decision plus
 * the numbers the UI/route need to render an accurate message:
 *   - `planAllows`  — the plan grants any always-on slots at all (pro+)
 *   - `allowed`     — there is a free slot remaining for this project
 *   - `allowance`   — total pooled slots (Infinity = unlimited)
 *   - `used`        — slots consumed by *other* live projects
 */
export async function canEnableAlwaysOn(
  workspaceId: string,
  projectId: string,
): Promise<{ allowed: boolean; planAllows: boolean; allowance: number; used: number }> {
  if (isLocalMode) return { allowed: true, planAllows: true, allowance: Infinity, used: 0 }
  const [allowance, used] = await Promise.all([
    getAlwaysOnAllowanceForWorkspace(workspaceId),
    countAlwaysOnUsed(workspaceId, projectId),
  ])
  return { allowed: used < allowance, planAllows: allowance > 0, allowance, used }
}

/**
 * Check whether a workspace's CURRENT instance size (compute add-on tier —
 * `micro`/`small`/`medium`/`large`/`xlarge`, a separate billing axis from the
 * seat plan checked above) meets `techStackId`'s declared
 * `minimumInstanceSize` floor (e.g. `docker-compose` requires `large`; see
 * `packages/core/src/tech-stack-registry.ts` and
 * `config/instance-sizes.ts`'s `applyDockerStackFloor`). Stacks that declare
 * no floor always pass — this only bites Docker-class stacks today.
 *
 * This is the ONLY check that looks at `workspace.instanceSize` for gating
 * purposes; it is independent of (and should be checked in ADDITION to) the
 * super-admin platform flag `runtime.docker_class_enabled`
 * (`lib/runtime-class-setting.ts`) — a workspace can be big enough AND still
 * be refused if the platform gate is off, or vice versa.
 *
 * In local mode returns `allowed: true` unconditionally so dev workspaces
 * (which are always `micro`, there being no Stripe to upgrade them) aren't
 * blocked from using Docker-class stacks locally.
 */
export async function canRunTechStackOnInstanceSize(
  workspaceId: string,
  techStackId: string | null | undefined,
): Promise<{
  allowed: boolean
  currentSize: InstanceSizeName
  requiredSize: InstanceSizeName | null
}> {
  const requiredSize = getMinimumInstanceSize(techStackId) as InstanceSizeName | null
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { instanceSize: true },
  })
  const currentSize = (workspace?.instanceSize ?? 'micro') as InstanceSizeName
  if (isLocalMode || !requiredSize) {
    return { allowed: true, currentSize, requiredSize }
  }
  return {
    allowed: meetsMinimumInstanceSize(currentSize, techStackId),
    currentSize,
    requiredSize,
  }
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
 * On-demand ("overage") usage status for a workspace, resolved the same
 * way `checkUsageBalance` gates a request. Callers that only read
 * `usage_wallets.overageEnabled` directly (e.g. the workspace-plan API)
 * report a stale "on" state once the paid entitlement backing it lapses —
 * see `resolveEffectivePlan`'s `paidTier` doc comment. Use this instead so
 * the client shows the same on/off state the backend actually enforces.
 */
export async function getOverageStatus(
  workspaceId: string,
  now: Date = new Date(),
): Promise<{
  /** Raw persisted preference — what the user last set the toggle to. */
  overageEnabled: boolean
  /** Whether the workspace currently has a live paid entitlement (active
   * Stripe subscription or unexpired paid-tier grant) backing overage. */
  paidTier: boolean
  /** `overageEnabled && paidTier` — whether overage will actually apply
   * the next time a rolling window is exhausted. This is the value the UI
   * should treat as "is on-demand usage on". */
  overageActive: boolean
}> {
  const billingWorkspaceId = await resolveBillingWorkspaceId(workspaceId)
  const [wallet, { paidTier }] = await Promise.all([
    prisma.usageWallet.findUnique({ where: { workspaceId: billingWorkspaceId } }),
    resolveEffectivePlan(prisma, billingWorkspaceId, now),
  ])
  const overageEnabled = wallet?.overageEnabled ?? false
  return { overageEnabled, paidTier, overageActive: overageEnabled && paidTier }
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
  // Child workspaces read the parent's pooled wallet/windows.
  const billingWorkspaceId = await resolveBillingWorkspaceId(workspaceId)
  let wallet = await prisma.usageWallet.findUnique({ where: { workspaceId: billingWorkspaceId } })
  if (!wallet) wallet = await allocateFreeWallet(billingWorkspaceId)

  const { limits } = await resolveEffectivePlan(prisma, billingWorkspaceId, now)
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
 * Best-effort, fire-and-forget clear of a wallet's stale `overageEnabled`
 * flag once we've determined the entitlement behind it is gone. Nothing
 * else walks this column back (see `resolveEffectivePlan`), so without this
 * the wallet snapshot returned to the client (`GET /api/billing/workspace-plan`)
 * would keep reporting on-demand usage as "on" forever, even though every
 * request will keep getting blocked. Not awaited by callers — it must never
 * add latency or failure modes to the balance-check hot path.
 */
function healStaleOverageFlag(billingWorkspaceId: string): void {
  prisma.usageWallet
    .update({ where: { workspaceId: billingWorkspaceId }, data: { overageEnabled: false } })
    .catch((err) => {
      console.warn(
        `[billing] healStaleOverageFlag: failed to clear stale overageEnabled for ${billingWorkspaceId}:`,
        (err as any)?.message ?? err,
      )
    })
}

/**
 * Check if workspace can spend at least `minimumRequiredUsd`, with the
 * reason when it can't. True when either rolling window still has room,
 * when the plan is uncapped, or when metered overage is enabled and within
 * its hard cap *and* the paid entitlement behind it is still live.
 */
export async function checkUsageBalance(
  workspaceId: string,
  minimumRequiredUsd = 0.001,
): Promise<BalanceCheck> {
  if (isLocalMode) return { ok: true }

  // Child workspaces draw against the parent's pooled wallet.
  const billingWorkspaceId = await resolveBillingWorkspaceId(workspaceId);
  let wallet = await prisma.usageWallet.findUnique({ where: { workspaceId: billingWorkspaceId } });
  if (!wallet) {
    try {
      wallet = await allocateFreeWallet(billingWorkspaceId);
    } catch (err) {
      // A non-existent / synthetic workspace (e.g. the API server's own
      // internal proxy token uses the `system` sentinel workspace, which has no
      // Workspace row) makes `allocateFreeWallet` throw on the workspace FK
      // (`credit_ledgers_workspaceId_fkey`). Treat it as "no balance" instead
      // of throwing a 500 out of the AI-proxy balance preflight — the request
      // gets a clean usage-limit response rather than a hard error.
      console.warn(
        `[billing] hasBalance: could not allocate wallet for workspace ${workspaceId}:`,
        (err as any)?.message ?? err,
      )
      return { ok: false, reason: 'usage_limit_reached' };
    }
  }
  if (!wallet) return { ok: false, reason: 'usage_limit_reached' };

  const now = new Date();
  const { limits, paidTier } = await resolveEffectivePlan(prisma, billingWorkspaceId, now);

  // Uncapped plan (enterprise): always has balance.
  if (limits == null) return { ok: true };

  const five = rollWindow(wallet.fiveHourWindowStart, wallet.fiveHourUsedUsd, now, FIVE_HOUR_MS);
  const week = rollWindow(wallet.weeklyWindowStart, wallet.weeklyUsedUsd, now, SEVEN_DAY_MS);
  const windowRoom = Math.min(limits.fiveHourUsd - five.used, limits.weeklyUsd - week.used);
  if (windowRoom >= minimumRequiredUsd) return { ok: true };

  // Windows exhausted — unexpired signup promo credit is next. Which models it
  // can pay for is the plan's model-tier gate in ai-proxy (economy on Free and
  // Basic); promo credit doesn't change it.
  if (promoCreditAvailableUsd(wallet, now) >= minimumRequiredUsd) return { ok: true };

  // Overage is the fallback when enabled and uncapped,
  // and only while the paid entitlement behind it is still live.
  if (!wallet.overageEnabled) return { ok: false, reason: 'usage_limit_reached' };
  if (!paidTier) {
    healStaleOverageFlag(billingWorkspaceId);
    return { ok: false, reason: 'entitlement_expired' };
  }
  if (wallet.overageOutstandingInvoiceId) {
    reconcileOutstandingOverage(billingWorkspaceId, wallet.overageOutstandingInvoiceId).catch((err) =>
      console.error('[billing] failed to reconcile outstanding overage invoice:', err),
    )
    return { ok: false, reason: 'overage_payment_pending' };
  }
  if (wallet.overageAccumulatedUsd - wallet.overageBilledUsd >= overageBlockUsd(wallet.overagePaidBlocks)) {
    // A full block is unbilled — normally the charge is already in flight
    // from the debit that crossed it; kick it again in case that attempt failed.
    chargeOverageBlocks(billingWorkspaceId).catch((err) =>
      console.error('[billing] failed to charge overage blocks:', err),
    )
    return { ok: false, reason: 'overage_payment_pending' };
  }
  if (wallet.overageHardLimitUsd == null) return { ok: true };
  const overageRoom = Math.max(0, wallet.overageHardLimitUsd - wallet.overageAccumulatedUsd);
  if (overageRoom >= minimumRequiredUsd) return { ok: true };
  return { ok: false, reason: 'overage_cap_reached' };
}

/**
 * Check if workspace can spend at least `minimumRequiredUsd`. Thin boolean
 * wrapper over `checkUsageBalance` for call sites that don't need to
 * distinguish *why* the balance check failed.
 */
export async function hasBalance(
  workspaceId: string,
  minimumRequiredUsd = 0.001,
): Promise<boolean> {
  return (await checkUsageBalance(workspaceId, minimumRequiredUsd)).ok
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
  /**
   * Workspace whose wallet/windows are actually debited. For a child
   * workspace this is its parent (pooled billing); defaults to `workspaceId`
   * resolved via `resolveBillingWorkspaceId`. The recorded `UsageEvent` always
   * keeps the real `workspaceId` so per-child usage attribution is preserved.
   */
  billingWorkspaceId?: string
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
  /** Machine-readable reason for a failure; see `UsageBlockReason`. */
  reason?: UsageBlockReason
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
 * Rollout gate for routing wallet mutations to `workspace.homeRegion`.
 *   - `off`     (default): always write the wallet in the serving region.
 *   - `shadow`: log the would-route decision but still write locally.
 *   - `enforce`: route the debit to the home region (single-writer).
 */
export type UsageWalletHomeWriterMode = 'off' | 'shadow' | 'enforce'

export function getUsageWalletHomeWriterMode(): UsageWalletHomeWriterMode {
  const v = (process.env.USAGE_WALLET_HOME_WRITER || 'off').toLowerCase()
  return v === 'shadow' || v === 'enforce' ? v : 'off'
}

/**
 * The region that owns (is the sole writer for) a billing workspace's wallet.
 * A null `homeRegion` (legacy rows) is owned by the primary region, matching
 * `home-region-router.ts`.
 */
async function resolveWorkspaceHomeRegion(billingWorkspaceId: string): Promise<string> {
  const ws = await prisma.workspace.findUnique({
    where: { id: billingWorkspaceId },
    select: { homeRegion: true },
  })
  return ws?.homeRegion || PRIMARY_REGION
}

/**
 * A wallet-provisioning mutation to (potentially) route to the home region.
 * Mirrors the four provisioning entry points below.
 */
type WalletProvisionOp =
  | { op: 'allocateFreeWallet' }
  | { op: 'allocateMonthlyIncluded'; planId: string; seats: number }
  | { op: 'applyGrantMonthlyAllocation' }
  | { op: 'setUsageBasedPricing'; overageEnabled: boolean; overageHardLimitUsd: number | null }
  | { op: 'markOverageInvoicePaid'; invoiceId: string; invoiceUrl?: string }
  | { op: 'releaseOverageInvoice'; invoiceId: string }

/**
 * Route a wallet-provisioning write to `workspace.homeRegion` so the wallet has
 * a single writer, the same way `consumeUsage` routes debits. Stripe webhooks
 * (and the admin/grant paths) terminate in whatever region the request lands —
 * usually the US primary — so without this a paid subscription for an EU-home
 * workspace would provision the wallet in the wrong region and never reach the
 * one the app actually reads (incident 2026-07-07).
 *
 * Returns `{ handled: true, wallet }` when the write was performed in the home
 * region via RPC; `{ handled: false }` means the caller should write locally
 * (mode off/shadow, already home, no peer, local mode, or RPC failure — we fall
 * back to local so provisioning never silently drops).
 */
async function routeWalletProvision(
  workspaceId: string,
  opts: WalletProvisionOp,
): Promise<{ handled: true; wallet: any } | { handled: false }> {
  if (isLocalMode) return { handled: false }
  const mode = getUsageWalletHomeWriterMode()
  if (mode === 'off' || !RAW_REGION_ID) return { handled: false }

  let billingWorkspaceId: string
  try {
    billingWorkspaceId = await resolveBillingWorkspaceId(workspaceId)
  } catch {
    return { handled: false }
  }
  const homeRegion = await resolveWorkspaceHomeRegion(billingWorkspaceId)
  if (homeRegion === RAW_REGION_ID) return { handled: false }

  const peer = getPeer(homeRegion)
  if (!peer) {
    console.warn('[billing] wallet provision: home region has no peer; writing locally', {
      billingWorkspaceId,
      homeRegion,
      from: RAW_REGION_ID,
      op: opts.op,
    })
    return { handled: false }
  }
  if (mode === 'shadow') {
    console.log('[billing] wallet provision would-route to home region', {
      billingWorkspaceId,
      homeRegion,
      from: RAW_REGION_ID,
      op: opts.op,
    })
    return { handled: false }
  }

  try {
    const res = await callPeerInternal<any>(homeRegion, '/api/internal/billing/provision', {
      ...opts,
      workspaceId: billingWorkspaceId,
    })
    if (res.ok && res.data) return { handled: true, wallet: res.data }
    console.error('[billing] wallet provision RPC non-ok; falling back to local', {
      status: res.status,
      homeRegion,
      op: opts.op,
    })
  } catch (err) {
    console.error('[billing] wallet provision RPC failed; falling back to local', {
      homeRegion,
      op: opts.op,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return { handled: false }
}

/**
 * Consume USD for an action, writing the wallet in its home region.
 *
 * `usage_wallets` is a running counter that logical replication's
 * last-update-wins cannot merge, so it must have exactly one writer per row.
 * When `USAGE_WALLET_HOME_WRITER=enforce` and the serving region is not the
 * workspace's `homeRegion`, the debit is routed to the home region via an
 * internal RPC; the home region runs the transaction against its authoritative
 * wallet and its `usage_events` row (which DOES replicate) carries the ledger
 * back to every region. Otherwise the debit is applied locally.
 *
 * On any routing failure we fall back to a local write so delivered usage is
 * never lost (a rare path; the reconcile/watchdog collapses divergence).
 */
export async function consumeUsage(
  params: ConsumeUsageParams,
): Promise<ConsumeUsageResult> {
  if (isLocalMode) return consumeUsageLocal(params)

  const mode = getUsageWalletHomeWriterMode()
  if (mode !== 'off' && RAW_REGION_ID) {
    const billingWorkspaceId =
      params.billingWorkspaceId ?? (await resolveBillingWorkspaceId(params.workspaceId))
    const homeRegion = await resolveWorkspaceHomeRegion(billingWorkspaceId)

    if (homeRegion !== RAW_REGION_ID) {
      const peer = getPeer(homeRegion)
      if (!peer) {
        console.warn('[billing] usage-wallet home region has no peer; writing locally', {
          billingWorkspaceId,
          homeRegion,
          from: RAW_REGION_ID,
        })
      } else if (mode === 'shadow') {
        console.log('[billing] usage-wallet would-route to home region', {
          billingWorkspaceId,
          homeRegion,
          from: RAW_REGION_ID,
        })
      } else {
        // enforce: the home region is the single writer for this wallet.
        try {
          const res = await callPeerInternal<ConsumeUsageResult>(
            homeRegion,
            '/api/internal/billing/consume',
            { ...params, billingWorkspaceId },
          )
          if (res.ok && res.data) return res.data
          console.error('[billing] home-region consume RPC non-ok; falling back to local', {
            status: res.status,
            homeRegion,
          })
        } catch (err) {
          console.error('[billing] home-region consume RPC failed; falling back to local', {
            homeRegion,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    return consumeUsageLocal({ ...params, billingWorkspaceId })
  }

  return consumeUsageLocal(params)
}

/**
 * Apply a usage debit against the LOCAL wallet in this region. Callers must
 * ensure this runs in the wallet's home region (either directly in the home
 * region, or via the `/api/internal/billing/consume` endpoint the home-region
 * router forwards to) — see `consumeUsage`.
 *
 * Deduction order: daily included -> monthly included -> overage (if enabled).
 * Retries on projectId FK constraint violations (race with project creation).
 */
export async function consumeUsageLocal(
  params: ConsumeUsageParams,
): Promise<ConsumeUsageResult> {
  const { workspaceId, projectId, memberId, actionType, billedUsd, actionMetadata } = params
  const rawUsd = params.rawUsd ?? null

  if (isLocalMode) return recordLocalUsage(params)

  // Resolve the workspace whose wallet is actually debited (parent for a
  // child workspace). Overage charging and usage alerts operate on that
  // pooled wallet, not the child.
  const billingWorkspaceId =
    params.billingWorkspaceId ?? (await resolveBillingWorkspaceId(workspaceId))

  for (let attempt = 0; ; attempt++) {
    try {
      const result = await _consumeUsageTransaction({ ...params, billingWorkspaceId })
      if (result.success) {
        if ((result.overageChargedUsd ?? 0) > 0) {
          // Fire-and-forget block charging once a full block is unbilled.
          chargeOverageBlocks(billingWorkspaceId).catch((err) =>
            console.error('[billing] failed to charge overage blocks:', err),
          )
        }
        // Proactive, deduped usage/overage threshold alerts (approaching
        // included exhaustion, approaching spend cap, cap reached). The dedupe
        // ledger makes repeat calls a single cheap read once a threshold has
        // fired. Fire-and-forget so alerting never blocks usage recording.
        evaluateUsageAlerts(billingWorkspaceId).catch((err) =>
          console.error('[billing] failed to evaluate usage alerts:', err),
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
  // Wallet/windows are pooled to the billing workspace (parent for children);
  // the UsageEvent below is still attributed to the real `workspaceId`.
  const billingWorkspaceId = params.billingWorkspaceId ?? workspaceId

  return prisma.$transaction(async (tx) => {
    let wallet = await tx.usageWallet.findUnique({
      where: { workspaceId: billingWorkspaceId },
    });

    if (!wallet) {
      try {
        // Already routed to the home region by consumeUsage (or a deliberate
        // local fallback), so write the wallet locally — never re-route from
        // inside the debit transaction.
        await allocateFreeWalletLocal(billingWorkspaceId);
        wallet = await tx.usageWallet.findUnique({ where: { workspaceId: billingWorkspaceId } });
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
    const { limits, paidTier } = await resolveEffectivePlan(tx, billingWorkspaceId, now);

    // Lazy window reset: a window "opens" on the first action and resets once
    // its full duration has elapsed (fixed-window-from-first-event).
    const five = rollWindow(wallet.fiveHourWindowStart, wallet.fiveHourUsedUsd, now, FIVE_HOUR_MS);
    const week = rollWindow(wallet.weeklyWindowStart, wallet.weeklyUsedUsd, now, SEVEN_DAY_MS);

    // Monthly boundary still governs overage bookkeeping. The included USD
    // pools are no longer drained — the rolling windows are the gate — so we
    // only roll overage accounting here (unbilled overage carries forward).
    const needsMonthlyReset = isNewMonth(now, wallet.lastMonthlyReset);
    let overageAccumulatedUsd = needsMonthlyReset
      ? carryOverageIntoNewPeriod(wallet).overageAccumulatedUsd
      : wallet.overageAccumulatedUsd;

    let source: UsageSource;
    let balanceBefore: number;
    let balanceAfter: number;
    let overageCharged = 0;
    let promoCharged = 0;
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

        // Order after the windows: signup promo credit first (it is already
        // paid for and expires), then metered overage, then the hard limit.
        // Overage only applies while the paid entitlement behind it is live:
        // an expired grant / lapsed subscription falls through to the hard
        // "Usage limit reached" branch instead of metering unbillable usage.
        const promoAvailable = promoCreditAvailableUsd(wallet, now);
        const overageDue = Math.max(0, billedUsd - promoAvailable);
        const overageApplies = wallet.overageEnabled && paidTier;
        let overageBlock: 'overage_payment_pending' | 'overage_cap_reached' | null = null;
        if (overageApplies && overageDue > 0) {
          if (wallet.overageOutstandingInvoiceId) {
            overageBlock = 'overage_payment_pending';
          } else {
            const overageRoom = wallet.overageHardLimitUsd == null
              ? Number.POSITIVE_INFINITY
              : Math.max(0, wallet.overageHardLimitUsd - overageAccumulatedUsd);
            if (overageRoom < overageDue) overageBlock = 'overage_cap_reached';
          }
        }

        if (promoAvailable > 0 && (overageDue === 0 || !overageApplies || overageBlock)) {
          // Promo covers the call. When nothing billable sits behind it, the
          // last of the balance absorbs the whole call: `checkUsageBalance`
          // already admitted it on any positive balance, and a refused debit
          // would leave the balance untouched and the call free, repeatedly.
          source = 'promo';
          promoCharged = Math.min(promoAvailable, billedUsd);
          balanceBefore = promoAvailable;
          balanceAfter = promoAvailable - promoCharged;
        } else if (overageApplies) {
          if (overageBlock === 'overage_payment_pending') {
            return {
              success: false,
              error: 'Overage payment pending',
              reason: 'overage_payment_pending',
              remainingIncludedUsd: 0,
              source: 'overage',
              window,
              resetsAt,
            };
          }
          if (overageBlock === 'overage_cap_reached') {
            return {
              success: false,
              error: 'Usage hard limit reached',
              reason: 'overage_cap_reached',
              remainingIncludedUsd: 0,
              source: 'overage',
              window,
              resetsAt,
            };
          }
          // Beyond-window usage is metered to overage and does NOT accrue to
          // the windows (the window is already full). Any remaining promo
          // balance pays for the first part of the call.
          source = 'overage';
          promoCharged = promoAvailable;
          balanceBefore = overageAccumulatedUsd;
          overageAccumulatedUsd += overageDue;
          balanceAfter = overageAccumulatedUsd;
          overageCharged = overageDue;
        } else {
          // `wallet.overageEnabled` alone doesn't mean overage actually
          // applies — see `resolveEffectivePlan`'s `paidTier` doc comment.
          // Capture the reason *before* self-healing below: the update
          // mutates this same in-memory `wallet` record (the mock and
          // Prisma's own row cache both do), so reading `overageEnabled`
          // after the write would always see the just-cleared `false`.
          const isStaleOverageFlag = wallet.overageEnabled && !paidTier;
          if (isStaleOverageFlag) {
            // When the flag is stale (entitlement lapsed) clear it in the
            // same transaction so the wallet snapshot returned to clients
            // stops lying about on-demand usage being on.
            await tx.usageWallet.update({
              where: { workspaceId: billingWorkspaceId },
              data: { overageEnabled: false },
            });
          }
          return {
            success: false,
            error: 'Usage limit reached',
            reason: isStaleOverageFlag ? 'entitlement_expired' : 'usage_limit_reached',
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
      where: { workspaceId: billingWorkspaceId },
      data: {
        fiveHourWindowStart: five.start,
        fiveHourUsedUsd: five.used,
        weeklyWindowStart: week.start,
        weeklyUsedUsd: week.used,
        overageAccumulatedUsd,
        ...(promoCharged > 0 ? { promoCreditUsd: { decrement: promoCharged } } : {}),
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
    // The new Analytics dashboard caches one grouped scan for a short TTL; a
    // fresh event must be on the next open, not up to a minute later.
    invalidateAnalyticsCache({ workspaceId, projectId })

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

interface EffectivePlan {
  /** Rolling-window limits; `null` for uncapped (enterprise) plans. */
  limits: WindowLimits | null
  /**
   * Whether the workspace is on a paid tier *as of `now`* — an active Stripe
   * subscription, or an unexpired grant conferring a paid plan.
   *
   * Overage is gated on this rather than on `usage_wallets.overageEnabled`
   * alone, because that column is a persisted snapshot that nothing walks
   * back when the entitlement behind it goes away: a lapsed subscription or
   * an expired license-key grant would otherwise keep metering usage into
   * `overageAccumulatedUsd` forever, and with no payment method on file that
   * balance can never be invoiced (`chargeOverageBlocks` defers it).
   * Deriving it here means expiry takes effect the moment it happens,
   * without a downgrade job to keep in sync (incident 2026-08-06).
   */
  paidTier: boolean
}

/**
 * Resolve a workspace's effective plan: rolling-window limits from its plan
 * and seat count, plus whether that plan is a paid tier. Active Stripe
 * subscription wins (seats from the sub); otherwise the highest active
 * grant's plan and free-seat count apply; otherwise free.
 *
 * Reads are issued through the surrounding transaction client where possible
 * to stay consistent with the wallet read.
 */
async function resolveEffectivePlan(
  tx: { subscription: { findFirst: typeof prisma.subscription.findFirst } },
  workspaceId: string,
  now: Date,
): Promise<EffectivePlan> {
  const sub = await tx.subscription.findFirst({
    where: { workspaceId, status: { in: ['active', 'trialing'] } },
    select: { planId: true, seats: true },
  })
  if (sub) {
    const plan = normalizePlanId(sub.planId) ?? 'free'
    return {
      limits: getWindowLimitsForPlan(plan, sub.seats),
      paidTier: PLAN_RANK[plan] >= PLAN_RANK.basic,
    }
  }
  const grant = await getActiveGrantsForWorkspace(workspaceId, now)
  const plan = normalizePlanId(grant.planId) ?? 'free'
  const seats = Math.max(1, grant.freeSeats || 0)
  return {
    limits: getWindowLimitsForPlan(plan, seats),
    paidTier: PLAN_RANK[plan] >= PLAN_RANK.basic,
  }
}

/**
 * Invoice and charge the next overage block once a full block of overage is
 * unbilled (see `overageBlockUsd` for the paid-trust ladder).
 *
 *   `overageAccumulatedUsd` is the marked-up USD consumed beyond included
 *   usage; `overageBilledUsd` is how much of it has been invoiced this
 *   period. Exactly one block is invoiced at a time and recorded as the
 *   wallet's outstanding invoice; overage stays paused until it is paid
 *   (here, or later via the `invoice.payment_succeeded` webhook after
 *   Stripe's retries / the customer paying the hosted invoice).
 *
 * The invoice is charged to the subscription's default payment method —
 * Checkout stores the card there, not on the customer, so an invoice
 * without it has nothing to charge.
 *
 * Returns the number of blocks invoiced (0 or 1). Best effort: logs and
 * swallows errors; the preflight retries while a full block is unbilled.
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
      overagePaidBlocks: true,
      overageOutstandingInvoiceId: true,
    },
  })
  if (!wallet || wallet.overageOutstandingInvoiceId) return 0

  const totalUsd = overageBlockUsd(wallet.overagePaidBlocks)
  if (wallet.overageAccumulatedUsd - wallet.overageBilledUsd < totalUsd) return 0

  const sub = await prisma.subscription.findFirst({
    where: { workspaceId, status: { in: ['active', 'trialing'] } },
    select: { stripeCustomerId: true, stripeSubscriptionId: true },
  })
  if (!sub?.stripeCustomerId) {
    console.warn(`[billing] no active Stripe customer for workspace ${workspaceId}; deferring overage block charge`)
    return 0
  }

  const { default: Stripe } = await import('stripe') as unknown as {
    default: new (key: string, opts?: unknown) => any
  }
  const stripe = new Stripe(stripeKey)

  // Idempotency: keyed on (workspace, paid-trust level, billed snapshot), so a
  // retry from the same wallet state reuses the same Stripe invoice.
  const idempotencyKey =
    `overage:${workspaceId}:${wallet.overagePaidBlocks}:${Math.round(wallet.overageBilledUsd * 100)}`
  const expectedCents = Math.round(totalUsd * 100)

  try {
    const paymentMethod = await resolveDefaultPaymentMethod(stripe, sub)

    // Create the invoice first with `pending_invoice_items_behavior: 'exclude'`
    // and attach the item to it explicitly; otherwise Stripe holds a pending
    // item for a subscription customer's next cycle and this invoice
    // finalizes at $0.
    const invoice = await stripe.invoices.create(
      {
        customer: sub.stripeCustomerId,
        // Stripe only retries collection (Smart Retries / dunning) on
        // auto-advancing invoices.
        auto_advance: true,
        collection_method: 'charge_automatically',
        pending_invoice_items_behavior: 'exclude',
        ...(paymentMethod ? { default_payment_method: paymentMethod } : {}),
        description: 'Usage overage',
        metadata: { workspaceId, kind: 'overage_block', blockUsd: String(totalUsd) },
      },
      { idempotencyKey: `${idempotencyKey}:invoice` },
    )

    await stripe.invoiceItems.create(
      {
        customer: sub.stripeCustomerId,
        invoice: invoice.id,
        amount: expectedCents, // cents
        currency: 'usd',
        description: `Usage overage block ($${totalUsd})`,
        metadata: { workspaceId, kind: 'overage_block', blockUsd: String(totalUsd) },
      },
      { idempotencyKey: `${idempotencyKey}:item` },
    )

    const finalized = await stripe.invoices.finalizeInvoice(invoice.id)

    // Only record the block once the invoice actually carries the amount we
    // intended; otherwise bail so the next call retries.
    if (typeof finalized?.total === 'number' && finalized.total !== expectedCents) {
      console.error('[billing] overage invoice total mismatch; not recording block', {
        workspaceId,
        invoiceId: finalized.id,
        expectedCents,
        actualCents: finalized.total,
      })
      return 0
    }

    // Claim the block: conditional on the snapshot we read, so a concurrent
    // call that got the same (idempotent) invoice can't record it twice.
    const claimed = await prisma.usageWallet.updateMany({
      where: { workspaceId, overageOutstandingInvoiceId: null, overageBilledUsd: wallet.overageBilledUsd },
      data: {
        overageBilledUsd: { increment: totalUsd },
        overageOutstandingInvoiceId: finalized.id,
        overageOutstandingUsd: totalUsd,
        overageOutstandingInvoiceUrl: finalized.hosted_invoice_url ?? null,
      },
    })
    if (claimed.count === 0) return 0

    let paid = finalized?.status === 'paid'
    if (!paid) {
      try {
        const payResult = await stripe.invoices.pay(finalized.id, {
          ...(paymentMethod ? { payment_method: paymentMethod } : {}),
          off_session: true,
        })
        paid = payResult?.status === 'paid'
      } catch (payErr: any) {
        console.warn('[billing] overage invoice pay attempt failed (Stripe will retry; overage paused):', {
          workspaceId,
          invoiceId: finalized.id,
          error: payErr?.message ?? payErr,
        })
      }
    }

    console.log('[billing] Invoiced overage block:', {
      workspaceId,
      totalUsd,
      paidBlocks: wallet.overagePaidBlocks,
      invoiceId: finalized.id,
      paid,
    })

    if (paid) {
      await markOverageInvoicePaidLocal(workspaceId, finalized.id, finalized.hosted_invoice_url ?? undefined)
    }
    return 1
  } catch (err: any) {
    console.error('[billing] chargeOverageBlocks failed:', err?.message ?? err)
    return 0
  }
}

async function resolveDefaultPaymentMethod(
  stripe: any,
  sub: { stripeCustomerId: string; stripeSubscriptionId: string },
): Promise<string | null> {
  const idOf = (pm: unknown) => (typeof pm === 'string' ? pm : (pm as { id?: string } | null)?.id ?? null)
  try {
    const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId)
    const fromSub = idOf(stripeSub?.default_payment_method)
    if (fromSub) return fromSub
  } catch (err: any) {
    console.warn('[billing] could not read subscription payment method:', err?.message ?? err)
  }
  try {
    const customer = await stripe.customers.retrieve(sub.stripeCustomerId)
    return idOf(customer?.invoice_settings?.default_payment_method)
  } catch (err: any) {
    console.warn('[billing] could not read customer payment method:', err?.message ?? err)
    return null
  }
}

/**
 * Settle the wallet's outstanding overage block: clears the pause, bumps the
 * lifetime paid-block count (raising the next block size), and notifies the
 * billing admins. Idempotent — only the call that actually clears the
 * matching invoice id has any effect, so the sync pay path and the
 * `invoice.payment_succeeded` webhook can both call it. Routed to the
 * wallet's home region (webhooks land in whichever region serves them).
 */
export async function markOverageInvoicePaid(
  workspaceId: string,
  invoiceId: string,
  invoiceUrl?: string,
): Promise<boolean> {
  const routed = await routeWalletProvision(workspaceId, { op: 'markOverageInvoicePaid', invoiceId, invoiceUrl })
  if (routed.handled) return Boolean(routed.wallet?.settled)
  return markOverageInvoicePaidLocal(workspaceId, invoiceId, invoiceUrl)
}

export async function markOverageInvoicePaidLocal(
  workspaceId: string,
  invoiceId: string,
  invoiceUrl?: string,
): Promise<boolean> {
  const wallet = await prisma.usageWallet.findUnique({
    where: { workspaceId },
    select: { overageOutstandingUsd: true },
  })
  const settled = await prisma.usageWallet.updateMany({
    where: { workspaceId, overageOutstandingInvoiceId: invoiceId },
    data: {
      overageOutstandingInvoiceId: null,
      overageOutstandingUsd: 0,
      overageOutstandingInvoiceUrl: null,
      overagePaidBlocks: { increment: 1 },
    },
  })
  if (settled.count === 0) return false

  const updated = await prisma.usageWallet.findUnique({
    where: { workspaceId },
    select: { overageAccumulatedUsd: true },
  })
  void notifyOverageCharged(workspaceId, {
    blockAmountUsd: wallet?.overageOutstandingUsd ?? 0,
    periodOverageUsd: updated?.overageAccumulatedUsd ?? 0,
    invoiceId,
    invoiceUrl,
  })
  return true
}

/**
 * Release the wallet's outstanding overage block without counting it as
 * paid (invoice voided / marked uncollectible). Overage resumes, but the
 * trust ladder does not advance.
 */
export async function releaseOverageInvoice(workspaceId: string, invoiceId: string): Promise<boolean> {
  const routed = await routeWalletProvision(workspaceId, { op: 'releaseOverageInvoice', invoiceId })
  if (routed.handled) return Boolean(routed.wallet?.released)
  return releaseOverageInvoiceLocal(workspaceId, invoiceId)
}

export async function releaseOverageInvoiceLocal(workspaceId: string, invoiceId: string): Promise<boolean> {
  const released = await prisma.usageWallet.updateMany({
    where: { workspaceId, overageOutstandingInvoiceId: invoiceId },
    data: { overageOutstandingInvoiceId: null, overageOutstandingUsd: 0, overageOutstandingInvoiceUrl: null },
  })
  return released.count > 0
}

const OVERAGE_RECONCILE_INTERVAL_MS = 60_000
const overageReconcileLastCheck = new Map<string, number>()

/**
 * Settle a paused wallet straight from Stripe's view of its outstanding
 * invoice. Webhooks only reach the region that serves them, so without this a
 * wallet in another region would stay paused after the customer pays.
 * Throttled per workspace; called from the balance preflight.
 */
export async function reconcileOutstandingOverage(workspaceId: string, invoiceId: string): Promise<boolean> {
  const stripeKey = process.env.STRIPE_SECRET_KEY
  if (!stripeKey) return false
  const last = overageReconcileLastCheck.get(workspaceId) ?? 0
  if (Date.now() - last < OVERAGE_RECONCILE_INTERVAL_MS) return false
  overageReconcileLastCheck.set(workspaceId, Date.now())

  const { default: Stripe } = await import('stripe') as unknown as {
    default: new (key: string, opts?: unknown) => any
  }
  const invoice = await new Stripe(stripeKey).invoices.retrieve(invoiceId)
  if (invoice?.status === 'paid') {
    return markOverageInvoicePaidLocal(workspaceId, invoiceId, invoice.hosted_invoice_url ?? undefined)
  }
  if (invoice?.status === 'void' || invoice?.status === 'uncollectible') {
    return releaseOverageInvoiceLocal(workspaceId, invoiceId)
  }
  return false
}

/**
 * @deprecated Overage now charges in paid-trust blocks via
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
  const subscription = await prisma.subscription.upsert({
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
  // A new plan changes the agent-reply ceiling, and the queue must not wait out its cache.
  invalidateAgentReplyCapacity(data.workspaceId);
  return subscription;
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
  // Seats are pooled across a workspace "family": the billing (parent)
  // workspace plus all of its children. A user who belongs to several
  // workspaces in the same family counts once.
  const billingWorkspaceId = await resolveBillingWorkspaceId(workspaceId)
  const children = await prisma.workspace.findMany({
    where: { parentWorkspaceId: billingWorkspaceId },
    select: { id: true },
  })
  const familyWorkspaceIds = [billingWorkspaceId, ...children.map((c: any) => c.id)]
  const rows = await prisma.member.findMany({
    where: { workspaceId: { in: familyWorkspaceIds }, projectId: null },
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
    // A child workspace has no subscription of its own — its members count
    // against the parent's pooled seats, so sync the parent's subscription.
    const billingWorkspaceId = await resolveBillingWorkspaceId(workspaceId)

    const sub = await prisma.subscription.findFirst({
      where: { workspaceId: billingWorkspaceId, status: { in: ['active', 'trialing'] } },
    })
    if (!sub) return { ok: false, reason: 'no_active_subscription' }

    const planId = sub.planId.toLowerCase()
    if (planId === 'basic' || planId.startsWith('basic')) {
      return { ok: false, reason: 'basic_plan_single_seat' }
    }

    const totalMembers = await countActiveWorkspaceMembers(billingWorkspaceId)
    const grant = await getActiveGrantsForWorkspace(billingWorkspaceId)
    // v1: enforce a minimum of 1 paid Stripe seat. If a grant exceeds the
    // member count we still bill 1 seat so the Stripe subscription stays
    // active. Revisit later by pausing the seat item entirely when a
    // grant fully covers all members.
    const desiredStripeSeats = Math.max(1, totalMembers - grant.freeSeats)
    // The wallet's included USD reflects total *entitled* seats: the paid
    // Stripe seats plus the granted free seats. Using `totalMembers` here was
    // a bug — when a grant's free seats exceed the member count (e.g. a 5-seat
    // grant on a 1-member personal workspace) it dropped the granted seats'
    // included usage entirely, and clobbered the larger allocation that
    // `allocateMonthlyIncluded` had just written. This keeps the two functions
    // in agreement: `desiredStripeSeats + grant.freeSeats` always equals
    // `allocateMonthlyIncluded`'s `seats + grant.freeSeats`.
    const includedUsd =
      getMonthlyIncludedForPlan(sub.planId, desiredStripeSeats + grant.freeSeats) +
      grant.monthlyIncludedUsd

    if (desiredStripeSeats === sub.seats) {
      // Already in sync — still ensure the wallet allocation matches.
      await prisma.usageWallet.updateMany({
        where: { workspaceId: billingWorkspaceId },
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
        where: { workspaceId: billingWorkspaceId },
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
      where: { workspaceId: billingWorkspaceId },
      data: {
        monthlyIncludedUsd: includedUsd,
        monthlyIncludedAllocationUsd: includedUsd,
      },
    })

    console.log('[billing] Synced seats from membership:', {
      workspaceId: billingWorkspaceId,
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
  const routed = await routeWalletProvision(workspaceId, {
    op: 'setUsageBasedPricing',
    overageEnabled: options.overageEnabled,
    overageHardLimitUsd: options.overageHardLimitUsd ?? null,
  })
  if (routed.handled) return routed.wallet
  return setUsageBasedPricingLocal(workspaceId, options)
}

/** Thrown when a workspace without a payment method tries to enable overage. */
export const OVERAGE_REQUIRES_SUBSCRIPTION = 'overage_requires_subscription'

export async function setUsageBasedPricingLocal(
  workspaceId: string,
  options: { overageEnabled: boolean; overageHardLimitUsd?: number | null },
) {
  const now = new Date()
  workspaceId = await resolveBillingWorkspaceId(workspaceId)

  // Enabling overage commits the workspace to paying for usage beyond its
  // included windows, so it requires something to bill against. Without an
  // active subscription `chargeOverageBlocks` can only defer, so the balance
  // accrues uncollectably — gate on the entitlement rather than trusting the
  // caller (incident 2026-08-06).
  let hardLimitUsd = options.overageHardLimitUsd ?? null
  if (options.overageEnabled) {
    const [activeSub, grant] = await Promise.all([
      prisma.subscription.findFirst({
        where: { workspaceId, status: { in: ['active', 'trialing'] } },
        select: { id: true },
      }),
      getActiveGrantsForWorkspace(workspaceId, now),
    ])
    if (!activeSub) {
      const grantPlan = normalizePlanId(grant.planId)
      const hasPaidGrant = !!grantPlan && PLAN_RANK[grantPlan] >= PLAN_RANK.basic
      if (!hasPaidGrant) throw new Error(OVERAGE_REQUIRES_SUBSCRIPTION)
      // Grant-conferred paid plan with no card on file: the workspace may
      // tighten the cap but never raise or remove it.
      hardLimitUsd = Math.min(
        hardLimitUsd ?? GRANT_ONLY_OVERAGE_HARD_LIMIT_USD,
        GRANT_ONLY_OVERAGE_HARD_LIMIT_USD,
      )
    }
  }

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
      overageHardLimitUsd: hardLimitUsd,
      anniversaryDay: now.getDate(),
      lastDailyReset: now,
      lastMonthlyReset: now,
    },
    update: {
      overageEnabled: options.overageEnabled,
      overageHardLimitUsd: hardLimitUsd,
    },
  });
}
