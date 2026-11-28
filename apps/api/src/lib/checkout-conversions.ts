// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The conversions a paid checkout produces (SHO-611).
 *
 * Split out of the Stripe webhook as a pure function so the mapping can be
 * tested against a fixture session without a webhook, a server or a network
 * call: given the session and the buyer's attribution row, which events go
 * where.
 *
 * Ids are the ones the browser already used (`Purchase` = the checkout session
 * id, `Subscribe` = the session id + `_sub`), so a Stripe redelivery and the
 * pixel event both dedupe to one conversion in Meta.
 */
import { purchaseEventId, subscribeEventId, META_FBC_COOKIE, META_FBP_COOKIE } from '../../../../packages/shared-app/src/lib/conversion-events'
import type { CometlyEventInput } from './cometly'
import { buildMetaEvent, type MetaServerEvent } from './meta-capi'
import { parseCookieHeader } from './signup-attribution'

/** The parts of `Stripe.Checkout.Session` this mapping reads. */
export interface CheckoutSessionLike {
  id: string
  mode?: string | null
  amount_total?: number | null
  currency?: string | null
  /** Unix seconds, Stripe's own timestamp for the session. */
  created?: number | null
  customer_details?: { email?: string | null } | null
  metadata?: Record<string, string | null | undefined> | null
}

/** What the buyer's `signup_attributions` row (and the session metadata) can tell us. */
export interface CheckoutAttribution {
  userId?: string | null
  fbclid?: string | null
  fbc?: string | null
  fbp?: string | null
}

export interface CheckoutConversionEvents {
  meta: MetaServerEvent[]
  cometly: CometlyEventInput | null
}

/**
 * Meta's browser cookies, lifted out of a request's `Cookie:` header so the
 * create-checkout route can put them on the session. The webhook then has them
 * without a browser. Empty when the visitor blocked the pixel, which is fine —
 * Meta matches on the hashed email and external id too.
 */
export function metaBrowserCookies(
  cookieHeader: string | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  const fbp = parseCookieHeader(cookieHeader ?? '', META_FBP_COOKIE)
  const fbc = parseCookieHeader(cookieHeader ?? '', META_FBC_COOKIE)
  if (fbp) out.fbp = fbp
  if (fbc) out.fbc = fbc
  return out
}

/**
 * A checkout the app counts as a conversion: a subscription purchase, not an
 * instance/capacity add-on, and not a $0 session (a free trial's card
 * setup has charged nothing, so there is no purchase to report).
 */
export function isPaidSubscriptionCheckout(session: CheckoutSessionLike): boolean {
  if (session.mode && session.mode !== 'subscription') return false
  const checkoutType = session.metadata?.checkoutType
  if (checkoutType === 'instance' || checkoutType === 'capacity') return false
  const total = session.amount_total
  return typeof total === 'number' && Number.isFinite(total) && total > 0
}

export function buildCheckoutConversionEvents(
  session: CheckoutSessionLike,
  attribution: CheckoutAttribution | null,
  now: number = Date.now(),
): CheckoutConversionEvents {
  if (!isPaidSubscriptionCheckout(session)) return { meta: [], cometly: null }

  const metadata = session.metadata ?? {}
  const amount = session.amount_total as number
  const value = amount / 100
  const currency = (session.currency ?? 'usd').toUpperCase()
  const planId = metadata.planId ?? undefined
  const email = session.customer_details?.email ?? null
  const externalId = attribution?.userId ?? metadata.userId ?? null
  const eventTime = session.created ? session.created * 1000 : now
  const fbc = metadata.fbc ?? attribution?.fbc ?? null
  const fbp = metadata.fbp ?? attribution?.fbp ?? null
  const fbclid = attribution?.fbclid ?? null

  const customData: Record<string, unknown> = {
    value,
    currency,
    ...(planId ? { content_ids: [planId], content_name: planId } : {}),
    content_type: 'product',
    num_items: 1,
  }

  const base = { email, externalId, fbc, fbp, fbclid, eventTime, customData }
  const meta = [
    buildMetaEvent({ ...base, eventName: 'Purchase', eventId: purchaseEventId(session.id) }, now),
    buildMetaEvent({
      ...base,
      eventName: 'Subscribe',
      eventId: subscribeEventId(session.id),
      customData: { ...customData, predicted_ltv: value * 12 },
    }, now),
  ]

  // Cometly keys its events on the email; without one there is nothing to send.
  const cometly: CometlyEventInput | null = email
    ? {
        eventName: 'purchase',
        email,
        idempotencyKey: session.id,
        cometToken: metadata.comet_token ?? null,
        eventTime: new Date(eventTime).toISOString(),
      }
    : null

  return { meta, cometly }
}
