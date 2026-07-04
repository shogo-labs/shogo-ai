// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState } from 'react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Minus, Plus, Trash2, ShoppingBag, Info } from 'lucide-react'
import { useCart } from '@/lib/cart'
import { formatMoney } from '@/lib/format'
import { startCheckout, PaymentsNotConfiguredError } from '@/lib/store-api'
import type { StoreContent } from '@/data/store-content'

export function CartDrawer({
  content,
  open,
  onOpenChange,
}: {
  content: StoreContent
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { lines, subtotalMinor, count, setQuantity, remove } = useCart()
  const [status, setStatus] = useState<'idle' | 'redirecting' | 'not_configured'>('idle')
  const [error, setError] = useState<string | null>(null)

  async function onCheckout() {
    setError(null)
    setStatus('redirecting')
    try {
      const { url } = await startCheckout(lines)
      window.location.href = url
    } catch (err) {
      if (err instanceof PaymentsNotConfiguredError) {
        setStatus('not_configured')
        return
      }
      setStatus('idle')
      setError(err instanceof Error ? err.message : 'Checkout failed. Please try again.')
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <ShoppingBag className="h-5 w-5" /> Your cart
          </SheetTitle>
        </SheetHeader>

        {count === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <ShoppingBag className="h-8 w-8 opacity-40" />
            <p className="text-sm">Your cart is empty.</p>
          </div>
        ) : (
          <>
            <div className="-mx-2 flex-1 overflow-y-auto px-2">
              <ul className="divide-y divide-border">
                {lines.map((l) => (
                  <li key={l.id} className="flex gap-3 py-4">
                    <div className="h-16 w-16 shrink-0 overflow-hidden rounded-md bg-muted">
                      {l.image && (
                        <img src={l.image} alt={l.name} className="h-full w-full object-cover" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <span className="truncate text-sm font-medium">{l.name}</span>
                        <button
                          onClick={() => remove(l.id)}
                          aria-label={`Remove ${l.name}`}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        <div className="flex items-center rounded-full border border-border">
                          <button
                            className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-accent"
                            aria-label="Decrease quantity"
                            onClick={() => setQuantity(l.id, l.quantity - 1)}
                          >
                            <Minus className="h-3.5 w-3.5" />
                          </button>
                          <span className="w-7 text-center text-sm tabular-nums">{l.quantity}</span>
                          <button
                            className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-accent"
                            aria-label="Increase quantity"
                            onClick={() => setQuantity(l.id, l.quantity + 1)}
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <span className="text-sm font-medium tabular-nums">
                          {formatMoney(l.priceMinor * l.quantity)}
                        </span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            <div className="space-y-3 border-t border-border pt-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Subtotal</span>
                <span className="font-semibold tabular-nums">{formatMoney(subtotalMinor)}</span>
              </div>
              {content.shippingNote && (
                <p className="text-xs text-muted-foreground">{content.shippingNote}</p>
              )}

              {status === 'not_configured' ? (
                <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/50 p-3 text-sm text-muted-foreground">
                  <Info className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    Online payments aren't switched on yet. The store owner needs to connect a
                    Stripe account to accept orders.
                  </span>
                </div>
              ) : (
                <Button
                  size="lg"
                  className="w-full rounded-full"
                  disabled={status === 'redirecting'}
                  onClick={onCheckout}
                >
                  {status === 'redirecting'
                    ? 'Taking you to checkout…'
                    : `Checkout · ${formatMoney(subtotalMinor)}`}
                </Button>
              )}

              {error && <p className="text-sm text-destructive">{error}</p>}
              <p className="text-center text-xs text-muted-foreground">
                Secure payment powered by Stripe.
              </p>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
