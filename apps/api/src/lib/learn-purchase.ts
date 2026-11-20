// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Standalone learn course purchases: a one-time Stripe Checkout that unlocks
 * one course for life (see `standalone` in `config/learn-catalog.ts`).
 *
 *  - `buildLearnCheckoutParams`  the Checkout session, as a pure function.
 *  - `recordLearnPurchase`       `checkout.session.completed` → an active
 *                                `CourseEnrollment` (`learn:<course>`), keyed by
 *                                the session id so a redelivery is a no-op.
 *  - `handleLearnRefund`         a full refund of that payment closes the
 *                                enrollment again.
 */
import type Stripe from 'stripe'
import { LEARN_COURSES, learnPurchaseCourseId, type LearnStandaloneOffer } from '../config/learn-catalog'

/** `metadata.offer` on a learn course checkout. */
export const LEARN_COURSE_OFFER = 'learn_course'

export function learnStandaloneOffer(courseId: string): LearnStandaloneOffer | null {
  const course = LEARN_COURSES.find((c) => c.id === courseId)
  return course?.access.kind === 'plan' && course.access.standalone ? course.access.standalone : null
}

export function buildLearnCheckoutParams(input: {
  offer: LearnStandaloneOffer
  priceId: string
  userId: string
  workspaceId: string
  userEmail?: string | null
  successUrl: string
  cancelUrl: string
}): Stripe.Checkout.SessionCreateParams {
  const metadata = {
    offer: LEARN_COURSE_OFFER,
    learnCourseId: input.offer.courseId,
    userId: input.userId,
    workspaceId: input.workspaceId,
  }
  return {
    mode: 'payment',
    line_items: [{ price: input.priceId, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    ...(input.userEmail ? { customer_email: input.userEmail } : {}),
    customer_creation: 'always',
    payment_method_types: ['card'],
    payment_method_options: { card: { request_three_d_secure: 'any' } },
    metadata,
    payment_intent_data: { metadata: { ...metadata } },
    custom_text: {
      submit: { message: `One-time payment for lifetime access to "${input.offer.title}" on learn.shogo.ai.` },
    },
  }
}

export interface LearnPurchaseDb {
  courseEnrollment: {
    findUnique(args: { where: { stripeCheckoutSessionId: string } }): Promise<{ id: string } | null>
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>
  }
}

export type RecordLearnPurchaseResult =
  | { recorded: true; enrollmentId: string; courseId: string }
  | { recorded: false; reason: 'not_learn' | 'unpaid' | 'unknown_course' | 'missing_metadata' | 'duplicate' }

export async function recordLearnPurchase(
  db: LearnPurchaseDb,
  session: Pick<Stripe.Checkout.Session, 'id' | 'metadata' | 'payment_status'>,
  now: Date = new Date(),
): Promise<RecordLearnPurchaseResult> {
  const meta = session.metadata ?? {}
  if (meta.offer !== LEARN_COURSE_OFFER) return { recorded: false, reason: 'not_learn' }
  if (session.payment_status !== 'paid') return { recorded: false, reason: 'unpaid' }
  const offer = learnStandaloneOffer(meta.learnCourseId ?? '')
  if (!offer) return { recorded: false, reason: 'unknown_course' }
  if (!meta.userId || !meta.workspaceId) return { recorded: false, reason: 'missing_metadata' }
  if (await db.courseEnrollment.findUnique({ where: { stripeCheckoutSessionId: session.id } })) {
    return { recorded: false, reason: 'duplicate' }
  }
  const courseId = learnPurchaseCourseId(offer.courseId)
  const row = await db.courseEnrollment.create({
    data: {
      courseId,
      userId: meta.userId,
      workspaceId: meta.workspaceId,
      source: 'stripe',
      stripeCheckoutSessionId: session.id,
      status: 'active',
      purchasedAt: now,
      // Nothing to install: the purchase only unlocks lessons on learn.shogo.ai.
      installStatus: 'installed',
    },
  })
  return { recorded: true, enrollmentId: row.id, courseId }
}

/**
 * A full refund of a learn course payment closes its enrollment. Partial
 * refunds leave access in place. Charges that are not learn purchases are
 * ignored, and a redelivery changes nothing.
 */
export async function handleLearnRefund(params: {
  db: LearnPurchaseDb
  stripe: Pick<Stripe, 'checkout'>
  charge: Pick<Stripe.Charge, 'amount' | 'amount_refunded' | 'payment_intent' | 'metadata'> & { refunded?: boolean }
}): Promise<{ closed: number }> {
  const { charge } = params
  const full = charge.refunded === true || (charge.amount > 0 && charge.amount_refunded >= charge.amount)
  if (!full) return { closed: 0 }
  const paymentIntent = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id
  if (!paymentIntent) return { closed: 0 }
  // When the charge carries another offer's metadata it is not ours; skip the lookup.
  if (charge.metadata?.offer && charge.metadata.offer !== LEARN_COURSE_OFFER) return { closed: 0 }
  const sessions = await params.stripe.checkout.sessions.list({ payment_intent: paymentIntent, limit: 5 })
  const ids = sessions.data.filter((s) => s.metadata?.offer === LEARN_COURSE_OFFER).map((s) => s.id)
  if (!ids.length) return { closed: 0 }
  const res = await params.db.courseEnrollment.updateMany({
    where: { stripeCheckoutSessionId: { in: ids }, status: 'active' },
    data: { status: 'refunded' },
  })
  return { closed: res.count }
}
