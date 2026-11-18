// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Free trial on paid plan upgrades.
 *
 * - Card is required up front (Stripe Checkout `payment_method_collection:
 *   'always'`, cards only), $0 due today, auto-charges when the trial ends.
 * - `missing_payment_method: 'cancel'` so a trial that ends without a payment
 *   method cancels instead of silently running free.
 * - One trial per user and per workspace. A card may start only one trial:
 *   its fingerprint is recorded in `trial_redemptions` and a second trial on
 *   the same card is cancelled right after it starts.
 * - While trialing, the workspace is entitled to its plan's rolling windows
 *   (`getEffectivePlanId` treats `trialing` as entitled), but the monthly
 *   allowance and overage wait for the first paid invoice.
 */

import type Stripe from 'stripe'
import { prisma } from '../lib/prisma'
import {
  TRIAL_ELIGIBLE_PLANS,
  TRIAL_MAX_SEATS,
  TRIAL_PERIOD_DAYS,
  TRIAL_SEAT_LIMIT_CODE,
  trialSeatLimitMessage,
} from '../config/usage-plans'

/** Values stored on `trial_redemptions.status`. */
export const TRIAL_STATUS = {
  trialing: 'trialing',
  converted: 'converted',
  ended: 'ended',
  blockedDuplicateCard: 'blocked_duplicate_card',
  blockedDuplicateUser: 'blocked_duplicate_user',
  blockedPrepaidCard: 'blocked_prepaid_card',
  blockedSeatLimit: 'blocked_seat_limit',
} as const

const BLOCKED_STATUSES: readonly string[] = [
  TRIAL_STATUS.blockedDuplicateCard,
  TRIAL_STATUS.blockedDuplicateUser,
  TRIAL_STATUS.blockedPrepaidCard,
  TRIAL_STATUS.blockedSeatLimit,
]

/**
 * A trial checkout asked for more seats than a trial may hold. Thrown by
 * `buildCheckoutTrialFields` as a second check behind the routes' own gate, so
 * a future caller cannot skip it; the routes map it to a 400.
 */
export class TrialSeatLimitError extends Error {
  readonly code = TRIAL_SEAT_LIMIT_CODE
  constructor(readonly seats: number, readonly maxSeats: number = TRIAL_MAX_SEATS) {
    super(trialSeatLimitMessage(maxSeats))
    this.name = 'TrialSeatLimitError'
  }
}

export interface TrialEligibility {
  eligible: boolean
  reason?: 'plan_not_eligible' | 'already_used' | 'existing_subscription' | 'risk_review'
}

/**
 * Whether a checkout for `workspaceId` may start a trial. `planId` is optional:
 * the workspace-plan endpoint uses the plan-agnostic check to decide whether to
 * show the trial CTA at all.
 */
export async function trialEligibility(params: {
  userId: string | null | undefined
  workspaceId: string
  planId?: string
}): Promise<TrialEligibility> {
  if (params.planId && !(TRIAL_ELIGIBLE_PLANS as readonly string[]).includes(params.planId)) {
    return { eligible: false, reason: 'plan_not_eligible' }
  }

  const priorRedemption = await prisma.trialRedemption.findFirst({
    where: {
      OR: [
        { workspaceId: params.workspaceId },
        ...(params.userId ? [{ userId: params.userId }] : []),
      ],
      // A seat-limit block is not a used trial (SHO-422): the workspace never
      // got a trial, it was refused for asking for more seats than a trial
      // allows. The owner is told to retry with <= TRIAL_MAX_SEATS, so that row
      // must not lock them out of doing exactly that.
      status: { not: TRIAL_STATUS.blockedSeatLimit },
    },
    select: { id: true },
  })
  if (priorRedemption) return { eligible: false, reason: 'already_used' }

  // A workspace that already had a subscription (any status) has used its
  // paid entry. Trials are for first-time upgrades only.
  const priorSubscription = await prisma.subscription.findFirst({
    where: { workspaceId: params.workspaceId },
    select: { id: true },
  })
  if (priorSubscription) return { eligible: false, reason: 'existing_subscription' }

  if (params.userId) {
    const assessment = await prisma.signupRiskAssessment.findUnique({
      where: { userId: params.userId },
      select: { band: true },
    })
    if (assessment?.band === 'high') return { eligible: false, reason: 'risk_review' }
  }

  return { eligible: true }
}

/**
 * Stripe Checkout parameters for a trial. Returns `{}` when `trialDays` is 0 so
 * callers can spread it unconditionally.
 *
 * `subscriptionMetadata` must carry `workspaceId`/`planId`/`billingInterval`:
 * the webhook handlers identify the workspace from the subscription's metadata
 * (see the invoice refill path), so a trial subscription has to be identifiable
 * the same way a paid one is.
 *
 * Cards only: the one-trial-per-card rule keys on the card fingerprint, which
 * wallets such as Link or bank debits don't expose.
 */
export function trialCheckoutParams(
  trialDays: number,
  subscriptionMetadata: Record<string, string>,
): {
  payment_method_collection?: 'always'
  payment_method_types?: Stripe.Checkout.SessionCreateParams.PaymentMethodType[]
  payment_method_options?: Stripe.Checkout.SessionCreateParams.PaymentMethodOptions
  subscription_data?: Partial<Stripe.Checkout.SessionCreateParams.SubscriptionData>
  metadata?: Record<string, string>
} {
  if (trialDays <= 0) return {}
  return {
    payment_method_collection: 'always',
    payment_method_types: ['card'],
    // Make the issuer authenticate the cardholder whenever the card supports
    // 3D Secure. Fake numbers (`incorrect_number`) and stolen cards fail at
    // checkout instead of at our first overage invoice. Trial checkouts only;
    // paid checkouts are unchanged.
    payment_method_options: { card: { request_three_d_secure: 'any' } },
    subscription_data: {
      trial_period_days: trialDays,
      trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
      metadata: { ...subscriptionMetadata, trial: 'true' },
    },
    metadata: { trial: 'true', trialDays: String(trialDays) },
  }
}

/**
 * Checkout session fields for a seat-plan checkout, with the trial applied when
 * the client asked for one and the account is eligible (otherwise a normal paid
 * checkout). Merges the affiliate overrides so both checkout routes build the
 * session the same way. Spread the result into `checkout.sessions.create`.
 */
export async function buildCheckoutTrialFields(params: {
  wantsTrial: boolean
  userId: string | undefined
  workspaceId: string
  planId: string
  /** Session metadata (`workspaceId`, `planId`, `billingInterval`, `seats`). */
  metadata: Record<string, string>
  affiliate: {
    metadata?: Record<string, string>
    subscription_data?: { metadata?: Record<string, string> } & Record<string, unknown>
  }
}): Promise<{
  metadata: Record<string, string>
  subscription_data?: Record<string, unknown>
  payment_method_collection?: 'always'
  payment_method_types?: Stripe.Checkout.SessionCreateParams.PaymentMethodType[]
  payment_method_options?: Stripe.Checkout.SessionCreateParams.PaymentMethodOptions
}> {
  const { affiliate } = params
  const eligible = params.wantsTrial
    && (await trialEligibility({ userId: params.userId, workspaceId: params.workspaceId, planId: params.planId })).eligible
  // Second check behind the routes' own gate (SHO-422): a trial may never be
  // opened above `TRIAL_MAX_SEATS`, so a future caller cannot skip it. A paid
  // checkout keeps any seat count.
  if (eligible) {
    const seats = Math.max(1, Math.floor(Number(params.metadata?.seats) || 1))
    if (seats > TRIAL_MAX_SEATS) throw new TrialSeatLimitError(seats)
  }
  const trial = trialCheckoutParams(eligible ? TRIAL_PERIOD_DAYS : 0, {
    ...params.metadata,
    ...(affiliate.subscription_data?.metadata ?? {}),
  })
  const subscriptionData = affiliate.subscription_data || trial.subscription_data
    ? { ...(affiliate.subscription_data ?? {}), ...(trial.subscription_data ?? {}) }
    : undefined
  return {
    metadata: { ...params.metadata, ...(affiliate.metadata ?? {}), ...(trial.metadata ?? {}) },
    ...(subscriptionData && { subscription_data: subscriptionData }),
    ...(trial.payment_method_collection && { payment_method_collection: trial.payment_method_collection }),
    ...(trial.payment_method_types && { payment_method_types: trial.payment_method_types }),
    ...(trial.payment_method_options && { payment_method_options: trial.payment_method_options }),
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002'
}

/**
 * Called from the subscription webhook for a `trialing` subscription. Records
 * the trial and enforces one trial per card and per user. Returns `'blocked'`
 * when the card or the owner already used a trial on another workspace (the
 * subscription is then cancelled), and `'already_blocked'` for later deliveries
 * of the same subscription. In both cases the caller must not allocate the
 * wallet; only `'blocked'` should notify the owner.
 *
 * Both `checkout.session.completed` and `customer.subscription.created` call
 * this for the same subscription, often concurrently, so every write is an
 * upsert on the workspace and a lost race on the card fingerprint's unique
 * index is treated as a duplicate card.
 */
export async function recordTrialStart(params: {
  stripe: Stripe
  workspaceId: string
  userId: string | null
  planId: string
  subscriptionId: string
  stripeCustomerId: string
}): Promise<'recorded' | 'already_recorded' | 'blocked' | 'already_blocked'> {
  const existing = await prisma.trialRedemption.findUnique({
    where: { workspaceId: params.workspaceId },
    select: { stripeSubscriptionId: true, status: true },
  })
  if (existing?.stripeSubscriptionId === params.subscriptionId) {
    // A re-delivered webhook (or the other of the two events) must not
    // un-block a duplicate trial.
    return BLOCKED_STATUSES.includes(existing.status) ? 'already_blocked' : 'already_recorded'
  }
  const userId = params.userId ?? (await workspaceOwnerUserId(params.workspaceId))
  if (!userId) throw new Error(`[trial] no owner user for workspace ${params.workspaceId}`)

  // Checkout checks the user, but two checkouts opened side by side (each
  // creating a new workspace) both pass that check before either completes.
  const sameUser = await prisma.trialRedemption.findFirst({
    where: { userId, workspaceId: { not: params.workspaceId } },
    select: { workspaceId: true },
  })
  if (sameUser) {
    return blockTrial(params, userId, TRIAL_STATUS.blockedDuplicateUser, sameUser.workspaceId)
  }

  const sub = await params.stripe.subscriptions.retrieve(params.subscriptionId, {
    expand: ['default_payment_method'],
  })
  const pm = sub.default_payment_method
  const card = pm && typeof pm === 'object' && pm.type === 'card' ? pm.card : null
  const fingerprint = card?.fingerprint ?? null
  if (!fingerprint) {
    console.warn('[trial] trial started without a card fingerprint; card dedupe skipped', {
      workspaceId: params.workspaceId,
      subscriptionId: params.subscriptionId,
    })
  }

  // Prepaid cards can't start a trial: they carry no recoverable balance, so a
  // trial that runs up overage on one is uncollectable (the KZ prepaid card in
  // the Nov 2026 fraud batch). Checkout can't filter by funding type, so this
  // is enforced here. Prepaid stays allowed for normal paid checkout.
  if (card?.funding === 'prepaid') {
    return blockTrial(params, userId, TRIAL_STATUS.blockedPrepaidCard, null)
  }

  if (fingerprint) {
    const sameCard = await prisma.trialRedemption.findUnique({
      where: { cardFingerprint: fingerprint },
      select: { workspaceId: true },
    })
    if (sameCard && sameCard.workspaceId !== params.workspaceId) {
      return blockTrial(params, userId, TRIAL_STATUS.blockedDuplicateCard, sameCard.workspaceId)
    }
  }

  try {
    await prisma.trialRedemption.upsert({
      where: { workspaceId: params.workspaceId },
      create: {
        userId,
        workspaceId: params.workspaceId,
        stripeCustomerId: params.stripeCustomerId,
        stripeSubscriptionId: params.subscriptionId,
        cardFingerprint: fingerprint,
        planId: params.planId,
        status: TRIAL_STATUS.trialing,
      },
      update: {
        stripeSubscriptionId: params.subscriptionId,
        cardFingerprint: fingerprint,
        planId: params.planId,
        status: TRIAL_STATUS.trialing,
      },
    })
  } catch (err) {
    // Another workspace claimed this card between the lookup and the write.
    if (fingerprint && isUniqueConstraintError(err)) {
      return blockTrial(params, userId, TRIAL_STATUS.blockedDuplicateCard, null)
    }
    throw err
  }
  return 'recorded'
}

async function blockTrial(
  params: {
    stripe: Stripe
    workspaceId: string
    planId: string
    subscriptionId: string
    stripeCustomerId: string
  },
  userId: string,
  status:
    | typeof TRIAL_STATUS.blockedDuplicateCard
    | typeof TRIAL_STATUS.blockedDuplicateUser
    | typeof TRIAL_STATUS.blockedPrepaidCard
    | typeof TRIAL_STATUS.blockedSeatLimit,
  matchedWorkspaceId: string | null,
): Promise<'blocked'> {
  try {
    await params.stripe.subscriptions.cancel(params.subscriptionId)
  } catch (err: any) {
    // Already cancelled — a re-delivered event, or the other of the two events
    // Stripe fires for one checkout. The block still has to be recorded.
    console.warn('[trial] cancel failed while blocking:', err?.message ?? err)
  }
  await prisma.trialRedemption.upsert({
    where: { workspaceId: params.workspaceId },
    create: {
      userId,
      workspaceId: params.workspaceId,
      stripeCustomerId: params.stripeCustomerId,
      stripeSubscriptionId: params.subscriptionId,
      cardFingerprint: null,
      planId: params.planId,
      status,
    },
    update: { status, stripeSubscriptionId: params.subscriptionId },
  })
  console.warn('[trial] blocked trial', {
    status,
    workspaceId: params.workspaceId,
    matchedWorkspaceId,
  })
  return 'blocked'
}

/**
 * The status written for a blocked trial (`blocked_duplicate_card`,
 * `blocked_duplicate_user`, `blocked_prepaid_card`, `blocked_seat_limit`), or
 * null. `recordTrialStart` returns only `'blocked'`; the webhook reads this to
 * tell the owner *why*.
 */
export async function getTrialBlockStatus(workspaceId: string): Promise<string | null> {
  const row = await prisma.trialRedemption.findUnique({
    where: { workspaceId },
    select: { status: true },
  })
  return row?.status ?? null
}

/**
 * Cancel a trial that was created with more than `TRIAL_MAX_SEATS` seats and
 * record why (SHO-422). Same shape as a duplicate-card block: no invoice, no
 * proration, no wallet — the caller must not allocate one.
 *
 * This is the case we actually hit: a checkout session opened before the cap
 * existed, or a subscription made in the Stripe dashboard, arrives here with
 * 123 seats. Returns `'already_blocked'` for a re-delivered event so the owner
 * is emailed once.
 */
export async function blockTrialForSeatLimit(params: {
  stripe: Stripe
  workspaceId: string
  planId: string
  subscriptionId: string
  stripeCustomerId: string
}): Promise<'blocked' | 'already_blocked'> {
  const existing = await prisma.trialRedemption.findUnique({
    where: { workspaceId: params.workspaceId },
    select: { stripeSubscriptionId: true, status: true },
  })
  if (existing?.stripeSubscriptionId === params.subscriptionId
    && existing.status === TRIAL_STATUS.blockedSeatLimit) {
    return 'already_blocked'
  }
  const userId = await workspaceOwnerUserId(params.workspaceId)
  if (!userId) throw new Error(`[trial] no owner user for workspace ${params.workspaceId}`)
  await blockTrial(params, userId, TRIAL_STATUS.blockedSeatLimit, null)
  return 'blocked'
}

export type TrialSeatCapOutcome =
  | { action: 'none' }
  | { action: 'clamped'; seats: number }
  | { action: 'blocked' }
  | { action: 'already_blocked' }

/**
 * Enforce the trial seat cap on a subscription that is already `trialing`
 * (SHO-422). One function for every Stripe path, so the webhook, the checkout
 * completion and `verify-checkout` cannot drift:
 *
 * - `created` over the cap: block the trial (cancel, record, no wallet).
 * - `updated` over the cap: put the seat item back to the cap with no
 *   proration, and report the capped quantity so the DB syncs to it rather
 *   than to Stripe's raised one.
 *
 * `seats` at or under the cap is a no-op.
 */
export async function enforceTrialSeatCap(params: {
  stripe: Stripe
  /** `created` blocks an over-cap trial; `updated` clamps it back. */
  event: 'created' | 'updated'
  workspaceId: string
  planId: string
  subscriptionId: string
  stripeCustomerId: string
  seats: number
  /** The licensed (plan) item, so `updated` can reset its quantity. */
  seatItemId: string | null
}): Promise<TrialSeatCapOutcome> {
  if (params.seats <= TRIAL_MAX_SEATS) return { action: 'none' }

  if (params.event === 'created') {
    const outcome = await blockTrialForSeatLimit(params)
    return { action: outcome }
  }

  if (params.seatItemId) {
    await params.stripe.subscriptionItems.update(params.seatItemId, {
      quantity: TRIAL_MAX_SEATS,
      proration_behavior: 'none',
    })
  }
  console.warn('[trial] seat cap: reset quantity', {
    workspaceId: params.workspaceId,
    from: params.seats,
    to: TRIAL_MAX_SEATS,
  })
  return { action: 'clamped', seats: TRIAL_MAX_SEATS }
}

/**
 * End a trial now and charge the card (SHO-422). Returns Stripe's status after
 * the change and the status of the invoice it created, so the caller can tell
 * "paid" from "open" instead of reporting a success it did not get.
 *
 * The trial -> paid conversion itself is the existing `invoice.payment_succeeded`
 * path (`markTrialConverted` + monthly allocation), not this function.
 */
export async function endTrialNow(params: {
  stripe: Stripe
  stripeSubscriptionId: string
}): Promise<{ status: string; latestInvoiceStatus: string | null }> {
  const updated = await params.stripe.subscriptions.update(params.stripeSubscriptionId, {
    trial_end: 'now',
    proration_behavior: 'none',
    expand: ['latest_invoice'],
  }) as Stripe.Subscription & { latest_invoice?: any }
  const latestInvoice = updated.latest_invoice
  return {
    status: updated.status,
    latestInvoiceStatus: latestInvoice && typeof latestInvoice === 'object'
      ? (latestInvoice.status ?? null)
      : null,
  }
}

async function workspaceOwnerUserId(workspaceId: string): Promise<string | null> {
  const owner = await prisma.member.findFirst({
    where: { workspaceId, role: 'owner', projectId: null },
    select: { userId: true },
    orderBy: { createdAt: 'asc' },
  })
  return owner?.userId ?? null
}

/** First paid invoice after a trial. Only an active trial row moves. */
export async function markTrialConverted(workspaceId: string): Promise<void> {
  await prisma.trialRedemption.updateMany({
    where: { workspaceId, status: TRIAL_STATUS.trialing },
    data: { status: TRIAL_STATUS.converted },
  })
}

/** Subscription deleted while still trialing (cancelled before the first charge). */
export async function markTrialEndedForSubscription(stripeSubscriptionId: string): Promise<void> {
  await prisma.trialRedemption.updateMany({
    where: { stripeSubscriptionId, status: TRIAL_STATUS.trialing },
    data: { status: TRIAL_STATUS.ended },
  })
}
