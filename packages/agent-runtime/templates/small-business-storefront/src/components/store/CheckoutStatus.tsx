// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useEffect, useState } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCart } from '@/lib/cart'

/**
 * Reads the `?checkout=success|cancelled` query param that Stripe's hosted
 * checkout redirects back to (success_url / cancel_url in the checkout route).
 * On success it clears the cart and shows a thank-you banner.
 */
export function CheckoutStatus() {
  const { clear } = useCart()
  const [state, setState] = useState<'success' | 'cancelled' | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const value = params.get('checkout')
    if (value === 'success') {
      setState('success')
      clear()
    } else if (value === 'cancelled' || value === 'cancel') {
      setState('cancelled')
    }
    if (value) {
      // Strip the param so a refresh doesn't re-trigger.
      params.delete('checkout')
      const qs = params.toString()
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''))
    }
  }, [clear])

  if (!state) return null

  const success = state === 'success'
  return (
    <div
      className={
        'border-b ' +
        (success
          ? 'border-emerald-500/40 bg-emerald-50 dark:bg-emerald-950/20'
          : 'border-border bg-muted/50')
      }
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
        <div className="flex items-center gap-2 text-sm">
          {success ? (
            <>
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              <span>Thank you — your order is confirmed. A receipt is on its way.</span>
            </>
          ) : (
            <>
              <XCircle className="h-4 w-4 text-muted-foreground" />
              <span>Checkout was cancelled. Your cart is still saved.</span>
            </>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={() => setState(null)}>
          Dismiss
        </Button>
      </div>
    </div>
  )
}
