// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Clock, MapPin, Phone, Mail } from 'lucide-react'
import type { SiteContent } from '@/data/site-content'
import { SectionHeading } from './MenuSection'

const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

function todayName(): string {
  return DAY_ORDER[(new Date().getDay() + 6) % 7]
}

export function VisitSection({ content }: { content: SiteContent }) {
  const { hours, contact } = content
  const today = todayName()

  return (
    <section id="visit" className="border-b border-border/60 bg-muted/30 py-20">
      <div className="mx-auto max-w-5xl px-6">
        <SectionHeading eyebrow="Plan your visit" title="Hours & location" />

        <div className="mt-12 grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader className="flex-row items-center gap-2 space-y-0">
              <Clock className="h-5 w-5 text-amber-600" />
              <CardTitle className="text-lg">Opening hours</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-border/60">
                {hours.map((h) => {
                  const closed = h.hours.trim().length === 0
                  const isToday = h.day === today
                  return (
                    <li
                      key={h.day}
                      className={
                        'flex items-center justify-between py-2.5 text-sm ' +
                        (isToday ? 'font-medium text-foreground' : 'text-muted-foreground')
                      }
                    >
                      <span className="flex items-center gap-2">
                        {h.day}
                        {isToday && (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                            Today
                          </span>
                        )}
                      </span>
                      <span className={closed ? 'text-muted-foreground/70' : ''}>
                        {closed ? 'Closed' : h.hours}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center gap-2 space-y-0">
              <MapPin className="h-5 w-5 text-amber-600" />
              <CardTitle className="text-lg">Find us</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              {contact.address ? (
                <p className="leading-relaxed text-muted-foreground">{contact.address}</p>
              ) : (
                <p className="text-muted-foreground/70">Address coming soon.</p>
              )}

              <div className="space-y-2">
                {contact.phone && (
                  <a
                    href={`tel:${contact.phone}`}
                    className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground"
                  >
                    <Phone className="h-4 w-4" /> {contact.phone}
                  </a>
                )}
                {contact.email && (
                  <a
                    href={`mailto:${contact.email}`}
                    className="flex items-center gap-2 text-muted-foreground hover:text-foreground"
                  >
                    <Mail className="h-4 w-4" /> {contact.email}
                  </a>
                )}
              </div>

              {contact.mapUrl && (
                <a
                  href={contact.mapUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-block text-sm font-medium text-amber-700 hover:underline dark:text-amber-400"
                >
                  Open in Google Maps →
                </a>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  )
}
