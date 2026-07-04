// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState } from 'react'
import { ImageOff, Plus, Check } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useCart } from '@/lib/cart'
import { formatMoney } from '@/lib/format'
import type { Product } from '@/data/store-content'

export function ProductCard({ product }: { product: Product }) {
  const { add } = useCart()
  const [added, setAdded] = useState(false)
  const soldOut = product.available === false

  function onAdd() {
    add(product)
    setAdded(true)
    window.setTimeout(() => setAdded(false), 1400)
  }

  return (
    <div className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="relative aspect-square overflow-hidden bg-muted">
        {product.image ? (
          <img
            src={product.image}
            alt={product.name}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground/50">
            <ImageOff className="h-7 w-7" />
            <span className="text-xs">No photo yet</span>
          </div>
        )}
        {product.tags && product.tags.length > 0 && (
          <div className="absolute left-2 top-2 flex flex-wrap gap-1">
            {product.tags.map((t) => (
              <Badge key={t} className="text-[10px]">
                {t}
              </Badge>
            ))}
          </div>
        )}
        {soldOut && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70">
            <span className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Sold out
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col p-4">
        <h3 className="font-medium">{product.name}</h3>
        {product.description && (
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{product.description}</p>
        )}
        <div className="mt-4 flex items-center justify-between">
          <span className="font-semibold tabular-nums">{formatMoney(product.priceMinor)}</span>
          <Button size="sm" className="rounded-full" disabled={soldOut} onClick={onAdd}>
            {added ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {added ? 'Added' : 'Add'}
          </Button>
        </div>
      </div>
    </div>
  )
}
