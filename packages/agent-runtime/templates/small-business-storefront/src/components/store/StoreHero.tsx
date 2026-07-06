// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Button } from '@/components/ui/button'
import type { StoreContent } from '@/data/store-content'

export function StoreHero({ content }: { content: StoreContent }) {
  const { store } = content
  const name = store.name || 'Your Store Name'

  return (
    <section
      id="top"
      className="border-b border-border/60 bg-gradient-to-br from-stone-100 via-background to-stone-100 dark:from-stone-950 dark:via-background dark:to-stone-950"
    >
      <div className="mx-auto max-w-6xl px-6 py-20 text-center">
        <h1 className="font-semibold tracking-tight text-4xl sm:text-5xl">{name}</h1>
        {store.tagline && (
          <p className="mx-auto mt-4 max-w-xl text-lg text-muted-foreground">{store.tagline}</p>
        )}
        {content.products.length > 0 && (
          <Button
            size="lg"
            className="mt-8 rounded-full"
            onClick={() => document.querySelector('#shop')?.scrollIntoView({ behavior: 'smooth' })}
          >
            Shop now
          </Button>
        )}
      </div>
    </section>
  )
}
