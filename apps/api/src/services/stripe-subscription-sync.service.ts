// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Resolve which workspace + plan a Stripe subscription event belongs to.
 *
 * The webhook used to require `metadata.workspaceId` + `metadata.planId` on the
 * Stripe subscription. 27 of the 36 live subscriptions have no metadata, so a
 * price change (a Subscription Schedule phase flipping legacy→$16 at renewal)
 * would never reach our DB for them — the workspace would keep the old plan,
 * the old seats and the old allowance while Stripe charged the new price.
 *
 * The order here is deliberate (SHO-339):
 *
 *   1. **price id → plan** (`planFromPriceId`). The price is the thing Stripe
 *      actually bills, so it is the most current signal — especially at a
 *      scheduled renewal, where metadata may still describe the old phase.
 *   2. **`metadata.planId`** for anything the price map does not recognise.
 *   3. **the DB `Subscription` row**, found by `stripeSubscriptionId`, for the
 *      `workspaceId` when metadata is missing.
 *
 * Only the *licensed* item is read. A shogo subscription also carries a metered
 * overage item; reading `items.data[0]` blindly can make the overage price look
 * like the plan (see `billing.service.ts`'s own `overageCfg.priceId` filter).
 */

import { getOveragePriceConfig, planFromPriceId, type PlanType } from '../config/stripe-prices'

export interface StripePriceRefLike {
  id?: string | null
}

export interface StripeSubscriptionItemLike {
  id?: string
  /** Seat count on the licensed item. */
  quantity?: number | null
  price?: StripePriceRefLike | string | null
}

export interface StripeSubscriptionLike {
  id: string
  status?: string | null
  metadata?: Record<string, string> | null
  items?: { data?: StripeSubscriptionItemLike[] | null } | null
}

export interface ResolvedSubscriptionContext {
  workspaceId: string
  planId: string
  /** Price id of the licensed item, or null when the sub has no priced item. */
  priceId: string | null
  /** Seats on the licensed item (always ≥ 1). */
  seats: number
}

function priceIdOf(item: StripeSubscriptionItemLike): string | null {
  const price = item.price
  if (!price) return null
  if (typeof price === 'string') return price
  return price.id ?? null
}

/**
 * The plan (licensed) item of a subscription — the first item whose price is
 * not the metered overage price.
 */
export function selectPlanItem(
  sub: StripeSubscriptionLike,
  overagePriceId: string | null = getOveragePriceConfig().priceId,
): StripeSubscriptionItemLike | null {
  const items = sub.items?.data ?? []
  for (const item of items) {
    const priceId = priceIdOf(item)
    if (!priceId) continue
    if (overagePriceId && priceId === overagePriceId) continue
    return item
  }
  return null
}

export function planItemSeats(
  sub: StripeSubscriptionLike,
  overagePriceId?: string | null,
): number {
  const item = selectPlanItem(sub, overagePriceId)
  return Math.max(1, Math.floor(item?.quantity ?? 1))
}

/** Plans that are an add-on subscription rather than a Shogo plan tier. */
const NON_PLAN_METADATA_PLANS = new Set(['instance', 'capacity'])

/**
 * Resolve `{ workspaceId, planId, priceId, seats }` for a Stripe subscription,
 * preferring the billed price over the (often stale or missing) metadata.
 *
 * `lookupSubscription` supplies the DB row by `stripeSubscriptionId` and is
 * injected so this stays unit-testable without a database.
 */
export async function resolveSubscriptionContext(
  sub: StripeSubscriptionLike,
  lookupSubscription: (
    stripeSubscriptionId: string,
  ) => Promise<{ workspaceId: string; planId: string | null } | null>,
): Promise<ResolvedSubscriptionContext | null> {
  const item = selectPlanItem(sub)
  const priceId = item ? priceIdOf(item) : null
  const pricePlan: PlanType | null = planFromPriceId(priceId)

  const metaPlanId = sub.metadata?.planId
  const metadataPlan =
    metaPlanId && !NON_PLAN_METADATA_PLANS.has(metaPlanId) ? metaPlanId : null

  let workspaceId = sub.metadata?.workspaceId ?? null
  let dbPlanId: string | null = null
  // One DB read, only when it can add something: a missing workspace or a price
  // we cannot map to a plan (e.g. a price id that only exists in this Stripe
  // account, so it is not in the static map).
  if (!workspaceId || !(pricePlan ?? metadataPlan)) {
    const row = await lookupSubscription(sub.id)
    workspaceId = workspaceId ?? row?.workspaceId ?? null
    dbPlanId = row?.planId ?? null
  }

  const planId = pricePlan ?? metadataPlan ?? dbPlanId
  if (!workspaceId || !planId) return null

  return {
    workspaceId,
    planId,
    priceId,
    seats: Math.max(1, Math.floor(item?.quantity ?? 1)),
  }
}
