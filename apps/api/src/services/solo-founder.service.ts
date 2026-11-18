// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The $99 Solo Founder offer (SHO-428).
 *
 * Year 1 is Business **annual** (qty 1) plus a $21 course line, less a $78
 * once-only first-year discount: $99 today, renewing at $156. Nothing in this
 * module decides a price — the checkout route reads the Stripe objects and the
 * webhook writes the enrollment; this module owns the *product* side:
 *
 *  - who may buy (eligibility), and what the promo field accepts,
 *  - `enroll()`, which writes the enrollment, applies the default $50/mo
 *    overage cap and installs the course pack (Solo Founder OS + #course),
 *  - the install itself, idempotent through the stored `packBindings`,
 *  - the coaching state the Course board and Coach read.
 *
 * It has no Stripe dependency beyond the promo lookup, so desktop and cloud
 * install the course the same way: local mode simply has no Stripe caller.
 */

import type Stripe from 'stripe'
import { prisma } from '../lib/prisma'
import { parseSystemManifest } from '@shogo/agent-runtime/src/system-manifest'
import { soloFounderCourseManifest } from '@shogo/agent-runtime/src/work-templates'
import { SOLO_FOUNDER_OVERAGE_CAP_USD } from '../config/usage-plans'
import {
  COURSE_LESSONS,
  SOLO_FOUNDER_COURSE_BOARD_TEMPLATE,
  SOLO_FOUNDER_COURSE_CHANNEL,
  SOLO_FOUNDER_COURSE_ID,
  encodeLessonCheck,
} from '../config/solo-founder-course'
import { lookupPriceIdByLookupKey } from './stripe-price-lookup.service'
import { applySystemPack, type PackBindings } from './system-apply.service'
import { createWorkItem, resolveBoard } from './work-boards.service'
import * as billingService from './billing.service'

/** `metadata.offer` value that marks a checkout, subscription and coupon as this offer. */
export const SOLO_FOUNDER_OFFER = 'solo_founder'

/** Stripe lookup key of the one-time course price ($21). */
export const SOLO_FOUNDER_COURSE_LOOKUP_KEY = 'solo_founder_course_v1'

/** Coupon that takes $78 off year one, once. */
export const SOLO_FOUNDER_COUPON_ID = 'solo-founder-first-year'

/** What the first invoice comes to, for copy and tests: 156 + 21 − 78. */
export const SOLO_FOUNDER_FIRST_YEAR_USD = 99

/** What the subscription renews at. */
export const SOLO_FOUNDER_RENEWAL_USD = 156

/** Which workspace-visible copies of the offer's numbers the UI shows. */
export const SOLO_FOUNDER_PRICING = {
  businessAnnualUsd: SOLO_FOUNDER_RENEWAL_USD,
  courseUsd: 21,
  firstYearDiscountUsd: 78,
  firstYearUsd: SOLO_FOUNDER_FIRST_YEAR_USD,
  renewalUsd: SOLO_FOUNDER_RENEWAL_USD,
  overageCapUsd: SOLO_FOUNDER_OVERAGE_CAP_USD,
} as const

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export type SoloFounderIneligibleReason =
  | 'existing_subscription'
  | 'already_enrolled'
  | 'risk_review'
  | 'not_signed_in'

export type SoloFounderEligibility =
  | { eligible: true }
  | { eligible: false; code: 'offer_not_eligible' | 'already_enrolled' | 'risk_review'; reason: SoloFounderIneligibleReason }

/** HTTP status for each ineligible reason. */
export const SOLO_FOUNDER_ERROR_STATUS: Record<SoloFounderIneligibleReason, number> = {
  existing_subscription: 409,
  already_enrolled: 409,
  risk_review: 403,
  not_signed_in: 401,
}

/**
 * Who may buy the offer.
 *
 * The workspace must have no subscription in a live state: the offer upgrades a
 * *Free* workspace in place (`/api/billing/checkout` already targets one). A
 * user who already owns a CourseEnrollment is refused so a second purchase
 * cannot create a second course; high-risk signups are refused the same way
 * trials are (`signupRiskAssessment.band === 'high'`).
 */
export async function checkEligibility(params: {
  userId?: string | null
  workspaceId: string
}): Promise<SoloFounderEligibility> {
  const { userId, workspaceId } = params
  if (!userId) {
    return { eligible: false, code: 'offer_not_eligible', reason: 'not_signed_in' }
  }
  const subscription = await prisma.subscription.findFirst({
    where: { workspaceId, status: { in: ['active', 'trialing', 'past_due'] } },
    select: { id: true },
  })
  if (subscription) {
    return { eligible: false, code: 'offer_not_eligible', reason: 'existing_subscription' }
  }
  const enrollment = await prisma.courseEnrollment.findFirst({
    where: { userId, courseId: SOLO_FOUNDER_COURSE_ID, status: 'active' },
    select: { id: true },
  })
  if (enrollment) {
    return { eligible: false, code: 'already_enrolled', reason: 'already_enrolled' }
  }
  const risk = await prisma.signupRiskAssessment.findUnique({
    where: { userId },
    select: { band: true },
  })
  if (risk?.band === 'high') {
    return { eligible: false, code: 'risk_review', reason: 'risk_review' }
  }
  return { eligible: true }
}

/** Plain-language message per ineligible reason, shown by the checkout route. */
export function eligibilityMessage(reason: SoloFounderIneligibleReason): string {
  switch (reason) {
    case 'existing_subscription':
      return 'This workspace already has a paid subscription. The Solo Founder offer is for a Free workspace — cancel first, or use another workspace.'
    case 'already_enrolled':
      return 'You already own the Solo Founder course. Open #course to keep going.'
    case 'risk_review':
      return 'This purchase needs a review before it can go through. Contact support and we will sort it out.'
    case 'not_signed_in':
      return 'Sign in first, then buy the Solo Founder offer.'
  }
}

/**
 * The disclosure under Checkout's pay button. Stripe prints the actual invoice,
 * so this only has to be honest about what happens next.
 */
export function renewalDisclosure(from: Date): string {
  const renewsOn = new Date(Date.UTC(from.getUTCFullYear() + 1, from.getUTCMonth(), from.getUTCDate()))
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  return [
    `Renews at $${SOLO_FOUNDER_RENEWAL_USD}/yr on ${renewsOn}.`,
    'Includes $20/mo of AI.',
    `Usage beyond that is billed at cost +20%, capped at $${SOLO_FOUNDER_OVERAGE_CAP_USD}/mo by default (change it in Billing).`,
  ].join(' ')
}

/** The one-time course price (`solo_founder_course_v1`), or null when unprovisioned. */
export async function resolveCoursePriceId(stripe: Parameters<typeof lookupPriceIdByLookupKey>[0]): Promise<string | null> {
  return lookupPriceIdByLookupKey(stripe, SOLO_FOUNDER_COURSE_LOOKUP_KEY)
}

/**
 * The first-year coupon, or null when it is not in this Stripe account (test
 * vs live). The coupon's id is fixed so the creation script is idempotent.
 */
export async function resolveFirstYearCouponId(
  stripe: Pick<Stripe, 'coupons'>,
): Promise<string | null> {
  try {
    const coupon = await stripe.coupons.retrieve(SOLO_FOUNDER_COUPON_ID)
    return coupon?.valid === false ? null : (coupon?.id ?? null)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Promo codes
// ---------------------------------------------------------------------------

export interface OfferPromotionCode {
  /** `promo_…` id to pass as `discounts[0].promotion_code`. */
  promotionCodeId: string
  /** The coupon behind it; its amount already includes the −$78. */
  couponId: string
}

export class InvalidPromoCodeError extends Error {
  constructor(message = 'That promo code is not valid for this offer.') {
    super(message)
    this.name = 'InvalidPromoCodeError'
  }
}

/**
 * Our own promo field.
 *
 * Stripe Checkout rejects `allow_promotion_codes` together with `discounts` and
 * accepts only one discount, so the checkout route cannot hand both the
 * first-year coupon and a code to Stripe. The code is resolved here instead:
 * it is accepted only when its coupon carries `metadata.offer =
 * 'solo_founder'`, which is how an offer code (already including the −$78) is
 * told apart from every other promotion in the account.
 */
export async function resolveOfferPromotionCode(
  stripe: Pick<Stripe, 'promotionCodes' | 'coupons'>,
  code: string,
): Promise<OfferPromotionCode> {
  const trimmed = code.trim()
  if (!trimmed) throw new InvalidPromoCodeError()
  const list = await stripe.promotionCodes.list({
    code: trimmed,
    active: true,
    limit: 1,
    expand: ['data.promotion.coupon'],
  })
  const promotion = list.data?.[0]
  if (!promotion) throw new InvalidPromoCodeError()
  // `promotion.coupon` can arrive as an id or as an expanded object; both are
  // accepted, and its `metadata.offer` is what marks it as ours.
  const linked = promotion.promotion?.coupon
  const coupon = typeof linked === 'string' ? await stripe.coupons.retrieve(linked) : linked
  if (!coupon?.id || coupon.metadata?.offer !== SOLO_FOUNDER_OFFER) throw new InvalidPromoCodeError()
  return { promotionCodeId: promotion.id, couponId: coupon.id }
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

export interface EnrollInput {
  workspaceId: string
  userId: string
  source: 'stripe' | 'license_key' | 'admin'
  stripeCheckoutSessionId?: string | null
  stripeSubscriptionId?: string | null
  purchasedAt?: Date
  /**
   * `false` (the webhook's choice) writes the row and returns, then installs in
   * the background — creating projects must not hold the webhook's 200. Tests
   * and the local/license paths await the install so they can assert on it.
   */
  awaitInstall?: boolean
}

export interface EnrollResult {
  enrollmentId: string
  created: boolean
  installStatus: string
}

/**
 * Upsert the enrollment and start the install. Idempotent: Stripe redelivers,
 * and `checkout.session.completed` + `customer.subscription.created` can both
 * arrive at once, so the row is keyed on (`userId`, `courseId`) and the
 * install updates through the stored bindings instead of duplicating.
 */
export async function enroll(input: EnrollInput): Promise<EnrollResult> {
  const purchasedAt = input.purchasedAt ?? new Date()
  const existing = await prisma.courseEnrollment.findFirst({
    where: {
      OR: [
        ...(input.stripeCheckoutSessionId
          ? [{ stripeCheckoutSessionId: input.stripeCheckoutSessionId }]
          : []),
        { userId: input.userId, courseId: SOLO_FOUNDER_COURSE_ID },
      ],
    },
    select: { id: true, installStatus: true },
  })

  let enrollmentId: string
  let created = false
  if (existing) {
    enrollmentId = existing.id
    await prisma.courseEnrollment.update({
      where: { id: existing.id },
      data: {
        workspaceId: input.workspaceId,
        source: input.source,
        ...(input.stripeCheckoutSessionId ? { stripeCheckoutSessionId: input.stripeCheckoutSessionId } : {}),
        ...(input.stripeSubscriptionId ? { stripeSubscriptionId: input.stripeSubscriptionId } : {}),
        status: 'active',
      },
    })
  } else {
    const row = await prisma.courseEnrollment.create({
      data: {
        courseId: SOLO_FOUNDER_COURSE_ID,
        userId: input.userId,
        workspaceId: input.workspaceId,
        source: input.source,
        stripeCheckoutSessionId: input.stripeCheckoutSessionId ?? null,
        stripeSubscriptionId: input.stripeSubscriptionId ?? null,
        status: 'active',
        purchasedAt,
        installStatus: 'pending',
      },
      select: { id: true },
    })
    enrollmentId = row.id
    created = true
  }

  await applyDefaultOverageCap(input.workspaceId).catch((err: any) =>
    console.error('[SoloFounder] could not apply the default overage cap:', err?.message ?? err),
  )

  if (input.awaitInstall) {
    const result = await installEnrollment(enrollmentId)
    return { enrollmentId, created, installStatus: result.installStatus }
  }
  void installEnrollment(enrollmentId).catch((err: any) =>
    console.error('[SoloFounder] install failed for enrollment', enrollmentId, err?.message ?? err),
  )
  return { enrollmentId, created, installStatus: created ? 'pending' : (existing?.installStatus ?? 'pending') }
}

/**
 * Default $50/mo overage cap — only when the wallet has no cap of its own, so a
 * limit the person chose is never overwritten. (The monthly reset clears only
 * the grant-only $5 cap, so this one persists.)
 */
export async function applyDefaultOverageCap(workspaceId: string): Promise<boolean> {
  const wallet = await prisma.usageWallet.findUnique({
    where: { workspaceId },
    select: { overageHardLimitUsd: true },
  })
  if (wallet?.overageHardLimitUsd != null) return false
  await billingService.setUsageBasedPricing(workspaceId, {
    overageEnabled: true,
    overageHardLimitUsd: SOLO_FOUNDER_OVERAGE_CAP_USD,
  })
  return true
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * The timezone the Coach's 09:00 nudge should land in: the workspace owner's
 * chat timezone when they have set one, else UTC (schedules default to UTC).
 */
async function ownerTimezone(workspaceId: string, fallbackUserId: string): Promise<string> {
  const owner = await prisma.member.findFirst({
    where: { workspaceId, projectId: null, role: 'owner' },
    select: { userId: true },
  })
  const userId = owner?.userId ?? fallbackUserId
  const settings = await prisma.chatUserSettings.findFirst({
    where: { workspaceId, userId },
    select: { timezone: true },
  })
  return settings?.timezone?.trim() || 'UTC'
}

export interface InstallResult {
  installStatus: 'installed' | 'failed'
  courseBoardId: string | null
  error: string | null
  created: string[]
}

/**
 * Install the course pack: the Solo Founder OS company, the hidden #course
 * department, the Coach's daily nudge, then the 12 lesson cards.
 *
 * Idempotent end to end. `applySystemPack` skips anything already bound (the
 * bindings are passed back in), and lesson cards are matched on their
 * `lessonId` field, so a retried or replayed install updates rather than
 * creating a second set of channels, boards, agents or cards.
 */
export async function installEnrollment(enrollmentId: string, opts: { defer?: boolean } = {}): Promise<InstallResult> {
  const enrollment = await prisma.courseEnrollment.findUnique({
    where: { id: enrollmentId },
    select: {
      id: true,
      workspaceId: true,
      userId: true,
      status: true,
      packBindings: true,
      courseBoardId: true,
      installStatus: true,
    },
  })
  if (!enrollment) return { installStatus: 'failed', courseBoardId: null, error: 'enrollment not found', created: [] }
  if (enrollment.status !== 'active') {
    return { installStatus: enrollment.installStatus as 'installed' | 'failed', courseBoardId: enrollment.courseBoardId, error: null, created: [] }
  }

  const bindings = (enrollment.packBindings ?? null) as PackBindings | null
  try {
    const manifest = soloFounderCourseManifest() as any
    const timezone = await ownerTimezone(enrollment.workspaceId, enrollment.userId)
    if (Array.isArray(manifest.schedules)) {
      manifest.schedules = manifest.schedules.map((s: any) => ({ ...s, timezone }))
    }
    const parsed = parseSystemManifest(manifest)
    if (!parsed.manifest) {
      throw new Error(`the course manifest did not parse: ${(parsed.errors ?? []).join('; ')}`)
    }
    const applied = await applySystemPack({
      workspaceId: enrollment.workspaceId,
      manifest: parsed.manifest,
      actorUserId: enrollment.userId,
      bindings: bindings ?? undefined,
    })
    if (!applied.ok) throw new Error(applied.errors.join('; ') || 'pack_apply_failed')

    const courseBoardId = await resolveCourseBoardId(enrollment.workspaceId, applied.bindings)
    const lessons = await ensureLessonCards(enrollment.workspaceId, courseBoardId, enrollment.userId)

    await prisma.courseEnrollment.update({
      where: { id: enrollment.id },
      data: {
        packBindings: applied.bindings as any,
        courseBoardId,
        installStatus: 'installed',
        installError: null,
      },
    })
    return {
      installStatus: 'installed',
      courseBoardId,
      error: null,
      created: [...applied.applied, ...lessons.created],
    }
  } catch (err: any) {
    const message = String(err?.message ?? err)
    console.error('[SoloFounder] install failed:', { enrollmentId, message })
    await prisma.courseEnrollment.update({
      where: { id: enrollment.id },
      data: { installStatus: 'failed', installError: message.slice(0, 2000) },
    })
    return { installStatus: 'failed', courseBoardId: enrollment.courseBoardId, error: message, created: [] }
  }
}

async function resolveCourseBoardId(workspaceId: string, bindings: PackBindings): Promise<string | null> {
  const bound = Object.entries(bindings.boards ?? {}).find(([key]) => key.endsWith('/Course'))?.[1]
  if (bound) return bound
  const board = await prisma.board.findFirst({
    where: { workspaceId, archivedAt: null, templateId: SOLO_FOUNDER_COURSE_BOARD_TEMPLATE },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })
  return board?.id ?? null
}

/**
 * Create the 12 lesson cards, once. Matched on `fields.lessonId`, so a
 * redelivered install (or a person who reordered the board) keeps its cards.
 * Module 0 lands in *This week*; everything else waits in *Up next*.
 */
export async function ensureLessonCards(
  workspaceId: string,
  courseBoardId: string | null,
  actorUserId: string,
): Promise<{ created: string[]; boardId: string | null }> {
  if (!courseBoardId) return { created: [], boardId: null }
  const board = await resolveBoard(workspaceId, courseBoardId)
  const existing = await prisma.workItem.findMany({
    where: { boardId: courseBoardId, archivedAt: null },
    select: { id: true, fields: true },
  })
  const have = new Set(
    existing
      .map((i) => (i.fields as Record<string, unknown> | null)?.lessonId)
      .filter((v): v is string => typeof v === 'string'),
  )
  const created: string[] = []
  for (const lesson of COURSE_LESSONS) {
    if (have.has(lesson.id)) continue
    const description = [lesson.description, '', `**Your prompt**`, '', '```', lesson.prompt, '```', '', `**This lesson is done when:** ${lesson.output}`].join('\n')
    await createWorkItem(
      board,
      {
        title: lesson.title,
        description,
        column: lesson.startsIn === 'this_week' ? 'This week' : 'Up next',
        fields: {
          lessonId: lesson.id,
          module: lesson.module,
          ...(lesson.videoUrl ? { videoUrl: lesson.videoUrl } : {}),
          output: lesson.output,
          check: encodeLessonCheck(lesson.check),
        },
        projectId: null,
      },
      { userId: actorUserId },
    )
    created.push(lesson.id)
  }
  return { created, boardId: courseBoardId }
}

// ---------------------------------------------------------------------------
// Read side (the offer panel)
// ---------------------------------------------------------------------------

export interface SoloFounderState {
  enrolled: boolean
  status: string | null
  installStatus: string | null
  installError: string | null
  courseBoardId: string | null
  courseChannelId: string | null
  /** How many lessons the course has, so the panel never hardcodes it. */
  totalLessons: number
  completedLessons: string[]
  completedAt: string | null
}

/** What the billing panel needs to show the offer, or "you're enrolled". */
export async function getOfferState(params: { userId?: string | null; workspaceId: string }): Promise<SoloFounderState> {
  const enrollment = params.userId
    ? await prisma.courseEnrollment.findFirst({
        where: { userId: params.userId, courseId: SOLO_FOUNDER_COURSE_ID },
        orderBy: { createdAt: 'desc' },
      })
    : await prisma.courseEnrollment.findFirst({
        where: { workspaceId: params.workspaceId, courseId: SOLO_FOUNDER_COURSE_ID },
        orderBy: { createdAt: 'desc' },
      })
  if (!enrollment) {
    return {
      enrolled: false,
      status: null,
      installStatus: null,
      installError: null,
      courseBoardId: null,
      courseChannelId: null,
      totalLessons: COURSE_LESSONS.length,
      completedLessons: [],
      completedAt: null,
    }
  }
  const channel = await prisma.conversation.findFirst({
    where: { workspaceId: enrollment.workspaceId, name: SOLO_FOUNDER_COURSE_CHANNEL },
    select: { id: true },
  })
  const progress = (enrollment.progress ?? {}) as { completedLessons?: string[] }
  return {
    enrolled: enrollment.status === 'active',
    status: enrollment.status,
    installStatus: enrollment.installStatus,
    installError: enrollment.installError,
    courseBoardId: enrollment.courseBoardId,
    courseChannelId: channel?.id ?? null,
    totalLessons: COURSE_LESSONS.length,
    completedLessons: Array.isArray(progress.completedLessons) ? progress.completedLessons : [],
    completedAt: enrollment.completedAt?.toISOString() ?? null,
  }
}

/**
 * Retry a `pending`/`failed` install. `verify-checkout` and the offer panel call
 * this so a lost background install recovers without a support ticket.
 */
export async function retryInstallIfNeeded(params: { userId: string; workspaceId: string }): Promise<SoloFounderState> {
  const enrollment = await prisma.courseEnrollment.findFirst({
    where: { userId: params.userId, courseId: SOLO_FOUNDER_COURSE_ID, status: 'active' },
    select: { id: true, installStatus: true },
  })
  if (enrollment && enrollment.installStatus !== 'installed') {
    await installEnrollment(enrollment.id)
  }
  return getOfferState(params)
}

/**
 * Refuse a prepaid card on the Solo Founder offer (SHO-428).
 *
 * The order matters: cancel the subscription first so no renewal can fire,
 * refund the first invoice in full (the $99 the buyer was charged a moment ago),
 * then record what happened. Callers skip `syncFromStripe` and the allocation, so
 * the workspace stays Free and nothing is installed.
 */
export async function rejectPrepaidPurchase(params: {
  stripe: Pick<Stripe, 'subscriptions' | 'invoices' | 'refunds'>
  workspaceId: string
  userId: string | null
  subscriptionId: string
  purchasedAt?: Date
}): Promise<{ refunded: boolean; refundId: string | null }> {
  const purchasedAt = params.purchasedAt ?? new Date()
  try {
    await params.stripe.subscriptions.cancel(params.subscriptionId)
  } catch (err: any) {
    console.error('[SoloFounder] could not cancel prepaid subscription:', err?.message ?? err)
  }

  const refund = await refundFirstInvoice(params.stripe, params.subscriptionId)

  const ownerUserId = params.userId
    ?? (await prisma.member.findFirst({
      where: { workspaceId: params.workspaceId, projectId: null, role: 'owner' },
      select: { userId: true },
    }))?.userId
    ?? null

  if (ownerUserId) {
    await prisma.courseEnrollment.upsert({
      where: { userId_courseId: { userId: ownerUserId, courseId: SOLO_FOUNDER_COURSE_ID } },
      create: {
        courseId: SOLO_FOUNDER_COURSE_ID,
        userId: ownerUserId,
        workspaceId: params.workspaceId,
        source: 'stripe',
        stripeSubscriptionId: params.subscriptionId,
        status: 'rejected_prepaid',
        purchasedAt,
        installStatus: 'failed',
        installError: 'prepaid_card',
      },
      update: {
        status: 'rejected_prepaid',
        stripeSubscriptionId: params.subscriptionId,
        installStatus: 'failed',
        installError: 'prepaid_card',
      },
    })
  } else {
    console.error('[SoloFounder] prepaid refusal with no owner to record:', params.workspaceId)
  }

  return { refunded: !!refund, refundId: refund?.id ?? null }
}

/**
 * Refund the newest invoice on a subscription in full. Stripe's invoice →
 * charge / payment-intent fields differ across API versions, so both are tried.
 */
async function refundFirstInvoice(
  stripe: Pick<Stripe, 'invoices' | 'refunds'>,
  subscriptionId: string,
): Promise<{ id: string } | null> {
  try {
    const invoices = await stripe.invoices.list({ subscription: subscriptionId, limit: 1 })
    const invoice = invoices.data?.[0] as (Stripe.Invoice & { charge?: string | null }) | undefined
    if (!invoice) return null
    const charge = (invoice as any).charge as string | null | undefined
    const paymentIntent = (invoice as any).payment_intent as string | null | undefined
    if (charge) {
      const refund = await stripe.refunds.create({ charge })
      return { id: refund.id }
    }
    if (paymentIntent) {
      const refund = await stripe.refunds.create({ payment_intent: paymentIntent })
      return { id: refund.id }
    }
    console.warn('[SoloFounder] invoice to refund has no charge or payment intent:', invoice.id)
    return null
  } catch (err: any) {
    console.error('[SoloFounder] refund of the prepaid charge failed:', err?.message ?? err)
    return null
  }
}

/** Mark an enrollment refunded (a card dispute, or a manual refund by support). */
export async function markEnrollmentRefunded(params: { stripeSubscriptionId: string }): Promise<number> {
  const result = await prisma.courseEnrollment.updateMany({
    where: { stripeSubscriptionId: params.stripeSubscriptionId, status: 'active' },
    data: { status: 'refunded' },
  })
  return result.count
}
