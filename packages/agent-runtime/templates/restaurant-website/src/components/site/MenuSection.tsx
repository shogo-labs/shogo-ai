// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Badge } from '@/components/ui/badge'
import { UtensilsCrossed } from 'lucide-react'
import type { SiteContent } from '@/data/site-content'

export function MenuSection({ content }: { content: SiteContent }) {
  const { menu } = content

  return (
    <section id="menu" className="border-b border-border/60 py-20">
      <div className="mx-auto max-w-4xl px-6">
        <SectionHeading eyebrow="What we serve" title={menu.heading} />

        {menu.categories.length === 0 ? (
          <EmptyMenu />
        ) : (
          <div className="mt-12 space-y-14">
            {menu.categories.map((cat) => (
              <div key={cat.name}>
                <div className="mb-6 border-b border-border/60 pb-2">
                  <h3 className="font-serif text-2xl font-semibold tracking-tight">{cat.name}</h3>
                  {cat.description && (
                    <p className="mt-1 text-sm text-muted-foreground">{cat.description}</p>
                  )}
                </div>
                <ul className="space-y-6">
                  {cat.items.map((item, i) => (
                    <li key={`${item.name}-${i}`} className="flex items-baseline gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{item.name}</span>
                          {item.tags?.map((t) => (
                            <Badge key={t} variant="secondary" className="text-[10px] font-normal">
                              {t}
                            </Badge>
                          ))}
                        </div>
                        {item.description && (
                          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                            {item.description}
                          </p>
                        )}
                      </div>
                      {item.price && (
                        <span className="shrink-0 font-medium tabular-nums text-foreground">
                          {item.price}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function EmptyMenu() {
  return (
    <div className="mt-12 flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
      <UtensilsCrossed className="mb-3 h-8 w-8 text-muted-foreground/60" />
      <p className="text-sm text-muted-foreground">
        The menu will appear here once the real items and prices are added.
      </p>
    </div>
  )
}

export function SectionHeading({ eyebrow, title }: { eyebrow?: string; title: string }) {
  return (
    <div className="text-center">
      {eyebrow && (
        <span className="text-xs font-medium uppercase tracking-[0.3em] text-amber-700 dark:text-amber-400">
          {eyebrow}
        </span>
      )}
      <h2 className="mt-2 font-serif text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h2>
    </div>
  )
}
