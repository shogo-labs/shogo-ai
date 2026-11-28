// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Abandoned-checkout recovery (SHO-615, growth plan §0 G9a).
 *
 * The decision behind the `checkout.session.expired` webhook case: exactly one
 * recovery email per user per plan, ever, with the gates (subscription mode,
 * resolved user, not already subscribed, not opted out, email configured) and the
 * Stripe recovery URL (or a billing fallback). Push/Stripe are faked; the
 * lifecycle ledger runs for real against an in-memory prisma.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'

process.env.BETTER_AUTH_SECRET ||= 'abandoned-checkout-test-secret'
process.env.APP_URL = 'https://app.test'

// ─── in-memory lifecycle ledger (real claim/release dedupe) ──────────────
const ledger = new Map<string, { id: string; userId: string; kind: string }>()

// ─── fake user / subscription state ─────────────────────────────────────
let users: Record<string, { id: string; email: string; lifecycleEmailOptOutAt: Date | null }> = {}
let userByEmail: Record<string, { id: string }> = {}
let subscriptions: Array<{ workspaceId: string; status: string }> = []

mock.module('../../lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: any) => {
        if (where.id) return users[where.id] ?? null
        if (where.email) {
          const hit = userByEmail[where.email]
          return hit ? (users[hit.id] ?? null) : null
        }
        return null
      },
    },
    subscription: {
      findFirst: async ({ where }: any) =>
        subscriptions.find((s) => s.workspaceId === where.workspaceId && where.status.in.includes(s.status)) ?? null,
    },
    lifecycleEmailSend: {
      create: async ({ data }: any) => {
        if (ledger.has(data.id)) {
          const err: any = new Error('Unique constraint failed')
          err.code = 'P2002'
          throw err
        }
        ledger.set(data.id, { id: data.id, userId: data.userId, kind: data.kind })
        return data
      },
      delete: async ({ where }: any) => {
        if (!ledger.has(where.id)) {
          const err: any = new Error('Record not found')
          err.code = 'P2025'
          throw err
        }
        ledger.delete(where.id)
        return {}
      },
    },
  },
}))

// ─── fake email service (also backs lifecycleEmailAllowed) ───────────────
let emailConfigured = true
const sentEmails: any[] = []
let failNextSend = false
mock.module('../email.service', () => ({
  isEmailConfigured: () => emailConfigured,
  sendAbandonedCheckoutEmail: async (params: any) => {
    if (failNextSend) return { success: false, error: 'smtp down' }
    sentEmails.push(params)
    return { success: true }
  },
}))

const { handleCheckoutSessionExpired } = await import('../abandoned-checkout.service')

function session(overrides: Record<string, any> = {}): any {
  return {
    id: 'cs_1',
    mode: 'subscription',
    metadata: { workspaceId: 'ws-1', planId: 'business', billingInterval: 'monthly', userId: 'u-1' },
    customer_email: 'person@example.com',
    customer_details: { email: 'person@example.com' },
    after_expiration: null,
    ...overrides,
  }
}

beforeEach(() => {
  ledger.clear()
  sentEmails.length = 0
  emailConfigured = true
  failNextSend = false
  users = { 'u-1': { id: 'u-1', email: 'person@example.com', lifecycleEmailOptOutAt: null } }
  userByEmail = { 'person@example.com': { id: 'u-1' } }
  subscriptions = []
})

describe('handleCheckoutSessionExpired', () => {
  it('sends exactly one recovery email for an expired subscription session', async () => {
    const out = await handleCheckoutSessionExpired(session())
    expect(out).toEqual({ sent: true })
    expect(sentEmails).toHaveLength(1)
    expect(sentEmails[0]).toMatchObject({
      to: 'person@example.com',
      planName: 'Business',
      intervalLabel: 'monthly',
      offerNoun: 'upgrade',
    })
    expect(ledger.has('abandoned_checkout:u-1:business')).toBe(true)
  })

  it('a redelivery of the same event sends nothing more', async () => {
    await handleCheckoutSessionExpired(session())
    const second = await handleCheckoutSessionExpired(session())
    expect(second).toEqual({ sent: false, reason: 'already_sent' })
    expect(sentEmails).toHaveLength(1)
  })

  it('a second expired session for the same plan is once in total; a different plan sends again', async () => {
    await handleCheckoutSessionExpired(session({ id: 'cs_a' }))
    await handleCheckoutSessionExpired(session({ id: 'cs_b' }))
    expect(sentEmails).toHaveLength(1)

    const otherPlan = await handleCheckoutSessionExpired(
      session({ id: 'cs_c', metadata: { workspaceId: 'ws-1', planId: 'basic', billingInterval: 'annual', userId: 'u-1' } }),
    )
    expect(otherPlan).toEqual({ sent: true })
    expect(sentEmails).toHaveLength(2)
    expect(sentEmails[1]).toMatchObject({ planName: 'Basic', intervalLabel: 'annual' })
  })

  it('an opted-out user gets none, and no ledger row is written', async () => {
    users['u-1'].lifecycleEmailOptOutAt = new Date()
    const out = await handleCheckoutSessionExpired(session())
    expect(out).toEqual({ sent: false, reason: 'not_allowed' })
    expect(sentEmails).toHaveLength(0)
    expect(ledger.size).toBe(0)
  })

  it('a workspace that is already subscribed gets none', async () => {
    subscriptions = [{ workspaceId: 'ws-1', status: 'trialing' }]
    const out = await handleCheckoutSessionExpired(session())
    expect(out).toEqual({ sent: false, reason: 'already_subscribed' })
    expect(sentEmails).toHaveLength(0)
  })

  it('with email not configured nothing is sent and no ledger row is written', async () => {
    emailConfigured = false
    const out = await handleCheckoutSessionExpired(session())
    expect(out).toEqual({ sent: false, reason: 'not_allowed' })
    expect(sentEmails).toHaveLength(0)
    expect(ledger.size).toBe(0)
  })

  it('ignores a payment-mode session', async () => {
    const out = await handleCheckoutSessionExpired(session({ mode: 'payment' }))
    expect(out).toEqual({ sent: false, reason: 'not_subscription' })
    expect(sentEmails).toHaveLength(0)
  })

  it('uses the recovery URL when present, otherwise the billing fallback', async () => {
    await handleCheckoutSessionExpired(session({ after_expiration: { recovery: { url: 'https://checkout.stripe.com/recover/abc' } } }))
    expect(sentEmails[0].resumeUrl).toBe('https://checkout.stripe.com/recover/abc')

    // Same user + plan is already claimed, so use a fresh plan for the fallback case.
    await handleCheckoutSessionExpired(
      session({ id: 'cs_2', metadata: { workspaceId: 'ws-1', planId: 'basic', billingInterval: 'monthly', userId: 'u-1' } }),
    )
    expect(sentEmails[1].resumeUrl).toBe('https://app.test/billing?workspace=ws-1')
  })

  it('resolves the user from the emailed address when the session lacks userId metadata', async () => {
    const out = await handleCheckoutSessionExpired(
      session({ metadata: { workspaceId: 'ws-1', planId: 'business', billingInterval: 'monthly' } }),
    )
    expect(out).toEqual({ sent: true })
    expect(ledger.has('abandoned_checkout:u-1:business')).toBe(true)
  })

  it('releases the claim when the send fails, so a retry can try again', async () => {
    failNextSend = true
    const out = await handleCheckoutSessionExpired(session())
    expect(out).toEqual({ sent: false, reason: 'send_failed' })
    expect(ledger.size).toBe(0)

    failNextSend = false
    const retry = await handleCheckoutSessionExpired(session())
    expect(retry).toEqual({ sent: true })
    expect(sentEmails).toHaveLength(1)
  })

  it('marks a trial session as a 7-day trial in the copy', async () => {
    await handleCheckoutSessionExpired(
      session({ metadata: { workspaceId: 'ws-1', planId: 'business', billingInterval: 'monthly', userId: 'u-1', trial: 'true' } }),
    )
    expect(sentEmails[0].offerNoun).toBe('7-day trial')
  })
})
