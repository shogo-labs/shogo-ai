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
import { SIGNUP_RISK_WINDOW_DAYS } from '../config/signup-risk-config'
import {
  collectSignupRiskFeatures,
  type SignupRequestInfo,
} from './signup-risk.service'
import { scoreSignupRisk, type SignupProvider } from './signup-risk-scoring'

/** Values stored on `trial_redemptions.status`. */
export const TRIAL_STATUS = {
  trialing: 'trialing',
  converted: 'converted',
  ended: 'ended',
  blockedDuplicateCard: 'blocked_duplicate_card',
  blockedDuplicateUser: 'blocked_duplicate_user',
  blockedDuplicateNetwork: 'blocked_duplicate_network',
  blockedPrepaidCard: 'blocked_prepaid_card',
  blockedSeatLimit: 'blocked_seat_limit',
} as const

const BLOCKED_STATUSES: readonly string[] = [
  TRIAL_STATUS.blockedDuplicateCard,
  TRIAL_STATUS.blockedDuplicateUser,
  TRIAL_STATUS.blockedDuplicateNetwork,
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
  /**
   * Which risk rule refused the trial. The public `reason` stays `risk_review`
   * so the client shows one message; this is for logs and admin.
   */
  detail?: 'member_high_risk' | 'checkout_high_risk' | 'network_trial_used'
  /** The checkout re-score, when one ran. Surfaced in the Stripe session metadata. */
  checkoutRiskScore?: number
}

/** A network a trial can be tied to: the signup IP prefix and/or device id. */
interface TrialNetwork {
  ipPrefix: string | null
  deviceId: string | null
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
}

/**
 * Whether another account on one of these networks already started a trial in
 * the window (SHO-440).
 *
 * The network comes from the redeemers' `signup_risk_assessments` rows, which
 * already carry `ipPrefix` and `deviceId` with indexes, so this needs no schema
 * change. Every status counts: an ended or blocked attempt still means the
 * network has had its trial.
 */
async function networkTrialUsed(params: {
  userId: string
  networks: Array<TrialNetwork | null | undefined>
  now?: Date
}): Promise<boolean> {
  const ipPrefixes = [...new Set(params.networks.map((n) => n?.ipPrefix).filter((v): v is string => !!v))]
  const deviceIds = [...new Set(params.networks.map((n) => n?.deviceId).filter((v): v is string => !!v))]
  if (ipPrefixes.length === 0 && deviceIds.length === 0) return false

  const recent = await prisma.trialRedemption.findMany({
    where: {
      userId: { not: params.userId },
      createdAt: { gte: daysAgo(params.now ?? new Date(), SIGNUP_RISK_WINDOW_DAYS) },
    },
    select: { userId: true },
  })
  const otherUserIds = [...new Set(recent.map((r) => r.userId))]
  if (otherUserIds.length === 0) return false

  const match = await prisma.signupRiskAssessment.findFirst({
    where: {
      userId: { in: otherUserIds },
      OR: [
        ...(ipPrefixes.length ? [{ ipPrefix: { in: ipPrefixes } }] : []),
        ...(deviceIds.length ? [{ deviceId: { in: deviceIds } }] : []),
      ],
    },
    select: { userId: true },
  })
  return !!match
}

/** The provider a signup was scored with, from the stored assessment signals. */
function providerFromSignals(signals: unknown): SignupProvider {
  return (signals as { provider?: string } | null)?.provider === 'social' ? 'social' : 'credential'
}

/**
 * Whether a checkout for `workspaceId` may start a trial. `planId` is optional:
 * the workspace-plan endpoint uses the plan-agnostic check to decide whether to
 * show the trial CTA at all.
 *
 * `request` is the checkout's own request info. When it is passed, the trial is
 * re-scored with the checkout's IP and device, so a farmed account cannot pass
 * on a clean signup score and then start a trial from the same network
 * (SHO-440). The signup assessment is never overwritten: signup credit depends
 * on it.
 */
export async function trialEligibility(params: {
  userId: string | null | undefined
  workspaceId: string
  planId?: string
  request?: SignupRequestInfo
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

  if (!params.userId) return { eligible: true }

  const assessment = await prisma.signupRiskAssessment.findUnique({
    where: { userId: params.userId },
    select: { band: true, ipPrefix: true, deviceId: true, signals: true },
  })
  if (assessment?.band === 'high') return { eligible: false, reason: 'risk_review' }

  // Anyone in the workspace being upgraded counts, not just the buyer: the
  // Nov 18 farm put its one high-risk account into another account's trial
  // workspace (SHO-440). A manual `approved` review clears a member.
  const members = await prisma.member.findMany({
    where: { workspaceId: params.workspaceId, projectId: null, userId: { not: params.userId } },
    select: { userId: true },
  })
  if (members.length > 0) {
    const riskyMember = await prisma.signupRiskAssessment.findFirst({
      where: {
        userId: { in: members.map((m) => m.userId) },
        band: 'high',
        OR: [{ reviewDecision: null }, { reviewDecision: { not: 'approved' } }],
      },
      select: { userId: true },
    })
    if (riskyMember) {
      console.warn('[trial] refused: a workspace member is high risk', {
        userId: params.userId,
        workspaceId: params.workspaceId,
        memberUserId: riskyMember.userId,
      })
      return { eligible: false, reason: 'risk_review', detail: 'member_high_risk' }
    }
  }

  // Re-score with the checkout's own network. The signup score is left alone.
  let checkoutRiskScore: number | undefined
  if (params.request) {
    const buyer = await prisma.user.findUnique({
      where: { id: params.userId },
      select: { email: true, emailVerified: true },
    })
    if (buyer) {
      const result = scoreSignupRisk(await collectSignupRiskFeatures({
        userId: params.userId,
        email: buyer.email,
        provider: providerFromSignals(assessment?.signals),
        emailVerified: Boolean(buyer.emailVerified),
        request: params.request,
      }))
      checkoutRiskScore = result.score
      if (result.band === 'high') {
        console.warn('[trial] refused: checkout risk re-score is high', {
          userId: params.userId,
          workspaceId: params.workspaceId,
          score: result.score,
          signals: result.signals,
        })
        return { eligible: false, reason: 'risk_review', detail: 'checkout_high_risk', checkoutRiskScore }
      }
    }
  }

  // One trial per network per window, whichever account or card it uses. The
  // buyer's own signup network counts even when the caller passed no request.
  const used = await networkTrialUsed({
    userId: params.userId,
    networks: [params.request, assessment],
  })
  if (used) {
    console.warn('[trial] refused: this network already used a trial', {
      userId: params.userId,
      workspaceId: params.workspaceId,
    })
    return { eligible: false, reason: 'risk_review', detail: 'network_trial_used', checkoutRiskScore }
  }

  return { eligible: true, ...(checkoutRiskScore !== undefined && { checkoutRiskScore }) }
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
 *
 * A PAID checkout (trialDays 0) deliberately returns `{}` — no
 * `payment_method_types` — so Stripe uses dynamic payment methods: Link, Apple
 * Pay and Google Pay appear there once enabled in the Dashboard (growth plan §0
 * G10). Only the trial narrows the list to `['card']`; do not "fix" the missing
 * `payment_method_types` on a paid checkout by setting it.
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
  /** The checkout request, so the trial is re-scored on its IP and device. */
  request?: SignupRequestInfo
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
  const eligibility = params.wantsTrial
    ? await trialEligibility({
        userId: params.userId,
        workspaceId: params.workspaceId,
        planId: params.planId,
        request: params.request,
      })
    : { eligible: false }
  const eligible = eligibility.eligible
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
    metadata: {
      ...params.metadata,
      ...(affiliate.metadata ?? {}),
      ...(trial.metadata ?? {}),
      // Visible on the Stripe session so a refused or accepted trial can be
      // traced back to the score that decided it (SHO-440).
      ...(eligibility.checkoutRiskScore !== undefined && {
        checkoutRiskScore: String(eligibility.checkoutRiskScore),
      }),
    },
    ...(subscriptionData && { subscription_data: subscriptionData }),
    ...(trial.payment_method_collection && { payment_method_collection: trial.payment_method_collection }),
    ...(trial.payment_method_types && { payment_method_types: trial.payment_method_types }),
    ...(trial.payment_method_options && { payment_method_options: trial.payment_method_options }),
  }
}

/**
 * The payment card behind a subscription, read through its default payment
 * method. Shared by the trial dedupe (one trial per card) and the Solo Founder
 * prepaid check (SHO-428) so both read the same field the same way.
 *
 * Returns `null` when the subscription has no attached card — the caller
 * decides whether that is a block or a warning.
 */
export async function readSubscriptionCard(
  stripe: Stripe,
  subscriptionId: string,
): Promise<{ fingerprint: string | null; funding: string | null; brand: string | null; last4: string | null } | null> {
  const sub = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['default_payment_method'],
  })
  const pm = sub.default_payment_method
  const card = pm && typeof pm === 'object' && pm.type === 'card' ? pm.card : null
  if (!card) return null
  return {
    fingerprint: card.fingerprint ?? null,
    funding: card.funding ?? null,
    brand: card.brand ?? null,
    last4: card.last4 ?? null,
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

  // Same race, one level out: two checkouts on the same network (different
  // accounts, different cards) both pass the checkout network check before
  // either completes. The owner's signup network is checked against other
  // workspaces' redemptions, exactly as `trialEligibility` does (SHO-440).
  const ownerNetwork = await prisma.signupRiskAssessment.findUnique({
    where: { userId },
    select: { ipPrefix: true, deviceId: true },
  })
  if (await networkTrialUsed({ userId, networks: [ownerNetwork] })) {
    return blockTrial(params, userId, TRIAL_STATUS.blockedDuplicateNetwork, null)
  }

  const card = await readSubscriptionCard(params.stripe, params.subscriptionId)
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
    | typeof TRIAL_STATUS.blockedDuplicateNetwork
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
 * `blocked_duplicate_user`, `blocked_duplicate_network`, `blocked_prepaid_card`,
 * `blocked_seat_limit`), or null. `recordTrialStart` returns only `'blocked'`;
 * the webhook reads this to tell the owner *why*.
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
