// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared Stripe helpers.
 *
 * `STRIPE_API_VERSION` pins the API version every server-side Stripe client is
 * constructed with so a future SDK bump can't silently change request/response
 * shapes without a code review. It matches the stripe SDK's bundled default
 * (currently 20.x → `2026-01-28.clover`).
 *
 * `resolveInvoiceSubscriptionId` reads the subscription id off an invoice
 * defensively. As of the 2025+ API versions, `Invoice.subscription` was
 * removed and the id now lives under
 * `Invoice.parent.subscription_details.subscription`. Reading both shapes keeps
 * the webhook working across Stripe API upgrades — the previous code only read
 * the legacy `invoice.subscription`, which is `null` on the account's current
 * version, so the receipt-email + monthly-refill path silently never ran.
 */

export const STRIPE_API_VERSION = '2026-01-28.clover' as const

type InvoiceSubShape = {
  subscription?: string | { id?: string | null } | null
  parent?: {
    subscription_details?: { subscription?: string | { id?: string | null } | null } | null
  } | null
}

/**
 * Resolve a Stripe invoice's subscription id across API versions. Returns
 * `null` for one-off invoices that have no associated subscription.
 */
export function resolveInvoiceSubscriptionId(invoice: unknown): string | null {
  const inv = invoice as InvoiceSubShape | null | undefined
  const raw = inv?.subscription ?? inv?.parent?.subscription_details?.subscription ?? null
  if (!raw) return null
  return typeof raw === 'string' ? raw : raw.id ?? null
}
