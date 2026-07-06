// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { CalendarCheck, CheckCircle2 } from 'lucide-react'
import { createReservation } from '@/lib/site-api'
import type { SiteContent } from '@/data/site-content'
import { SectionHeading } from './MenuSection'

type Status = 'idle' | 'submitting' | 'done'

export function ReservationForm({ content }: { content: SiteContent }) {
  const { booking, business } = content
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)

  if (!booking.enabled) return null

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const form = e.currentTarget
    const data = new FormData(form)

    const partySize = Number(data.get('partySize') || 2)
    setStatus('submitting')
    try {
      await createReservation({
        name: String(data.get('name') || '').trim(),
        email: String(data.get('email') || '').trim() || undefined,
        phone: String(data.get('phone') || '').trim() || undefined,
        partySize: Number.isFinite(partySize) && partySize > 0 ? partySize : 2,
        date: String(data.get('date') || ''),
        time: String(data.get('time') || ''),
        notes: String(data.get('notes') || '').trim() || undefined,
      })
      setStatus('done')
      form.reset()
    } catch (err) {
      setStatus('idle')
      setError(err instanceof Error ? err.message : 'Could not send your request. Please try again.')
    }
  }

  return (
    <section id="book" className="border-b border-border/60 bg-muted/30 py-20">
      <div className="mx-auto max-w-xl px-6">
        <SectionHeading eyebrow="Reservations" title={booking.ctaLabel} />

        {booking.note && (
          <p className="mt-4 text-center text-sm text-muted-foreground">{booking.note}</p>
        )}

        {status === 'done' ? (
          <div className="mt-10 flex flex-col items-center rounded-xl border border-emerald-500/40 bg-emerald-50 px-6 py-10 text-center dark:bg-emerald-950/20">
            <CheckCircle2 className="mb-3 h-10 w-10 text-emerald-600" />
            <h3 className="text-lg font-medium">Request received</h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Thanks — {business.name || 'the team'} will confirm your booking shortly. We'll be in
              touch using the details you gave us.
            </p>
            <Button variant="outline" className="mt-6 rounded-full" onClick={() => setStatus('idle')}>
              Make another booking
            </Button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="mt-10 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" htmlFor="res-name">
                <Input id="res-name" name="name" required autoComplete="name" placeholder="Jordan Lee" />
              </Field>
              <Field label="Party size" htmlFor="res-party">
                <Input
                  id="res-party"
                  name="partySize"
                  type="number"
                  min={1}
                  max={40}
                  defaultValue={2}
                  required
                />
              </Field>
              <Field label="Date" htmlFor="res-date">
                <Input id="res-date" name="date" type="date" required />
              </Field>
              <Field label="Time" htmlFor="res-time">
                <Input id="res-time" name="time" type="time" required />
              </Field>
              <Field label="Phone" htmlFor="res-phone">
                <Input id="res-phone" name="phone" type="tel" autoComplete="tel" placeholder="Optional" />
              </Field>
              <Field label="Email" htmlFor="res-email">
                <Input
                  id="res-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="Optional"
                />
              </Field>
            </div>
            <Field label="Anything we should know?" htmlFor="res-notes">
              <Textarea
                id="res-notes"
                name="notes"
                placeholder="Allergies, high chair, celebration…"
                rows={3}
              />
            </Field>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button type="submit" size="lg" className="w-full rounded-full" disabled={status === 'submitting'}>
              <CalendarCheck className="h-4 w-4" />
              {status === 'submitting' ? 'Sending…' : booking.ctaLabel}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              This sends a request — you'll get a confirmation once it's accepted.
            </p>
          </form>
        )}
      </div>
    </section>
  )
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  )
}
