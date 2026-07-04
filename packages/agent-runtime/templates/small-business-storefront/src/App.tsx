// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// The public, ready-to-publish storefront. Product catalog and cart come from
// `src/data/store-content.ts` — the single source of truth you fill in with the
// owner's REAL products. Checkout calls `POST /api/checkout` (added from the
// `stripe-checkout` skill once the owner connects Stripe); until then the cart
// still works and checkout explains payments aren't switched on yet.

import { useState } from 'react'
import { storeContent, isStoreReady } from '@/data/store-content'
import { CartProvider } from '@/lib/cart'
import { SetupNotice } from '@/components/store/SetupNotice'
import { CheckoutStatus } from '@/components/store/CheckoutStatus'
import { StoreHeader } from '@/components/store/StoreHeader'
import { StoreHero } from '@/components/store/StoreHero'
import { ProductGrid } from '@/components/store/ProductGrid'
import { CartDrawer } from '@/components/store/CartDrawer'
import { StoreFooter } from '@/components/store/StoreFooter'

export default function App() {
  const content = storeContent
  const [cartOpen, setCartOpen] = useState(false)

  return (
    <CartProvider>
      <div className="min-h-screen scroll-smooth bg-background font-sans text-foreground antialiased">
        {!isStoreReady(content) && <SetupNotice />}
        <CheckoutStatus />
        <StoreHeader content={content} onOpenCart={() => setCartOpen(true)} />
        <main>
          <StoreHero content={content} />
          <ProductGrid content={content} />
        </main>
        <StoreFooter content={content} />
        <CartDrawer content={content} open={cartOpen} onOpenChange={setCartOpen} />
      </div>
    </CartProvider>
  )
}
