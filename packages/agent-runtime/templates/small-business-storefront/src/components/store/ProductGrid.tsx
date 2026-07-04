// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { PackageOpen } from 'lucide-react'
import { ProductCard } from './ProductCard'
import type { Product, StoreContent } from '@/data/store-content'

export function ProductGrid({ content }: { content: StoreContent }) {
  const { products } = content

  return (
    <section id="shop" className="py-16">
      <div className="mx-auto max-w-6xl px-6">
        {products.length === 0 ? (
          <EmptyCatalog />
        ) : (
          <div className="space-y-16">
            {groupByCategory(products).map(({ category, items }) => (
              <div key={category ?? '_'}>
                {category && (
                  <h2 className="mb-6 text-xl font-semibold tracking-tight">{category}</h2>
                )}
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                  {items.map((p) => (
                    <ProductCard key={p.id} product={p} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function groupByCategory(products: Product[]): { category?: string; items: Product[] }[] {
  const hasCategories = products.some((p) => p.category)
  if (!hasCategories) return [{ category: undefined, items: products }]

  const groups = new Map<string, Product[]>()
  for (const p of products) {
    const key = p.category ?? 'More'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(p)
  }
  return [...groups.entries()].map(([category, items]) => ({ category, items }))
}

function EmptyCatalog() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-20 text-center">
      <PackageOpen className="mb-3 h-8 w-8 text-muted-foreground/60" />
      <p className="text-sm text-muted-foreground">
        Your products will appear here once the real items and prices are added.
      </p>
    </div>
  )
}
