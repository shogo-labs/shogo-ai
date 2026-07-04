// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Instagram, Facebook, MapPin } from 'lucide-react'
import type { SiteContent } from '@/data/site-content'

export function SiteFooter({ content }: { content: SiteContent }) {
  const { business, contact, social } = content
  const name = business.name || 'Your Business'
  const year = new Date().getFullYear()

  const socials = [
    social.instagram && { icon: Instagram, href: social.instagram, label: 'Instagram' },
    social.facebook && { icon: Facebook, href: social.facebook, label: 'Facebook' },
    social.googleMaps && { icon: MapPin, href: social.googleMaps, label: 'Google Maps' },
  ].filter(Boolean) as { icon: typeof Instagram; href: string; label: string }[]

  return (
    <footer className="border-t border-border/60 bg-muted/40">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-6 py-10 text-center">
        <div className="font-serif text-lg font-semibold">{name}</div>
        {contact.address && <p className="text-sm text-muted-foreground">{contact.address}</p>}

        {socials.length > 0 && (
          <div className="flex items-center gap-4">
            {socials.map((s) => (
              <a
                key={s.label}
                href={s.href}
                target="_blank"
                rel="noreferrer"
                aria-label={s.label}
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                <s.icon className="h-5 w-5" />
              </a>
            ))}
          </div>
        )}

        <p className="text-xs text-muted-foreground/70">
          © {year} {name}. All rights reserved.
        </p>
      </div>
    </footer>
  )
}
