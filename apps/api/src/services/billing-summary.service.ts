// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Billing summary + in-app plan change (SHO-451).
 *
 * The billing page has to answer three questions before anything else: what
 * plan am I on, what will I pay next, and how much usage is left. The first two
 * live here.
 *
 * `getBillingSummary` reads the plan/period/seats from our own `Subscription`
 * row and asks Stripe only for the two things we cannot derive: the next
 * invoice (`invoices.createPreview`) and the card on file. A grant-only or free
 * workspace gets nulls, never a 404 — the page still renders.
 *
 * `previewPlanChange` / `applyPlanChange` replace the old "Change Plan opens a
 * second Checkout" path. A second Checkout created a second Stripe
 * subscription; `syncFromStripe` upserts by `workspaceId`, so the new row
 * overwrote the old one and the original subscription kept billing. Changing
 * the existing subscription in place is the only correct way to move plans.
 */

import { prisma } from '../lib/prisma'
import * as billingService from './billing.service'
import { getOveragePriceConfig } from '../config/stripe-prices'
import { normalizeCheckoutPlanId, resolveCheckoutPriceId } from './stripe-price-lookup.service'
import {
  TRIAL_MAX_SEATS,
  TRIAL_SEAT_LIMIT_CODE,
  getMonthlyIncludedForPlanAndPrice,
  trialSeatLimitMessage,
} from '../config/usage-plans'

export type BillingPlanSource = 'subscription' | 'grant' | 'free'

export interface BillingSummaryPaymentMethod {
  brand: string
  last4: string
  expMonth: number
  expYear: number
}

export interface BillingSummaryNextInvoice {
  amountUsd: number
  currency: string
  /** ISO timestamp of the next charge, or null when Stripe has not scheduled one. */
  date: string | null
}

export interface BillingSummaryPastDue {
  reason: 'subscription_past_due' | 'overage_unpaid'
  amountUsd: number
  invoiceUrl: string | null
}

export interface BillingSummary {
  planId: string
  planSource: BillingPlanSource
  status: string | null
  seats: number
  billingInterval: 'monthly' | 'annual' | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  trialEndsAt: string | null
  nextInvoice: BillingSummaryNextInvoice | null
  paymentMethod: BillingSummaryPaymentMethod | null
  pastDue: BillingSummaryPastDue | null
}

export interface PlanChangePreview {
  planId: string
  billingInterval: 'monthly' | 'annual'
  seats: number
  /** Recurring amount the workspace pays today. */
  currentPriceUsd: number
  /** Recurring amount after the change. */
  newPriceUsd: number
  /** Charged today for the proration. */
  prorationUsd: number
  /** When the change takes effect (immediate). */
  effectiveAt: string
  /** What the next renewal will be. */
  nextInvoiceUsd: number
  /**
   * Unix seconds the preview was computed at. Sent back on apply so Stripe
   * charges exactly what the customer was shown.
   */
  prorationDate: number
}

export interface PlanChangeResult {
  ok: true
  planId: string
  billingInterval: 'monthly' | 'annual'
  seats: number
  status: string
  currentPeriodEnd: string | null
}

/**
 * A refusal the route turns into `{ error: { code, message } }` with `status`.
 * Never a 200 with an empty body: the page has to be able to say why.
 */
export class BillingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'BillingError'
  }
}

/** The subset of the Stripe SDK this service uses. */
export interface BillingStripe {
  subscriptions: {
    retrieve(id: string, params?: any): Promise<any>
    update(id: string, params: any): Promise<any>
  }
  invoices: {
    createPreview(params: any): Promise<any>
    list(params: any): Promise<{ data: any[] }>
  }
  customers: { retrieve(id: string): Promise<any> }
  prices: { retrieve(id: string): Promise<any> }
}

const SUMMARY_TTL_MS = 60_000
const summaryCache = new Map<string, { value: BillingSummary; expiresAt: number }>()

/** Drop a workspace's cached summary (after a plan change, cancel or resume). */
export function invalidateBillingSummaryCache(workspaceId: string): void {
  summaryCache.delete(workspaceId)
}

/** @internal test-only — clear every cached summary. */
export function __resetBillingSummaryCacheForTesting(): void {
  summaryCache.clear()
}

const ACTIVE_STATUSES = ['active', 'trialing', 'past_due'] as const

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function centsToUsd(cents: number | null | undefined): number {
  return Math.round(Number(cents ?? 0)) / 100
}

/**
 * The per-seat licensed item on a Stripe subscription — the one that is not
 * the metered overage price. Resolved by shape rather than a hardcoded price id
 * so a monthly/annual swap does not break it.
 */
function findLicensedItem(stripeSubscription: any): any | null {
  const overagePriceId = getOveragePriceConfig().priceId
  const items: any[] = stripeSubscription?.items?.data ?? []
  return (
    items.find(
      (item) =>
        item?.price?.id !== overagePriceId &&
        item?.price?.recurring?.usage_type !== 'metered',
    ) ?? null
  )
}

function mapPaymentMethod(pm: any): BillingSummaryPaymentMethod | null {
  const card = pm?.card
  if (!card?.last4) return null
  return {
    brand: String(card.brand ?? 'card'),
    last4: String(card.last4),
    expMonth: Number(card.exp_month ?? 0),
    expYear: Number(card.exp_year ?? 0),
  }
}

/**
 * The card the subscription will be charged on: the subscription's own default
 * payment method, else the customer's invoice default.
 */
async function resolvePaymentMethod(
  stripe: BillingStripe,
  subscription: { stripeSubscriptionId: string; stripeCustomerId: string },
): Promise<BillingSummaryPaymentMethod | null> {
  const stripeSub = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId, {
    expand: ['default_payment_method'],
  })
  const direct = stripeSub?.default_payment_method
  if (direct && typeof direct === 'object') {
    const mapped = mapPaymentMethod(direct)
    if (mapped) return mapped
  }
  const customer = await stripe.customers.retrieve(subscription.stripeCustomerId)
  return mapPaymentMethod(customer?.invoice_settings?.default_payment_method)
}

async function resolveNextInvoice(
  stripe: BillingStripe,
  subscription: { stripeSubscriptionId: string; stripeCustomerId: string },
): Promise<BillingSummaryNextInvoice | null> {
  const preview = await stripe.invoices.createPreview({
    customer: subscription.stripeCustomerId,
    subscription: subscription.stripeSubscriptionId,
  })
  const date =
    preview?.next_payment_attempt ??
    preview?.period_end ??
    preview?.lines?.data?.[0]?.period?.end ??
    null
  return {
    amountUsd: centsToUsd(preview?.amount_due ?? preview?.total ?? 0),
    currency: String(preview?.currency ?? 'usd').toUpperCase(),
    date: date ? new Date(Number(date) * 1000).toISOString() : null,
  }
}

async function resolvePastDue(
  stripe: BillingStripe,
  subscription: { stripeSubscriptionId: string; stripeCustomerId: string; status: string },
  wallet: { overageOutstandingInvoiceId?: string | null; overageOutstandingUsd?: number | null; overageOutstandingInvoiceUrl?: string | null } | null,
): Promise<BillingSummaryPastDue | null> {
  if (subscription.status === 'past_due') {
    const open = await stripe.invoices.list({
      customer: subscription.stripeCustomerId,
      subscription: subscription.stripeSubscriptionId,
      status: 'open',
      limit: 1,
    })
    const invoice = open?.data?.[0]
    return {
      reason: 'subscription_past_due',
      amountUsd: centsToUsd(invoice?.amount_due ?? 0),
      invoiceUrl: invoice?.hosted_invoice_url ?? null,
    }
  }
  if (wallet?.overageOutstandingInvoiceId) {
    return {
      reason: 'overage_unpaid',
      amountUsd: Number(wallet.overageOutstandingUsd ?? 0),
      invoiceUrl: wallet.overageOutstandingInvoiceUrl ?? null,
    }
  }
  return null
}

/**
 * Everything the billing page's summary card and payment banner need.
 *
 * `stripe` is optional so a local/desktop install (no Stripe) still gets the
 * plan, seats and period from our own row instead of an error.
 */
export async function getBillingSummary(params: {
  workspaceId: string
  stripe?: BillingStripe | null
}): Promise<BillingSummary> {
  const billingWorkspaceId = await billingService.resolveBillingWorkspaceId(params.workspaceId)
  const cached = summaryCache.get(billingWorkspaceId)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  const [subscription, effectivePlanId, wallet] = await Promise.all([
    billingService.getSubscription(billingWorkspaceId),
    billingService.getEffectivePlanId(billingWorkspaceId),
    billingService.getUsageWallet(billingWorkspaceId),
  ])

  const planSource: BillingPlanSource = subscription
    ? 'subscription'
    : effectivePlanId !== 'free'
      ? 'grant'
      : 'free'

  const summary: BillingSummary = {
    planId: subscription?.planId ?? effectivePlanId,
    planSource,
    status: subscription?.status ?? (planSource === 'grant' ? 'active' : null),
    seats: Math.max(1, subscription?.seats ?? 1),
    billingInterval: (subscription?.billingInterval as 'monthly' | 'annual' | undefined) ?? null,
    currentPeriodEnd: iso(subscription?.currentPeriodEnd),
    cancelAtPeriodEnd: Boolean(subscription?.cancelAtPeriodEnd),
    trialEndsAt: subscription?.status === 'trialing' ? iso(subscription?.currentPeriodEnd) : null,
    nextInvoice: null,
    paymentMethod: null,
    pastDue: null,
  }

  const stripe = params.stripe ?? null
  const billable =
    subscription && stripe && (ACTIVE_STATUSES as readonly string[]).includes(subscription.status)

  if (billable) {
    try {
      const [nextInvoice, paymentMethod, pastDue] = await Promise.all([
        resolveNextInvoice(stripe, subscription),
        resolvePaymentMethod(stripe, subscription),
        resolvePastDue(stripe, subscription, wallet),
      ])
      summary.nextInvoice = nextInvoice
      summary.paymentMethod = paymentMethod
      summary.pastDue = pastDue
    } catch (error: any) {
      // A Stripe outage must not blank the page: the plan, seats and period
      // above are ours and are still true. Say the enrichment failed instead.
      throw new BillingError(
        'stripe_error',
        error?.message ?? 'Could not read the subscription from Stripe',
        502,
      )
    }
  } else if (wallet?.overageOutstandingInvoiceId) {
    summary.pastDue = {
      reason: 'overage_unpaid',
      amountUsd: Number(wallet.overageOutstandingUsd ?? 0),
      invoiceUrl: wallet.overageOutstandingInvoiceUrl ?? null,
    }
  }

  summaryCache.set(billingWorkspaceId, { value: summary, expiresAt: Date.now() + SUMMARY_TTL_MS })
  return summary
}

interface ResolvedTarget {
  planId: 'basic' | 'business'
  billingInterval: 'monthly' | 'annual'
  seats: number
}

/**
 * Validate a requested plan change against the workspace's current
 * subscription. Basic is single-seat; a trial never holds more than
 * `TRIAL_MAX_SEATS`; Pro is retired and remaps to Business.
 */
function resolveTarget(
  requested: { planId?: string; billingInterval?: string; seats?: number },
  subscription: { status: string },
): ResolvedTarget {
  const rawPlanId = String(requested.planId ?? '').toLowerCase()
  if (rawPlanId !== 'basic' && rawPlanId !== 'pro' && rawPlanId !== 'business') {
    throw new BillingError('invalid_plan', `Unknown plan: ${requested.planId}`, 400)
  }
  const planId = normalizeCheckoutPlanId(rawPlanId) as 'basic' | 'business'
  const billingInterval = requested.billingInterval === 'annual' ? 'annual' : 'monthly'
  const seats =
    planId === 'basic' ? 1 : Math.max(1, Math.floor(Number(requested.seats) || 1))
  if (subscription.status === 'trialing' && seats > TRIAL_MAX_SEATS) {
    throw new BillingError(
      TRIAL_SEAT_LIMIT_CODE,
      trialSeatLimitMessage(TRIAL_MAX_SEATS),
      400,
    )
  }
  return { planId, billingInterval, seats }
}

async function loadChangeContext(params: {
  workspaceId: string
  stripe: BillingStripe
  requested: { planId?: string; billingInterval?: string; seats?: number }
}) {
  const billingWorkspaceId = await billingService.resolveBillingWorkspaceId(params.workspaceId)
  const subscription = await billingService.getSubscription(billingWorkspaceId)
  if (!subscription) {
    throw new BillingError(
      'no_subscription',
      'This workspace has no subscription to change. Start a checkout instead.',
      409,
    )
  }
  if (!(ACTIVE_STATUSES as readonly string[]).includes(subscription.status)) {
    throw new BillingError(
      'subscription_inactive',
      `This subscription is ${subscription.status}. Start a checkout to subscribe again.`,
      409,
    )
  }
  const target = resolveTarget(params.requested, subscription)
  const priceId = await resolveCheckoutPriceId(
    params.stripe as any,
    target.planId,
    target.billingInterval,
  )
  if (!priceId) {
    throw new BillingError(
      'price_not_provisioned',
      `The ${target.planId} ${target.billingInterval} price has not been created in Stripe yet`,
      503,
    )
  }
  const stripeSubscription = await params.stripe.subscriptions.retrieve(
    subscription.stripeSubscriptionId,
  )
  const item = findLicensedItem(stripeSubscription)
  if (!item) {
    throw new BillingError(
      'no_seat_item',
      'This subscription has no per-seat item to change.',
      409,
    )
  }
  return { billingWorkspaceId, subscription, target, priceId, item }
}

/**
 * What a plan change would cost, before the customer confirms it.
 *
 * `prorationDate` is returned so `applyPlanChange` can pin Stripe to the same
 * instant — otherwise a slow confirm charges a different proration than the
 * one that was shown.
 */
export async function previewPlanChange(params: {
  workspaceId: string
  stripe: BillingStripe
  planId?: string
  billingInterval?: string
  seats?: number
}): Promise<PlanChangePreview> {
  const { subscription, target, priceId, item } = await loadChangeContext({
    workspaceId: params.workspaceId,
    stripe: params.stripe,
    requested: params,
  })

  const prorationDate = Math.floor(Date.now() / 1000)
  const preview = await params.stripe.invoices.createPreview({
    customer: subscription.stripeCustomerId,
    subscription: subscription.stripeSubscriptionId,
    subscription_details: {
      items: [{ id: item.id, price: priceId, quantity: target.seats }],
      proration_behavior: 'always_invoice',
      proration_date: prorationDate,
    },
  })

  const price = await params.stripe.prices.retrieve(priceId)
  const currentPriceUsd =
    centsToUsd(item?.price?.unit_amount) * Math.max(1, Number(item?.quantity ?? 1))
  const newPriceUsd = centsToUsd(price?.unit_amount) * target.seats
  const prorationUsd = (preview?.lines?.data ?? [])
    .filter((line: any) => line?.proration === true)
    .reduce((sum: number, line: any) => sum + centsToUsd(line?.amount), 0)

  return {
    planId: target.planId,
    billingInterval: target.billingInterval,
    seats: target.seats,
    currentPriceUsd,
    newPriceUsd,
    prorationUsd: Math.round(prorationUsd * 100) / 100,
    effectiveAt: new Date(prorationDate * 1000).toISOString(),
    nextInvoiceUsd: newPriceUsd,
    prorationDate,
  }
}

/**
 * Apply a plan change to the existing Stripe subscription, then mirror it into
 * our `Subscription` row. Never creates a second subscription.
 */
export async function applyPlanChange(params: {
  workspaceId: string
  stripe: BillingStripe
  planId?: string
  billingInterval?: string
  seats?: number
  prorationDate?: number
}): Promise<PlanChangeResult> {
  const { billingWorkspaceId, subscription, target, priceId, item } = await loadChangeContext({
    workspaceId: params.workspaceId,
    stripe: params.stripe,
    requested: params,
  })

  const prorationDate =
    Number.isFinite(params.prorationDate) && Number(params.prorationDate) > 0
      ? Math.floor(Number(params.prorationDate))
      : Math.floor(Date.now() / 1000)

  const updated = await params.stripe.subscriptions.update(subscription.stripeSubscriptionId, {
    items: [{ id: item.id, price: priceId, quantity: target.seats }],
    proration_behavior: 'always_invoice',
    proration_date: prorationDate,
  })

  const periodStart = updated?.current_period_start
    ? new Date(Number(updated.current_period_start) * 1000)
    : subscription.currentPeriodStart
  const periodEnd = updated?.current_period_end
    ? new Date(Number(updated.current_period_end) * 1000)
    : subscription.currentPeriodEnd

  await billingService.syncFromStripe({
    stripeSubscriptionId: subscription.stripeSubscriptionId,
    stripeCustomerId: subscription.stripeCustomerId,
    workspaceId: billingWorkspaceId,
    planId: target.planId,
    seats: target.seats,
    stripePriceId: priceId,
    status: (updated?.status ?? subscription.status) as any,
    billingInterval: target.billingInterval as any,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: Boolean(updated?.cancel_at_period_end ?? subscription.cancelAtPeriodEnd),
  })

  // The included allowance follows the plan and seat count. Update the
  // allocation in place rather than calling `allocateMonthlyIncluded`, which
  // would also reset the usage period and hand out a fresh allowance mid-cycle.
  const grant = await billingService.getActiveGrantsForWorkspace(billingWorkspaceId)
  const includedUsd =
    getMonthlyIncludedForPlanAndPrice(target.planId, target.seats + grant.freeSeats, priceId) +
    grant.monthlyIncludedUsd
  await prisma.usageWallet.updateMany({
    where: { workspaceId: billingWorkspaceId },
    data: { monthlyIncludedUsd: includedUsd, monthlyIncludedAllocationUsd: includedUsd },
  })

  invalidateBillingSummaryCache(billingWorkspaceId)

  return {
    ok: true,
    planId: target.planId,
    billingInterval: target.billingInterval,
    seats: target.seats,
    status: String(updated?.status ?? subscription.status),
    currentPeriodEnd: iso(periodEnd),
  }
}

/**
 * Self-serve cancel (`cancel_at_period_end: true`) and resume (`false`).
 * Access is kept until the period ends; nothing is deleted.
 */
export async function setCancelAtPeriodEnd(params: {
  workspaceId: string
  stripe: BillingStripe
  cancel: boolean
}): Promise<{ ok: true; cancelAtPeriodEnd: boolean; accessEndsAt: string | null }> {
  const billingWorkspaceId = await billingService.resolveBillingWorkspaceId(params.workspaceId)
  const subscription = await billingService.getSubscription(billingWorkspaceId)
  if (!subscription) {
    throw new BillingError('no_subscription', 'This workspace has no subscription.', 409)
  }
  if (!(ACTIVE_STATUSES as readonly string[]).includes(subscription.status)) {
    throw new BillingError(
      'subscription_inactive',
      `This subscription is ${subscription.status}.`,
      409,
    )
  }

  const updated = await params.stripe.subscriptions.update(subscription.stripeSubscriptionId, {
    cancel_at_period_end: params.cancel,
  })

  const periodEnd = updated?.current_period_end
    ? new Date(Number(updated.current_period_end) * 1000)
    : subscription.currentPeriodEnd

  await billingService.syncFromStripe({
    stripeSubscriptionId: subscription.stripeSubscriptionId,
    stripeCustomerId: subscription.stripeCustomerId,
    workspaceId: billingWorkspaceId,
    planId: subscription.planId,
    seats: subscription.seats,
    status: (updated?.status ?? subscription.status) as any,
    billingInterval: subscription.billingInterval as any,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: params.cancel,
  })

  invalidateBillingSummaryCache(billingWorkspaceId)

  return {
    ok: true,
    cancelAtPeriodEnd: params.cancel,
    accessEndsAt: iso(periodEnd),
  }
}
