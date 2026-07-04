// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { ShoppingBag } from 'lucide-react'
import { useCart } from '@/lib/cart'
import type { StoreContent } from '@/data/store-content'

export function StoreHeader({
  content,
  onOpenCart,
}: {
  content: StoreContent
  onOpenCart: () => void
}) {
  const { count } = useCart()
  const name = content.store.name || 'Your Store'

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <a href="#top" className="font-semibold tracking-tight">
          {name}
        </a>

        <button
          onClick={onOpenCart}
          className="relative inline-flex h-10 w-10 items-center justify-center rounded-full border border-border transition-colors hover:bg-accent"
          aria-label={`Open cart, ${count} item${count === 1 ? '' : 's'}`}
        >
          <ShoppingBag className="h-5 w-5" />
          {count > 0 && (
            <span className="absolute -right-1 -top-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-semibold text-primary-foreground">
              {count}
            </span>
          )}
        </button>
      </div>
    </header>
  )
}
