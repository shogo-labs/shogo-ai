// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Storefront backend routes. Mounted under `/api/` by the generated
// `server.tsx` (do NOT edit server.tsx). This file is never regenerated, so
// your edits are safe.
//
// Payments use STRIPE HOSTED CHECKOUT (a redirect), not Stripe Elements — the
// "Elements context" / network errors come from the Elements path, so we avoid
// it entirely. No npm install: we call Stripe's REST API directly.
//
// To switch payments ON: put the store owner's OWN Stripe secret key in the
// project environment as STRIPE_SECRET_KEY (sk_test_… to trial, sk_live_… for
// real charges). Until it's set, /api/checkout returns 501 and the storefront
// shows "payments not switched on yet" — the catalog and cart still work.
//
// See the `stripe-checkout` skill for the webhook setup and a verify checklist.

import { Hono } from 'hono'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { prisma } from './src/lib/db'
import { storeContent } from './src/data/store-content'

const app = new Hono()

interface CheckoutBody {
  items?: Array<{ id?: string; quantity?: number }>
}

app.post('/checkout', async (c) => {
  const secret = process.env.STRIPE_SECRET_KEY
  if (!secret) {
    return c.json(
      { error: { code: 'stripe_not_configured', message: 'Payments are not set up yet.' } },
      501,
    )
  }

  const body = (await c.req.json().catch(() => ({}))) as CheckoutBody
  const requested = Array.isArray(body.items) ? body.items : []
  if (requested.length === 0) {
    return c.json({ error: { code: 'empty_cart', message: 'Your cart is empty.' } }, 400)
  }

  // Authoritative prices come from the catalog, NOT the client — a tampered
  // client price can never change what Stripe charges.
  const currency = (storeContent.store.currency || 'usd').toLowerCase()
  const lines = requested
    .map((r) => {
      const product = storeContent.products.find((p) => p.id === r.id)
      if (!product || product.available === false) return null
      const quantity = Math.max(1, Math.min(99, Math.floor(Number(r.quantity) || 1)))
      return { product, quantity }
    })
    .filter(
      (x): x is { product: (typeof storeContent.products)[number]; quantity: number } => !!x,
    )

  if (lines.length === 0) {
    return c.json({ error: { code: 'no_valid_items', message: 'No purchasable items in cart.' } }, 400)
  }

  const origin = c.req.header('origin') ?? new URL(c.req.url).origin

  const form = new URLSearchParams()
  form.set('mode', 'payment')
  form.set('success_url', `${origin}/?checkout=success`)
  form.set('cancel_url', `${origin}/?checkout=cancelled`)
  lines.forEach((line, i) => {
    form.set(`line_items[${i}][price_data][currency]`, currency)
    form.set(`line_items[${i}][price_data][product_data][name]`, line.product.name)
    form.set(`line_items[${i}][price_data][unit_amount]`, String(line.product.priceMinor))
    form.set(`line_items[${i}][quantity]`, String(line.quantity))
  })

  let session: { id?: string; url?: string; error?: { message?: string } }
  try {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    })
    session = (await res.json()) as typeof session
    if (!res.ok || !session.url) {
      return c.json(
        {
          error: {
            code: 'stripe_error',
            message: session.error?.message ?? 'Stripe rejected the request.',
          },
        },
        502,
      )
    }
  } catch (err: any) {
    return c.json({ error: { code: 'stripe_unreachable', message: err.message } }, 502)
  }

  // Record a pending order; the webhook flips it to paid. Never block the sale
  // on a bookkeeping failure — log and continue.
  const amountTotal = lines.reduce((sum, l) => sum + l.product.priceMinor * l.quantity, 0)
  try {
    await prisma.order.create({
      data: {
        status: 'pending',
        amountTotal,
        currency,
        stripeSessionId: session.id,
        items: {
          create: lines.map((l) => ({
            productId: l.product.id,
            name: l.product.name,
            unitAmount: l.product.priceMinor,
            quantity: l.quantity,
          })),
        },
      },
    })
  } catch (err) {
    console.error('[checkout] failed to record pending order:', err)
  }

  return c.json({ ok: true, url: session.url })
})

// Stripe webhook → mark the order paid. Set STRIPE_WEBHOOK_SECRET in the env
// (Stripe dashboard → Developers → Webhooks → add endpoint
// `/api/webhooks/stripe`, event `checkout.session.completed`). Signature
// verification uses node:crypto — still no npm install.
app.post('/webhooks/stripe', async (c) => {
  const whsec = process.env.STRIPE_WEBHOOK_SECRET
  const sig = c.req.header('stripe-signature')
  const raw = await c.req.text()
  if (!whsec || !sig) return c.json({ error: { code: 'no_webhook_secret' } }, 400)

  const parts = Object.fromEntries(
    sig.split(',').map((kv) => kv.split('=') as [string, string]),
  )
  const expected = createHmac('sha256', whsec).update(`${parts.t}.${raw}`).digest('hex')
  const ok =
    !!parts.v1 &&
    expected.length === parts.v1.length &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1))
  if (!ok) return c.json({ error: { code: 'bad_signature' } }, 400)

  const event = JSON.parse(raw)
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object
    await prisma.order.updateMany({
      where: { stripeSessionId: s.id },
      data: {
        status: 'paid',
        email: s.customer_details?.email ?? undefined,
        customerName: s.customer_details?.name ?? undefined,
      },
    })
  }
  return c.json({ received: true })
})

export default app
