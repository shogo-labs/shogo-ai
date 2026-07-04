// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { CheckCircle2, Send } from 'lucide-react'
import { createContactMessage } from '@/lib/site-api'
import type { SiteContent } from '@/data/site-content'
import { SectionHeading } from './MenuSection'

type Status = 'idle' | 'submitting' | 'done'

export function ContactSection({ content }: { content: SiteContent }) {
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const { about } = content.business

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const form = e.currentTarget
    const data = new FormData(form)
    setStatus('submitting')
    try {
      await createContactMessage({
        name: String(data.get('name') || '').trim(),
        email: String(data.get('email') || '').trim(),
        phone: String(data.get('phone') || '').trim() || undefined,
        subject: String(data.get('subject') || '').trim() || undefined,
        message: String(data.get('message') || '').trim(),
      })
      setStatus('done')
      form.reset()
    } catch (err) {
      setStatus('idle')
      setError(err instanceof Error ? err.message : 'Could not send your message. Please try again.')
    }
  }

  return (
    <section id="contact" className="py-20">
      <div className="mx-auto grid max-w-5xl gap-12 px-6 md:grid-cols-2">
        <div>
          <SectionHeading eyebrow="Say hello" title="Get in touch" />
          {about && (
            <p className="mt-6 text-center leading-relaxed text-muted-foreground md:text-left">
              {about}
            </p>
          )}
        </div>

        <div>
          {status === 'done' ? (
            <div className="flex h-full flex-col items-center justify-center rounded-xl border border-emerald-500/40 bg-emerald-50 px-6 py-10 text-center dark:bg-emerald-950/20">
              <CheckCircle2 className="mb-3 h-10 w-10 text-emerald-600" />
              <h3 className="text-lg font-medium">Message sent</h3>
              <p className="mt-1 text-sm text-muted-foreground">Thanks for reaching out — we'll reply soon.</p>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="c-name">Name</Label>
                <Input id="c-name" name="name" required autoComplete="name" />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="c-email">Email</Label>
                  <Input id="c-email" name="email" type="email" required autoComplete="email" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="c-phone">Phone</Label>
                  <Input id="c-phone" name="phone" type="tel" placeholder="Optional" autoComplete="tel" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="c-subject">Subject</Label>
                <Input id="c-subject" name="subject" placeholder="Optional" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="c-message">Message</Label>
                <Textarea id="c-message" name="message" required rows={4} />
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <Button type="submit" className="w-full rounded-full" disabled={status === 'submitting'}>
                <Send className="h-4 w-4" />
                {status === 'submitting' ? 'Sending…' : 'Send message'}
              </Button>
            </form>
          )}
        </div>
      </div>
    </section>
  )
}
