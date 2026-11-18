// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Activation: the funnel step paid acquisition optimizes for.
 *
 * A signup is "activated" the first time they either open a preview of
 * something they built (`firstPreviewSeenAt`, SHO-258 §7) or send their
 * {@link ACTIVATION_MESSAGE_THRESHOLD}rd chat message. Stamped once on
 * `users.activatedAt` and reported to Meta as the custom `Activated` event, with
 * the browser ids kept on `signup_attributions` at signup, because the turn that
 * activates someone has no Pixel attached.
 *
 * Every function here is best-effort and never throws: a metrics write must not
 * fail or slow a chat turn.
 */
import { prisma } from './prisma'
import { sendMetaEvent } from './meta-capi'

export const ACTIVATION_MESSAGE_THRESHOLD = 3

export type ActivationReason = 'messages' | 'preview'

export function activationEventId(userId: string): string {
  return `activated_${userId}`
}

/**
 * Count a sent chat message toward activation. Only users not yet activated
 * are touched, so once someone is activated this is a single no-op UPDATE.
 */
export async function recordActivationMessage(userId: string | null | undefined): Promise<boolean> {
  if (!userId || userId === 'system') return false
  try {
    const bumped = await prisma.user.updateMany({
      where: { id: userId, activatedAt: null },
      data: { activationMessages: { increment: 1 } },
    })
    if (bumped.count === 0) return false
    const row = await prisma.user.findUnique({
      where: { id: userId },
      select: { activationMessages: true },
    })
    if (!row || row.activationMessages < ACTIVATION_MESSAGE_THRESHOLD) return false
    return await markActivated(userId, 'messages')
  } catch (error: any) {
    console.warn('[activation] message count failed:', error?.message ?? error)
    return false
  }
}

/**
 * Stamp `activatedAt` once and report it. Returns true only for the call that
 * actually activated the user, so the Meta event is sent exactly once even when
 * two turns race.
 */
export async function markActivated(userId: string, reason: ActivationReason): Promise<boolean> {
  if (!userId || userId === 'system') return false
  try {
    const res = await prisma.user.updateMany({
      where: { id: userId, activatedAt: null },
      data: { activatedAt: new Date() },
    })
    if (res.count === 0) return false
    void reportActivated(userId, reason)
    return true
  } catch (error: any) {
    console.warn('[activation] activatedAt write failed:', error?.message ?? error)
    return false
  }
}

async function reportActivated(userId: string, reason: ActivationReason): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, createdAt: true },
    })
    const attribution = await prisma.signupAttribution.findUnique({
      where: { userId },
      select: { fbp: true, fbc: true, clientIp: true, userAgent: true, funnel: true, utmContent: true },
    })
    const hoursSinceSignup = user?.createdAt
      ? Math.round((Date.now() - user.createdAt.getTime()) / 36e5)
      : undefined
    await sendMetaEvent({
      name: 'Activated',
      eventId: activationEventId(userId),
      user: {
        email: user?.email,
        externalId: userId,
        fbp: attribution?.fbp,
        fbc: attribution?.fbc,
        clientIp: attribution?.clientIp,
        userAgent: attribution?.userAgent,
      },
      sourceUrl: 'https://studio.shogo.ai/',
      customData: {
        reason,
        ...(hoursSinceSignup != null ? { hours_since_signup: hoursSinceSignup } : {}),
        ...(attribution?.funnel ? { funnel: attribution.funnel } : {}),
        ...(attribution?.utmContent ? { utm_content: attribution.utmContent } : {}),
      },
    })
  } catch (error: any) {
    console.warn('[activation] Activated report failed:', error?.message ?? error)
  }
}

/**
 * First real payment on a Stripe customer (SHO-409 `firstPaidAt` just flipped).
 * Reported to Meta as `Subscribe` + `Purchase`, attributed to the workspace's
 * billing admin (else its owner), whose signup kept the browser ids. Event ids
 * are derived from the invoice so a webhook retry is deduped by Meta.
 */
export async function reportFirstPayment(input: {
  stripeCustomerId: string
  invoiceId: string
  amountPaidCents: number
  currency?: string | null
}): Promise<void> {
  try {
    const sub = await prisma.subscription.findFirst({
      where: { stripeCustomerId: input.stripeCustomerId },
      orderBy: { createdAt: 'desc' },
      select: { workspaceId: true, planId: true },
    })
    if (!sub) return
    const members = await prisma.member.findMany({
      where: { workspaceId: sub.workspaceId, OR: [{ isBillingAdmin: true }, { role: 'owner' }] },
      orderBy: { createdAt: 'asc' },
      select: { userId: true, isBillingAdmin: true },
    })
    const payer = members.find((m) => m.isBillingAdmin) ?? members[0]
    if (!payer) return
    const [user, attribution] = await Promise.all([
      prisma.user.findUnique({ where: { id: payer.userId }, select: { email: true } }),
      prisma.signupAttribution.findUnique({
        where: { userId: payer.userId },
        select: { fbp: true, fbc: true, clientIp: true, userAgent: true, funnel: true, utmContent: true },
      }),
    ])
    const value = Math.round(input.amountPaidCents) / 100
    const currency = (input.currency || 'usd').toUpperCase()
    const userData = {
      email: user?.email,
      externalId: payer.userId,
      fbp: attribution?.fbp,
      fbc: attribution?.fbc,
      clientIp: attribution?.clientIp,
      userAgent: attribution?.userAgent,
    }
    const customData = {
      value,
      currency,
      content_name: sub.planId,
      ...(attribution?.funnel ? { funnel: attribution.funnel } : {}),
      ...(attribution?.utmContent ? { utm_content: attribution.utmContent } : {}),
    }
    const { sendMetaEvents } = await import('./meta-capi')
    await sendMetaEvents([
      { name: 'Subscribe', eventId: `subscribe_${input.invoiceId}`, user: userData, sourceUrl: 'https://studio.shogo.ai/billing', customData: { ...customData, predicted_ltv: value * 12 } },
      { name: 'Purchase', eventId: `purchase_${input.invoiceId}`, user: userData, sourceUrl: 'https://studio.shogo.ai/billing', customData },
    ])
  } catch (error: any) {
    console.warn('[activation] first-payment report failed:', error?.message ?? error)
  }
}
