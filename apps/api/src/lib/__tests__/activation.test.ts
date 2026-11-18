// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Activation (the Meta `Activated` event): set once, on a user's 3rd chat
 * message or first preview, and reported exactly once even when turns race.
 */
import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test'

type UserRow = { id: string; email: string; createdAt: Date; activatedAt: Date | null; activationMessages: number }
const users = new Map<string, UserRow>()

const prismaMock = {
  user: {
    updateMany: mock(async ({ where, data }: any) => {
      const u = users.get(where.id)
      if (!u || (where.activatedAt === null && u.activatedAt !== null)) return { count: 0 }
      if (data.activationMessages?.increment) u.activationMessages += data.activationMessages.increment
      if (data.activatedAt) u.activatedAt = data.activatedAt
      return { count: 1 }
    }),
    findUnique: mock(async ({ where }: any) => users.get(where.id) ?? null),
  },
  signupAttribution: {
    findUnique: mock(async () => ({ fbp: 'fb.1.1.1', fbc: null, clientIp: '203.0.113.1', userAgent: 'UA', funnel: 'f1', utmContent: 'ad-1' })),
  },
  subscription: { findFirst: mock(async () => ({ workspaceId: 'ws-1', planId: 'pro' })) },
  member: { findMany: mock(async () => [{ userId: 'u-pay', isBillingAdmin: true }]) },
}
mock.module('../prisma', () => ({ prisma: prismaMock }))

const sent: any[] = []
const realFetch = globalThis.fetch
const env = { ...process.env }
process.env.META_PIXEL_ID = '1'
process.env.META_CAPI_TOKEN = 't'
globalThis.fetch = mock(async (_u: any, init: any) => {
  sent.push(JSON.parse(init.body))
  return new Response(JSON.stringify({ events_received: 1 }), { status: 200 })
}) as any

const { recordActivationMessage, markActivated, reportFirstPayment, ACTIVATION_MESSAGE_THRESHOLD } = await import('../activation')

const flush = () => new Promise((r) => setTimeout(r, 5))

beforeEach(() => {
  users.clear()
  sent.length = 0
  users.set('u1', { id: 'u1', email: 'a@b.co', createdAt: new Date(Date.now() - 2 * 36e5), activatedAt: null, activationMessages: 0 })
})

afterAll(() => {
  globalThis.fetch = realFetch
  process.env = env
})

describe('recordActivationMessage', () => {
  test(`activates on message ${ACTIVATION_MESSAGE_THRESHOLD}, not before, and reports once`, async () => {
    expect(await recordActivationMessage('u1')).toBe(false)
    expect(await recordActivationMessage('u1')).toBe(false)
    expect(users.get('u1')!.activatedAt).toBeNull()
    expect(await recordActivationMessage('u1')).toBe(true)
    expect(users.get('u1')!.activatedAt).toBeInstanceOf(Date)
    expect(await recordActivationMessage('u1')).toBe(false)
    await flush()
    expect(sent).toHaveLength(1)
    const ev = sent[0].data[0]
    expect(ev.event_name).toBe('Activated')
    expect(ev.event_id).toBe('activated_u1')
    expect(ev.custom_data).toMatchObject({ reason: 'messages', funnel: 'f1', utm_content: 'ad-1', hours_since_signup: 2 })
    expect(ev.user_data.fbp).toBe('fb.1.1.1')
  })

  test('the counter stops once activated', async () => {
    await markActivated('u1', 'preview')
    await recordActivationMessage('u1')
    expect(users.get('u1')!.activationMessages).toBe(0)
  })

  test('system and anonymous turns never count', async () => {
    expect(await recordActivationMessage('system')).toBe(false)
    expect(await recordActivationMessage(null)).toBe(false)
    expect(prismaMock.user.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'system' }) }))
  })

  test('a database failure resolves false, never throws into the chat turn', async () => {
    prismaMock.user.updateMany.mockImplementationOnce(async () => { throw new Error('db down') })
    expect(await recordActivationMessage('u1')).toBe(false)
  })
})

describe('markActivated', () => {
  test('a second activation (another reason, a racing turn) is a no-op', async () => {
    expect(await markActivated('u1', 'preview')).toBe(true)
    expect(await markActivated('u1', 'messages')).toBe(false)
    await flush()
    expect(sent).toHaveLength(1)
    expect(sent[0].data[0].custom_data.reason).toBe('preview')
  })
})

describe('reportFirstPayment', () => {
  test('sends Subscribe + Purchase for the billing admin, ids derived from the invoice', async () => {
    users.set('u-pay', { id: 'u-pay', email: 'pay@x.co', createdAt: new Date(), activatedAt: null, activationMessages: 0 })
    await reportFirstPayment({ stripeCustomerId: 'cus_1', invoiceId: 'in_9', amountPaidCents: 2000, currency: 'usd' })
    expect(sent).toHaveLength(1)
    const [sub, purchase] = sent[0].data
    expect(sub.event_name).toBe('Subscribe')
    expect(sub.event_id).toBe('subscribe_in_9')
    expect(sub.custom_data).toMatchObject({ value: 20, currency: 'USD', content_name: 'pro', predicted_ltv: 240 })
    expect(purchase.event_name).toBe('Purchase')
    expect(purchase.event_id).toBe('purchase_in_9')
  })

  test('no subscription for the customer: nothing is sent', async () => {
    prismaMock.subscription.findFirst.mockImplementationOnce(async () => null as any)
    await reportFirstPayment({ stripeCustomerId: 'cus_x', invoiceId: 'in_x', amountPaidCents: 100 })
    expect(sent).toHaveLength(0)
  })
})
