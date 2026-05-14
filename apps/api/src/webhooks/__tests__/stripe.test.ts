// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import {
  isBillingError,
  stripeWebhookHandler,
  type WebhookEvent,
  type IBillingService,
} from '../stripe'

function makeStore() {
  const state: { syncCalls: any[]; syncThrow: Error | null } = {
    syncCalls: [],
    syncThrow: null,
  }
  return {
    state,
    syncFromStripe: async (data: any) => {
      if (state.syncThrow) throw state.syncThrow
      state.syncCalls.push(data)
    },
  }
}

function makeService(event: WebhookEvent | (() => never)): IBillingService {
  return {
    processWebhookEvent: async () => {
      if (typeof event === 'function') return event() as any
      return event
    },
  }
}

function makeContext(body: string, signature?: string) {
  return {
    req: {
      text: async () => body,
      header: (h: string) => (h === 'stripe-signature' ? signature : undefined),
    },
    json: (b: any, status?: number) => ({ body: b, status: status ?? 200 }),
  } as any
}

class BillingErr extends Error {
  code: string
  constructor(code: string, msg: string) {
    super(msg)
    this.code = code
  }
}

let logSpy: any
let errorSpy: any
let warnSpy: any

beforeEach(() => {
  logSpy = mock(() => {})
  errorSpy = mock(() => {})
  warnSpy = mock(() => {})
  console.log = logSpy as any
  console.error = errorSpy as any
  console.warn = warnSpy as any
})

afterEach(() => {})

describe('isBillingError', () => {
  it('returns true for Error with code property', () => {
    expect(isBillingError(new BillingErr('x', 'y'))).toBe(true)
  })

  it('returns false for plain Error', () => {
    expect(isBillingError(new Error('x'))).toBe(false)
  })

  it('returns false for non-Error objects even when they have a code', () => {
    expect(isBillingError({ code: 'x', message: 'y' })).toBe(false)
  })

  it('returns false for null/undefined/string', () => {
    expect(isBillingError(null)).toBe(false)
    expect(isBillingError(undefined)).toBe(false)
    expect(isBillingError('oops')).toBe(false)
  })
})

describe('stripeWebhookHandler — signature verification', () => {
  it('returns 400 on webhook_verification_failed', async () => {
    const store = makeStore()
    const handler = stripeWebhookHandler({
      billingService: {
        processWebhookEvent: async () => {
          throw new BillingErr('webhook_verification_failed', 'bad sig')
        },
      },
      billingStore: store,
    })
    const res = await handler(makeContext('{}', 'sig'))
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Invalid signature' })
    expect(errorSpy).toHaveBeenCalled()
  })

  it('returns 500 for unexpected non-billing errors during verification', async () => {
    const store = makeStore()
    const handler = stripeWebhookHandler({
      billingService: {
        processWebhookEvent: async () => {
          throw new Error('boom')
        },
      },
      billingStore: store,
    })
    const res = await handler(makeContext('{}', 'sig'))
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'Internal error' })
  })

  it('returns 500 for billing errors with non-verification codes', async () => {
    const store = makeStore()
    const handler = stripeWebhookHandler({
      billingService: {
        processWebhookEvent: async () => {
          throw new BillingErr('other_code', 'oops')
        },
      },
      billingStore: store,
    })
    const res = await handler(makeContext('{}', 'sig'))
    expect(res.status).toBe(500)
  })

  it('falls back to empty string when stripe-signature header is missing', async () => {
    const store = makeStore()
    let capturedSig = 'preset'
    const handler = stripeWebhookHandler({
      billingService: {
        processWebhookEvent: async (_p, sig) => {
          capturedSig = sig
          throw new BillingErr('webhook_verification_failed', 'bad')
        },
      },
      billingStore: store,
    })
    await handler(makeContext('{}', undefined))
    expect(capturedSig).toBe('')
  })

  it('passes raw payload and signature to billingService.processWebhookEvent', async () => {
    const store = makeStore()
    let capturedPayload = ''
    let capturedSig = ''
    const handler = stripeWebhookHandler({
      billingService: {
        processWebhookEvent: async (p, s) => {
          capturedPayload = p
          capturedSig = s
          return { type: 'subscription.updated', data: { subscriptionId: 'x' } }
        },
      },
      billingStore: store,
    })
    await handler(makeContext('{"a":1}', 'whsec_test'))
    expect(capturedPayload).toBe('{"a":1}')
    expect(capturedSig).toBe('whsec_test')
  })
})

describe('subscription.created', () => {
  it('syncs with isNew=true and returns 200', async () => {
    const store = makeStore()
    const event: WebhookEvent = {
      type: 'subscription.created',
      data: {
        subscriptionId: 'sub_1',
        workspaceId: 'ws_1',
        planId: 'business',
        status: 'active',
        currentPeriodStart: 1000,
        currentPeriodEnd: 2000,
      },
    }
    const handler = stripeWebhookHandler({ billingService: makeService(event), billingStore: store })
    const res = await handler(makeContext('{}', 'sig'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ received: true })
    expect(store.state.syncCalls).toHaveLength(1)
    expect(store.state.syncCalls[0]).toEqual({
      subscriptionId: 'sub_1',
      workspaceId: 'ws_1',
      planId: 'business',
      status: 'active',
      currentPeriodStart: 1000,
      currentPeriodEnd: 2000,
      isNew: true,
    })
  })

  it('defaults missing planId/status/period fields', async () => {
    const store = makeStore()
    const event: WebhookEvent = {
      type: 'subscription.created',
      data: { subscriptionId: 'sub_1', workspaceId: 'ws_1' },
    }
    const before = Date.now()
    const handler = stripeWebhookHandler({ billingService: makeService(event), billingStore: store })
    await handler(makeContext('{}', 'sig'))
    const after = Date.now()
    const d = store.state.syncCalls[0]
    expect(d.planId).toBe('pro')
    expect(d.status).toBe('active')
    expect(d.currentPeriodStart).toBeGreaterThanOrEqual(before)
    expect(d.currentPeriodStart).toBeLessThanOrEqual(after)
    expect(d.currentPeriodEnd - d.currentPeriodStart).toBe(30 * 24 * 60 * 60 * 1000)
  })

  it('skips sync (still 200) when subscriptionId is missing', async () => {
    const store = makeStore()
    const event: WebhookEvent = {
      type: 'subscription.created',
      data: { workspaceId: 'ws_1' },
    }
    const handler = stripeWebhookHandler({ billingService: makeService(event), billingStore: store })
    const res = await handler(makeContext('{}', 'sig'))
    expect(res.status).toBe(200)
    expect(store.state.syncCalls).toHaveLength(0)
    expect(errorSpy).toHaveBeenCalled()
  })

  it('skips sync when workspaceId is missing', async () => {
    const store = makeStore()
    const event: WebhookEvent = {
      type: 'subscription.created',
      data: { subscriptionId: 'sub_1' },
    }
    const handler = stripeWebhookHandler({ billingService: makeService(event), billingStore: store })
    await handler(makeContext('{}', 'sig'))
    expect(store.state.syncCalls).toHaveLength(0)
  })
})

describe('subscription.updated', () => {
  it('calls syncFromStripe with isNew=false', async () => {
    const store = makeStore()
    const event: WebhookEvent = {
      type: 'subscription.updated',
      data: {
        subscriptionId: 'sub_1',
        workspaceId: 'ws_1',
        planId: 'pro',
        status: 'active',
        currentPeriodStart: 1000,
        currentPeriodEnd: 2000,
      },
    }
    const handler = stripeWebhookHandler({ billingService: makeService(event), billingStore: store })
    const res = await handler(makeContext('{}', 'sig'))
    expect(res.status).toBe(200)
    expect(store.state.syncCalls[0].isNew).toBe(false)
    expect(store.state.syncCalls[0].subscriptionId).toBe('sub_1')
  })

  it('defaults workspaceId to empty string (so updates can match by sub id)', async () => {
    const store = makeStore()
    const event: WebhookEvent = {
      type: 'subscription.updated',
      data: { subscriptionId: 'sub_1' },
    }
    const handler = stripeWebhookHandler({ billingService: makeService(event), billingStore: store })
    await handler(makeContext('{}', 'sig'))
    expect(store.state.syncCalls[0].workspaceId).toBe('')
  })

  it('skips when subscriptionId is missing', async () => {
    const store = makeStore()
    const event: WebhookEvent = {
      type: 'subscription.updated',
      data: { workspaceId: 'ws_1' },
    }
    const handler = stripeWebhookHandler({ billingService: makeService(event), billingStore: store })
    await handler(makeContext('{}', 'sig'))
    expect(store.state.syncCalls).toHaveLength(0)
    expect(errorSpy).toHaveBeenCalled()
  })
})

describe('subscription.deleted', () => {
  it("calls syncFromStripe with status='canceled' and isNew=false", async () => {
    const store = makeStore()
    const event: WebhookEvent = {
      type: 'subscription.deleted',
      data: { subscriptionId: 'sub_1', workspaceId: 'ws_1' },
    }
    const handler = stripeWebhookHandler({ billingService: makeService(event), billingStore: store })
    const res = await handler(makeContext('{}', 'sig'))
    expect(res.status).toBe(200)
    expect(store.state.syncCalls[0]).toEqual({
      subscriptionId: 'sub_1',
      workspaceId: 'ws_1',
      status: 'canceled',
      isNew: false,
    })
  })

  it('skips when subscriptionId is missing', async () => {
    const store = makeStore()
    const event: WebhookEvent = {
      type: 'subscription.deleted',
      data: { workspaceId: 'ws_1' },
    }
    const handler = stripeWebhookHandler({ billingService: makeService(event), billingStore: store })
    await handler(makeContext('{}', 'sig'))
    expect(store.state.syncCalls).toHaveLength(0)
  })
})

describe('invoice.payment_failed', () => {
  it('logs a warning and returns 200 without calling sync', async () => {
    const store = makeStore()
    const event: WebhookEvent = {
      type: 'invoice.payment_failed',
      data: { invoiceId: 'inv_1', failureMessage: 'card declined', workspaceId: 'ws_1' },
    }
    const handler = stripeWebhookHandler({ billingService: makeService(event), billingStore: store })
    const res = await handler(makeContext('{}', 'sig'))
    expect(res.status).toBe(200)
    expect(store.state.syncCalls).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalled()
  })
})

describe('unhandled types and business errors', () => {
  it('logs unhandled event type and still returns 200', async () => {
    const store = makeStore()
    const event = {
      type: 'totally.unknown' as any,
      data: {},
    } as WebhookEvent
    const handler = stripeWebhookHandler({ billingService: makeService(event), billingStore: store })
    const res = await handler(makeContext('{}', 'sig'))
    expect(res.status).toBe(200)
    expect(store.state.syncCalls).toHaveLength(0)
    const logged = (logSpy.mock.calls.flat() ?? []).join(' ')
    expect(logged).toContain('Unhandled event type')
  })

  it('returns 200 (no retry) when business logic throws', async () => {
    const store = makeStore()
    store.state.syncThrow = new Error('db down')
    const event: WebhookEvent = {
      type: 'subscription.created',
      data: { subscriptionId: 'sub_1', workspaceId: 'ws_1' },
    }
    const handler = stripeWebhookHandler({ billingService: makeService(event), billingStore: store })
    const res = await handler(makeContext('{}', 'sig'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ received: true })
    const msg = (errorSpy.mock.calls.flat() ?? []).join(' ')
    expect(msg).toContain('Business logic error')
  })
})
