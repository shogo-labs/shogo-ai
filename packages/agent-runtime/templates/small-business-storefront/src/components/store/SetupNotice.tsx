// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Sparkles } from 'lucide-react'

/**
 * Shown until the owner's REAL products and store details are in
 * `src/data/store-content.ts` and `configured` is set to true — so a
 * half-built store never masquerades as a finished, published shop.
 */
export function SetupNotice() {
  return (
    <div className="border-b border-amber-300/60 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-950/30">
      <div className="mx-auto max-w-6xl px-6 py-3">
        <Alert className="border-none bg-transparent p-0">
          <Sparkles className="h-4 w-4 text-amber-600" />
          <AlertTitle className="text-amber-900 dark:text-amber-200">
            This store is showing sample structure — not your real products yet
          </AlertTitle>
          <AlertDescription className="text-amber-800/90 dark:text-amber-200/80">
            Tell me your store name and products (name, price, photo) and I'll add them. I won't
            invent products or prices. When you're ready to take payments, connect your own Stripe
            account and I'll switch checkout on.
          </AlertDescription>
        </Alert>
      </div>
    </div>
  )
}
