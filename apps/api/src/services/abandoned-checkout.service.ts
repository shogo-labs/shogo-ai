// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Abandoned-checkout recovery (SHO-615, growth plan §0 G9a).
 *
 * A Stripe `checkout.session.expired` means someone opened Checkout, started
 * filling it in, and never paid. Before this, that dropped silently — nothing
 * followed up. This turns an expired *subscription* session into one recovery
 * email carrying Stripe's own resume link (`after_expiration.recovery.url`,
 * valid 30 days) so the person lands back on a working session.
 *
 * Exactly-once, per user per plan, ever: the lifecycle ledger
 * (`lib/lifecycle-email.ts`) claims `abandoned_checkout:<userId>:<planId>` and a
 * duplicate (a webhook retry, a second expired session for the same plan) is a
 * no-op. The caller in server.ts wraps this in try/catch, so a failed send never
 * 500s the webhook and Stripe does not retry forever.
 *
 * It is a service rather than inline in the webhook so the decision is testable
 * without booting the whole API (see abandoned-checkout.service.test.ts).
 */
import type Stripe from 'stripe'
import { prisma } from '../lib/prisma'
import { getFrontendUrl } from '../lib/cloud-urls'
import {
  lifecycleEmailAllowed,
  claimLifecycleEmail,
  releaseLifecycleEmail,
  unsubscribeUrl,
} from '../lib/lifecycle-email'
import { sendAbandonedCheckoutEmail } from './email.service'

export interface AbandonedCheckoutResult {
  sent: boolean
  /** Why nothing was sent — for the webhook log and tests. */
  reason?:
    | 'not_subscription'
    | 'no_user'
    | 'already_subscribed'
    | 'not_allowed'
    | 'already_sent'
    | 'send_failed'
}

function displayPlan(planId: string | undefined | null): string {
  if (!planId) return 'Shogo'
  return planId.charAt(0).toUpperCase() + planId.slice(1)
}

/**
 * Handle a `checkout.session.expired` event. Returns what it did; never throws
 * for an ordinary "not applicable" case.
 */
export async function handleCheckoutSessionExpired(
  session: Stripe.Checkout.Session,
): Promise<AbandonedCheckoutResult> {
  // Paid add-on / capacity checkouts can expire too — out of scope here.
  if (session.mode !== 'subscription') return { sent: false, reason: 'not_subscription' }

  const metadata = session.metadata ?? {}
  const workspaceId = metadata.workspaceId || null
  const planId = metadata.planId || null

  // Resolve the person: the session metadata we set at checkout, else the email
  // Stripe collected (which is what an older session, before `userId` was in
  // metadata, would carry).
  let userId = metadata.userId || null
  if (!userId) {
    const email = session.customer_details?.email || session.customer_email || null
    if (email) {
      const byEmail = await prisma.user.findUnique({ where: { email }, select: { id: true } })
      userId = byEmail?.id ?? null
    }
  }
  if (!userId) return { sent: false, reason: 'no_user' }

  // They finished in another session/tab: that workspace is subscribed, so no
  // recovery needed.
  if (workspaceId) {
    const existing = await prisma.subscription.findFirst({
      where: { workspaceId, status: { in: ['active', 'trialing', 'past_due'] } },
      select: { id: true },
    })
    if (existing) return { sent: false, reason: 'already_subscribed' }
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, lifecycleEmailOptOutAt: true },
  })
  if (!user?.email || !lifecycleEmailAllowed(user)) return { sent: false, reason: 'not_allowed' }

  const ledgerId = await claimLifecycleEmail('abandoned_checkout', userId, planId ?? 'unknown')
  if (!ledgerId) return { sent: false, reason: 'already_sent' }

  const recoveryUrl = session.after_expiration?.recovery?.url
  const resumeUrl = recoveryUrl
    || `${getFrontendUrl()}/billing${workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : ''}`
  const intervalLabel = metadata.billingInterval === 'annual' ? 'annual' : 'monthly'
  const offerNoun = metadata.trial === 'true' ? '7-day trial' : 'upgrade'

  try {
    const result = await sendAbandonedCheckoutEmail({
      to: user.email,
      planName: displayPlan(planId),
      intervalLabel,
      offerNoun,
      resumeUrl,
      unsubscribeUrl: unsubscribeUrl(userId),
    })
    if (!result.success) {
      // The send did not go out — release the claim so a later attempt can retry.
      await releaseLifecycleEmail(ledgerId)
      return { sent: false, reason: 'send_failed' }
    }
    return { sent: true }
  } catch (err) {
    await releaseLifecycleEmail(ledgerId)
    throw err
  }
}
