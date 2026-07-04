// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState } from 'react'
import { Menu, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { SiteContent } from '@/data/site-content'

interface NavLink {
  label: string
  href: string
}

export function SiteHeader({ content }: { content: SiteContent }) {
  const [open, setOpen] = useState(false)

  const links: NavLink[] = [
    content.menu.categories.length > 0 && { label: content.menu.heading, href: '#menu' },
    { label: 'Hours', href: '#visit' },
    content.gallery.length > 0 && { label: 'Gallery', href: '#gallery' },
    { label: 'Contact', href: '#contact' },
  ].filter(Boolean) as NavLink[]

  const name = content.business.name || 'Your Business'

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <a href="#top" className="font-serif text-lg font-semibold tracking-tight">
          {name}
        </a>

        <nav className="hidden items-center gap-7 md:flex">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {l.label}
            </a>
          ))}
          {content.booking.enabled && (
            <Button size="sm" className="rounded-full" onClick={() => scrollTo('#book')}>
              {content.booking.ctaLabel}
            </Button>
          )}
        </nav>

        <button
          className="inline-flex items-center justify-center rounded-md p-2 md:hidden"
          aria-label="Toggle menu"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {open && (
        <div className="border-t border-border/60 bg-background md:hidden">
          <nav className="mx-auto flex max-w-6xl flex-col gap-1 px-6 py-3">
            {links.map((l) => (
              <a
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="rounded-md px-2 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {l.label}
              </a>
            ))}
            {content.booking.enabled && (
              <a
                href="#book"
                onClick={() => setOpen(false)}
                className="rounded-md px-2 py-2 text-sm font-medium text-primary"
              >
                {content.booking.ctaLabel}
              </a>
            )}
          </nav>
        </div>
      )}
    </header>
  )
}

function scrollTo(hash: string) {
  document.querySelector(hash)?.scrollIntoView({ behavior: 'smooth' })
}
