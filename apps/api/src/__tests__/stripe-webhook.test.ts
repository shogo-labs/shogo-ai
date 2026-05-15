// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `src/webhooks/stripe.ts`.
 *
 * Covers:
 *   - isBillingError type guard
 *   - stripeWebhookHandler:
 *       • signature verification failure → 400
 *       • unexpected processWebhookEvent throw → 500
 *       • subscription.created sync (with + without optional fields → defaults)
 *       • subscription.updated sync
 *       • subscription.deleted → status=canceled
 *       • invoice.payment_failed → logged, no store call
 *       • missing subscriptionId → logged, no store call, 200
 *       • unknown event type → 200, no store call
 *       • business-logic error inside store → still 200 (no Stripe retries)
 *   - Default export equals named export
 */

import { describe, expect, mock, test } from 'bun:test'
import {
  isBillingError,
  stripeWebhookHandler,
  default as defaultExport,
  type WebhookEvent,
  type IBillingService,
  type StripeWebhookConfig,
} from '../webhooks/stripe'

// ─── Minimal Hono Context stub ────────────────────────────────────────

type Captured = { status?: number; body?: any }
function fakeContext(payload: string, signature: string | null) {
  const captured: Captured = {}
  const ctx: any = {
    req: {
      text: async () => payload,
      header: (name: string) =>
        name === 'stripe-signature' ? (signature ?? undefined) : undefined,
    },
    json: (body: any, status?: number) => {
      captured.status = status ?? 200
      captured.body = body
      return { status: captured.status, body }
    },
  }
  return { ctx, captured }
}

function buildHandler(overrides: {
  billing?: Partial<IBillingService>
  store?: Partial<StripeWebhookConfig['billingStore']>
}) {
  const billing: IBillingService = {
    processWebhookEvent: overrides.billing?.processWebhookEvent ?? (async () => {
      throw new Error('not configured')
    }),
  }
  const store: StripeWebhookConfig['billingStore'] = {
    syncFromStripe: overrides.store?.syncFromStripe ?? (async () => {}),
    allocateMonthlyIncluded: overrides.store?.allocateMonthlyIncluded,
  }
  return { handler: stripeWebhookHandler({ billingService: billing, billingStore: store }), store }
}

// ─── isBillingError ───────────────────────────────────────────────────

describe('isBillingError', () => {
  test('true for Error with code field', () => {
    const e = Object.assign(new Error('x'), { code: 'webhook_failed' })
    expect(isBillingError(e)).toBe(true)
  })

  test('false for plain Error', () => {
    expect(isBillingError(new Error('x'))).toBe(false)
  })

  test('false for non-Error values with code', () => {
    expect(isBillingError({ code: 'x' })).toBe(false)
    expect(isBillingError(null)).toBe(false)
    expect(isBillingError('boom')).toBe(false)
  })
})

// ─── default export ───────────────────────────────────────────────────

describe('default export', () => {
  test('equals the named stripeWebhookHandler', () => {
    expect(defaultExport).toBe(stripeWebhookHandler)
  })
})

// ─── stripeWebhookHandler ─────────────────────────────────────────────

describe('stripeWebhookHandler', () => {
  test('signature verification failure → 400 + "Invalid signature"', async () => {
    const procEvent = mock(async () => {
      const e = Object.assign(new Error('bad sig'), { code: 'webhook_verification_failed' })
      throw e
    })
    const sync = mock(async () => {})
    const { handler } = buildHandler({
      billing: { processWebhookEvent: procEvent as any },
      store: { syncFromStripe: sync },
    })
    const { ctx, captured } = fakeContext('payload', 'whsec_bad')
    await handler(ctx)
    expect(captured.status).toBe(400)
    expect(captured.body).toEqual({ error: 'Invalid signature' })
    expect(sync).not.toHaveBeenCalled()
  })

  test('non-billing-error from processWebhookEvent → 500', async () => {
    const procEvent = mock(async () => {
      throw new Error('boom')
    })
    const { handler } = buildHandler({
      billing: { processWebhookEvent: procEvent as any },
    })
    const { ctx, captured } = fakeContext('payload', 'sig')
    await handler(ctx)
    expect(captured.status).toBe(500)
    expect(captured.body).toEqual({ error: 'Internal error' })
  })

  test('subscription.created: forwards all fields to syncFromStripe', async () => {
    const event: WebhookEvent = {
      type: 'subscription.created',
      data: {
        subscriptionId: 'sub_1',
        workspaceId: 'ws_1',
        planId: 'business',
        status: 'active',
        currentPeriodStart: 1_700_000_000,
        currentPeriodEnd: 1_702_000_000,
      },
    }
    const procEvent = mock(async () => event)
    const sync = mock(async () => {})
    const { handler } = buildHandler({
      billing: { processWebhookEvent: procEvent as any },
      store: { syncFromStripe: sync },
    })
    const { ctx, captured } = fakeContext('payload', 'sig')
    await handler(ctx)
    expect(captured.status).toBe(200)
    expect(captured.body).toEqual({ received: true })
    expect(sync).toHaveBeenCalledTimes(1)
    expect(sync.mock.calls[0][0]).toMatchObject({
      subscriptionId: 'sub_1',
      workspaceId: 'ws_1',
      planId: 'business',
      status: 'active',
      currentPeriodStart: 1_700_000_000,
      currentPeriodEnd: 1_702_000_000,
      isNew: true,
    })
  })

  test('subscription.created: missing optional fields → defaults (pro/active/now)', async () => {
    const event: WebhookEvent = {
      type: 'subscription.created',
      data: { subscriptionId: 'sub_2', workspaceId: 'ws_2' },
    }
    const sync = mock(async () => {})
    const { handler } = buildHandler({
      billing: { processWebhookEvent: (async () => event) as any },
      store: { syncFromStripe: sync },
    })
    const { ctx } = fakeContext('payload', 'sig')
    await handler(ctx)
    const arg = sync.mock.calls[0][0]
    expect(arg.planId).toBe('pro')
    expect(arg.status).toBe('active')
    expect(typeof arg.currentPeriodStart).toBe('number')
    expect(arg.currentPeriodEnd).toBeGreaterThan(arg.currentPeriodStart)
  })

  test('subscription.created: missing subscriptionId → no store call, still 200', async () => {
    const event: WebhookEvent = {
      type: 'subscription.created',
      data: { workspaceId: 'ws_only' },
    }
    const sync = mock(async () => {})
    const { handler } = buildHandler({
      billing: { processWebhookEvent: (async () => event) as any },
      store: { syncFromStripe: sync },
    })
    const { ctx, captured } = fakeContext('payload', 'sig')
    await handler(ctx)
    expect(captured.status).toBe(200)
    expect(sync).not.toHaveBeenCalled()
  })

  test('subscription.created: missing workspaceId → no store call', async () => {
    const event: WebhookEvent = {
      type: 'subscription.created',
      data: { subscriptionId: 'sub_x' },
    }
    const sync = mock(async () => {})
    const { handler } = buildHandler({
      billing: { processWebhookEvent: (async () => event) as any },
      store: { syncFromStripe: sync },
    })
    const { ctx } = fakeContext('payload', 'sig')
    await handler(ctx)
    expect(sync).not.toHaveBeenCalled()
  })

  test('subscription.updated: forwards isNew=false', async () => {
    const event: WebhookEvent = {
      type: 'subscription.updated',
      data: { subscriptionId: 'sub_u', workspaceId: 'ws_u', planId: 'pro', status: 'past_due' },
    }
    const sync = mock(async () => {})
    const { handler } = buildHandler({
      billing: { processWebhookEvent: (async () => event) as any },
      store: { syncFromStripe: sync },
    })
    const { ctx, captured } = fakeContext('payload', 'sig')
    await handler(ctx)
    expect(captured.status).toBe(200)
    const arg = sync.mock.calls[0][0]
    expect(arg.isNew).toBe(false)
    expect(arg.status).toBe('past_due')
  })

  test('subscription.updated: missing subscriptionId → no store call', async () => {
    const event: WebhookEvent = { type: 'subscription.updated', data: {} }
    const sync = mock(async () => {})
    const { handler } = buildHandler({
      billing: { processWebhookEvent: (async () => event) as any },
      store: { syncFromStripe: sync },
    })
    const { ctx, captured } = fakeContext('payload', 'sig')
    await handler(ctx)
    expect(captured.status).toBe(200)
    expect(sync).not.toHaveBeenCalled()
  })

  test('subscription.updated: missing workspaceId → forwards empty string', async () => {
    const event: WebhookEvent = {
      type: 'subscription.updated',
      data: { subscriptionId: 'sub_u' },
    }
    const sync = mock(async () => {})
    const { handler } = buildHandler({
      billing: { processWebhookEvent: (async () => event) as any },
      store: { syncFromStripe: sync },
    })
    await handler(fakeContext('payload', 'sig').ctx)
    expect(sync.mock.calls[0][0].workspaceId).toBe('')
  })

  test('subscription.deleted: forwards status=canceled', async () => {
    const event: WebhookEvent = {
      type: 'subscription.deleted',
      data: { subscriptionId: 'sub_del', workspaceId: 'ws_del' },
    }
    const sync = mock(async () => {})
    const { handler } = buildHandler({
      billing: { processWebhookEvent: (async () => event) as any },
      store: { syncFromStripe: sync },
    })
    await handler(fakeContext('payload', 'sig').ctx)
    const arg = sync.mock.calls[0][0]
    expect(arg.status).toBe('canceled')
    expect(arg.isNew).toBe(false)
  })

  test('subscription.deleted: missing subscriptionId → no store call', async () => {
    const event: WebhookEvent = { type: 'subscription.deleted', data: {} }
    const sync = mock(async () => {})
    const { handler } = buildHandler({
      billing: { processWebhookEvent: (async () => event) as any },
      store: { syncFromStripe: sync },
    })
    await handler(fakeContext('payload', 'sig').ctx)
    expect(sync).not.toHaveBeenCalled()
  })

  test('invoice.payment_failed: logs only, no store call', async () => {
    const event: WebhookEvent = {
      type: 'invoice.payment_failed',
      data: { invoiceId: 'in_1', failureMessage: 'card declined', workspaceId: 'ws_pf' },
    }
    const sync = mock(async () => {})
    const { handler } = buildHandler({
      billing: { processWebhookEvent: (async () => event) as any },
      store: { syncFromStripe: sync },
    })
    const { ctx, captured } = fakeContext('payload', 'sig')
    await handler(ctx)
    expect(captured.status).toBe(200)
    expect(sync).not.toHaveBeenCalled()
  })

  test('unknown event type → 200, no store call', async () => {
    const event = { type: 'subscription.weird' as any, data: { subscriptionId: 'sub_x' } }
    const sync = mock(async () => {})
    const { handler } = buildHandler({
      billing: { processWebhookEvent: (async () => event) as any },
      store: { syncFromStripe: sync },
    })
    const { ctx, captured } = fakeContext('payload', 'sig')
    await handler(ctx)
    expect(captured.status).toBe(200)
    expect(captured.body).toEqual({ received: true })
    expect(sync).not.toHaveBeenCalled()
  })

  test('business-logic throw inside store still returns 200 (no Stripe retries)', async () => {
    const event: WebhookEvent = {
      type: 'subscription.created',
      data: { subscriptionId: 'sub_b', workspaceId: 'ws_b' },
    }
    const sync = mock(async () => {
      throw new Error('db down')
    })
    const { handler } = buildHandler({
      billing: { processWebhookEvent: (async () => event) as any },
      store: { syncFromStripe: sync as any },
    })
    const { ctx, captured } = fakeContext('payload', 'sig')
    await handler(ctx)
    expect(captured.status).toBe(200)
    expect(captured.body).toEqual({ received: true })
  })

  test('reads payload body once and stripe-signature header', async () => {
    const event: WebhookEvent = {
      type: 'subscription.created',
      data: { subscriptionId: 's', workspaceId: 'w' },
    }
    const procEvent = mock(async (payload: string, sig: string) => {
      expect(payload).toBe('the-payload')
      expect(sig).toBe('whsec_abc')
      return event
    })
    const { handler } = buildHandler({ billing: { processWebhookEvent: procEvent as any } })
    await handler(fakeContext('the-payload', 'whsec_abc').ctx)
    expect(procEvent).toHaveBeenCalledTimes(1)
  })

  test('missing stripe-signature header → empty string passed through', async () => {
    const procEvent = mock(async (_p: string, sig: string) => {
      expect(sig).toBe('')
      return { type: 'subscription.created', data: {} } as any
    })
    const { handler } = buildHandler({ billing: { processWebhookEvent: procEvent as any } })
    await handler(fakeContext('p', null).ctx)
    expect(procEvent).toHaveBeenCalled()
  })
})
