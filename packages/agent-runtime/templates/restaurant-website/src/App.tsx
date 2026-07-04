// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// This is the public, ready-to-publish website. Everything it renders comes
// from `src/data/site-content.ts` — the single source of truth you fill in
// with the owner's REAL details. Visitor bookings and messages persist via
// the SDK-generated CRUD API (/api/reservations, /api/contact-messages).
//
// The page is section-based (Hero → Menu → Visit → Gallery → Book → Contact).
// Remove a section by deleting its component below; every section already
// degrades to a clean empty state when its data is missing.

import { siteContent, isSiteReady } from '@/data/site-content'
import { SetupNotice } from '@/components/site/SetupNotice'
import { SiteHeader } from '@/components/site/SiteHeader'
import { Hero } from '@/components/site/Hero'
import { MenuSection } from '@/components/site/MenuSection'
import { VisitSection } from '@/components/site/VisitSection'
import { Gallery } from '@/components/site/Gallery'
import { ReservationForm } from '@/components/site/ReservationForm'
import { ContactSection } from '@/components/site/ContactSection'
import { SiteFooter } from '@/components/site/SiteFooter'

export default function App() {
  const content = siteContent

  return (
    <div className="min-h-screen scroll-smooth bg-background font-sans text-foreground antialiased">
      {!isSiteReady(content) && <SetupNotice />}
      <SiteHeader content={content} />
      <main>
        <Hero content={content} />
        <MenuSection content={content} />
        <VisitSection content={content} />
        <Gallery content={content} />
        <ReservationForm content={content} />
        <ContactSection content={content} />
      </main>
      <SiteFooter content={content} />
    </div>
  )
}
