// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { SiteContent } from '@/data/site-content'
import { SectionHeading } from './MenuSection'

export function Gallery({ content }: { content: SiteContent }) {
  const { gallery } = content
  if (gallery.length === 0) return null

  return (
    <section id="gallery" className="border-b border-border/60 py-20">
      <div className="mx-auto max-w-6xl px-6">
        <SectionHeading eyebrow="A look inside" title="Gallery" />
        <div className="mt-12 grid grid-cols-2 gap-3 sm:grid-cols-3 md:gap-4">
          {gallery.map((photo, i) => (
            <figure
              key={`${photo.url}-${i}`}
              className="group relative aspect-square overflow-hidden rounded-lg bg-muted"
            >
              <img
                src={photo.url}
                alt={photo.alt}
                loading="lazy"
                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
              />
              {photo.caption && (
                <figcaption className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-3 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100">
                  {photo.caption}
                </figcaption>
              )}
            </figure>
          ))}
        </div>
      </div>
    </section>
  )
}
