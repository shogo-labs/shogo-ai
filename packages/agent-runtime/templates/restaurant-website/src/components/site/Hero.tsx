// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { MapPin, Phone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { SiteContent } from '@/data/site-content'

export function Hero({ content }: { content: SiteContent }) {
  const { business, contact, booking } = content
  const name = business.name || 'Your Business Name'
  const heroImage = content.gallery[0]?.url

  return (
    <section id="top" className="relative overflow-hidden border-b border-border/60">
      {heroImage ? (
        <div className="absolute inset-0">
          <img src={heroImage} alt={content.gallery[0]?.alt ?? name} className="h-full w-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/45 to-black/25" />
        </div>
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-stone-100 via-amber-50 to-stone-200 dark:from-stone-950 dark:via-stone-900 dark:to-stone-950" />
      )}

      <div
        className={
          'relative mx-auto flex min-h-[62vh] max-w-6xl flex-col justify-center px-6 py-24 ' +
          (heroImage ? 'text-white' : 'text-foreground')
        }
      >
        {business.cuisine && (
          <span
            className={
              'mb-4 text-xs font-medium uppercase tracking-[0.3em] ' +
              (heroImage ? 'text-white/80' : 'text-amber-700 dark:text-amber-400')
            }
          >
            {business.cuisine}
            {business.priceRange ? ` · ${business.priceRange}` : ''}
          </span>
        )}

        <h1 className="max-w-3xl font-serif text-5xl font-semibold leading-tight tracking-tight sm:text-6xl">
          {name}
        </h1>

        {business.tagline && (
          <p
            className={
              'mt-4 max-w-xl text-lg ' + (heroImage ? 'text-white/85' : 'text-muted-foreground')
            }
          >
            {business.tagline}
          </p>
        )}

        <div className="mt-8 flex flex-wrap items-center gap-3">
          {booking.enabled && (
            <Button
              size="lg"
              className="rounded-full"
              onClick={() => document.querySelector('#book')?.scrollIntoView({ behavior: 'smooth' })}
            >
              {booking.ctaLabel}
            </Button>
          )}
          {content.menu.categories.length > 0 && (
            <Button
              size="lg"
              variant={heroImage ? 'secondary' : 'outline'}
              className="rounded-full"
              onClick={() => document.querySelector('#menu')?.scrollIntoView({ behavior: 'smooth' })}
            >
              View {content.menu.heading.toLowerCase()}
            </Button>
          )}
        </div>

        {(contact.address || contact.phone) && (
          <div
            className={
              'mt-10 flex flex-wrap gap-x-8 gap-y-2 text-sm ' +
              (heroImage ? 'text-white/80' : 'text-muted-foreground')
            }
          >
            {contact.address && (
              <span className="inline-flex items-center gap-2">
                <MapPin className="h-4 w-4" /> {contact.address}
              </span>
            )}
            {contact.phone && (
              <a href={`tel:${contact.phone}`} className="inline-flex items-center gap-2 hover:underline">
                <Phone className="h-4 w-4" /> {contact.phone}
              </a>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
