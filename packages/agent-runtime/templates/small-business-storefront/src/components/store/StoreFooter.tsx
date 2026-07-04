// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Instagram, Facebook, Globe, Mail } from 'lucide-react'
import type { StoreContent } from '@/data/store-content'

export function StoreFooter({ content }: { content: StoreContent }) {
  const { store, contact, social } = content
  const name = store.name || 'Your Store'
  const year = new Date().getFullYear()

  const socials = [
    social.instagram && { icon: Instagram, href: social.instagram, label: 'Instagram' },
    social.facebook && { icon: Facebook, href: social.facebook, label: 'Facebook' },
    social.website && { icon: Globe, href: social.website, label: 'Website' },
  ].filter(Boolean) as { icon: typeof Globe; href: string; label: string }[]

  return (
    <footer className="border-t border-border/60 bg-muted/40">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-6 py-10 text-center">
        <div className="font-semibold">{name}</div>
        {store.about && <p className="max-w-md text-sm text-muted-foreground">{store.about}</p>}

        <div className="flex items-center gap-4">
          {contact.email && (
            <a
              href={`mailto:${contact.email}`}
              aria-label="Email"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <Mail className="h-5 w-5" />
            </a>
          )}
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

        <p className="text-xs text-muted-foreground/70">
          © {year} {name}. All rights reserved.
        </p>
      </div>
    </footer>
  )
}
