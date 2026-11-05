// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-339 — the price-change notice.
 *
 * The copy rules are the acceptance criteria: lead with the lower price, state
 * the exact switch date, explain the weekly per-seat allowance and the
 * 80%/100%/overage path, and link to billing. Basic is "more AI, same price";
 * a trial is "you'll be charged $16, not $40".
 */

import { describe, expect, it } from 'bun:test'
import { renderPriceChangeEmail } from '../email-templates/price-change'

const BASE = {
  workspaceName: 'Acme Corp',
  planName: 'Business',
  fromPriceUsd: 40,
  toPriceUsd: 16,
  interval: 'month' as const,
  switchDate: '2026-12-08',
  weeklyAllowanceUsd: 4.6,
  billingUrl: 'https://studio.shogo.ai/billing',
}

describe('renderPriceChangeEmail — Business price cut', () => {
  const email = renderPriceChangeEmail(BASE)

  it('leads with the lower price in the subject', () => {
    expect(email.subject).toBe('Your Shogo Business plan is going down to $16 per seat')
  })

  it('gives the exact switch date and says nothing changes before it', () => {
    expect(email.html).toContain('2026-12-08')
    expect(email.html).toContain('Nothing changes before that date')
    expect(email.text).toContain('2026-12-08')
  })

  it('states the weekly per-seat allowance', () => {
    expect(email.html).toContain('$4.60 of AI usage a week')
  })

  it('explains the warnings and the overage path', () => {
    expect(email.html).toContain('80%')
    expect(email.html).toContain('100%')
    expect(email.html).toContain('metered overage')
    expect(email.html).toContain('raw provider cost plus 20%')
  })

  it('names the workspace and links to billing', () => {
    expect(email.html).toContain('Acme Corp')
    expect(email.html).toContain('https://studio.shogo.ai/billing')
  })

  it('renders a plain-text alternative with no tags', () => {
    expect(email.text).not.toContain('<')
    expect(email.text).toContain('$16 per month instead of $40')
  })
})

describe('renderPriceChangeEmail — Basic (same price, more AI)', () => {
  const email = renderPriceChangeEmail({ ...BASE, planName: 'Basic', fromPriceUsd: 8, toPriceUsd: 8, weeklyAllowanceUsd: 2.3 })

  it('says more AI at the same price', () => {
    expect(email.subject).toBe('More included AI on your Shogo Basic plan — same price')
    expect(email.html).toContain('More included AI, same price')
  })

  it('states the $2.30 weekly allowance', () => {
    expect(email.html).toContain('$2.30 of AI usage a week')
  })
})

describe('renderPriceChangeEmail — trial conversion', () => {
  const email = renderPriceChangeEmail({ ...BASE, trial: true })

  it('says the trial converts at $16, not $40', () => {
    expect(email.subject).toBe(
      'Your Business trial will be billed at $16 per seat, not $40',
    )
    expect(email.html).toContain('not the $40 you signed up at')
  })
})

describe('renderPriceChangeEmail — annual interval', () => {
  it('says per year for an annual switch', () => {
    const email = renderPriceChangeEmail({
      ...BASE,
      fromPriceUsd: 400,
      toPriceUsd: 156,
      interval: 'year',
    })
    expect(email.html).toContain('$156 per year')
    expect(email.html).toContain('instead of $400')
  })
})
