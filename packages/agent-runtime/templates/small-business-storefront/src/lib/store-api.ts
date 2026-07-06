// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Client wrapper for the storefront's checkout call.
//
// The catalog and cart work with ZERO setup. Real payments switch on once the
// owner (a) adds their Stripe secret key to the project's environment as
// STRIPE_SECRET_KEY and (b) has the agent add the `/api/checkout` route from
// the `stripe-checkout` skill. Until then, `/api/checkout` doesn't exist and
// this wrapper surfaces a clear, honest message instead of a cryptic crash —
// stranded users with no error text is a top platform pain point.

import type { CartLine } from '@/lib/cart'

/** Thrown when the Stripe checkout route hasn't been wired up yet. */
export class PaymentsNotConfiguredError extends Error {
  constructor() {
    super('Online payments are not switched on yet.')
    this.name = 'PaymentsNotConfiguredError'
  }
}

export interface CheckoutResult {
  /** Stripe-hosted checkout URL to redirect the browser to. */
  url: string
}

/**
 * Ask the server to create a Stripe Checkout Session for the current cart.
 * Sends only ids + quantities — the SERVER re-reads authoritative prices from
 * the catalog so a tampered client price can never change what's charged.
 */
export async function startCheckout(lines: CartLine[]): Promise<CheckoutResult> {
  const payload = {
    items: lines.map((l) => ({ id: l.id, quantity: l.quantity })),
  }

  let res: Response
  try {
    res = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    throw new Error('Could not reach the store. Check your connection and try again.')
  }

  // Route not added yet → Hono's static catch-all returns index.html (200 HTML)
  // or a 404. Either way there's no JSON checkout URL: treat as "not set up".
  if (res.status === 404) throw new PaymentsNotConfiguredError()

  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    throw new PaymentsNotConfiguredError()
  }

  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    url?: string
    error?: { code?: string; message?: string }
  }

  if (res.status === 501 || body.error?.code === 'stripe_not_configured') {
    throw new PaymentsNotConfiguredError()
  }
  if (!res.ok || !body.url) {
    throw new Error(body.error?.message ?? `Checkout failed (HTTP ${res.status})`)
  }
  return { url: body.url }
}
