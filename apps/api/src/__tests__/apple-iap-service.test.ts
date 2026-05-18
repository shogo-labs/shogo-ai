// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `src/services/apple-iap.service.ts`.
 *
 * Covers all 4 exported surfaces:
 *   - resolveProduct (pure lookup)
 *   - verifyAndDecodeJws (with APPLE_IAP_SKIP_JWS_VERIFY=1 + JWS shape errors)
 *   - verifyAndSyncReceipt (validation + Apple response branching + idempotency)
 *   - handleAppStoreNotification (JWS-skip path covers all event types)
 *
 * Apple's HTTP verify endpoint is mocked via `globalThis.fetch`.
 * `billing.service.syncFromStripe` and `prisma.subscription` are stubbed
 * via `mock.module`.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

// ─── Prisma + billing-service stubs ───────────────────────────────────

let subscriptions: Map<string, any> = new Map()
let lastSyncArgs: any = null
const appleResponseQueue: any[] = []
const fetchCallLog: string[] = []
function reset() {
  subscriptions = new Map()
  lastSyncArgs = null
  appleResponseQueue.length = 0
  fetchCallLog.length = 0
}

const prismaStub: any = {
  subscription: {
    findUnique: async (args: any) => {
      if (args.where.workspaceId) {
        for (const s of subscriptions.values()) {
          if (s.workspaceId === args.where.workspaceId) return s
        }
        return null
      }
      if (args.where.stripeSubscriptionId) {
        for (const s of subscriptions.values()) {
          if (s.stripeSubscriptionId === args.where.stripeSubscriptionId) return s
        }
        return null
      }
      return null
    },
    update: async (args: any) => {
      const existing = Array.from(subscriptions.values()).find(
        (s) => s.stripeSubscriptionId === args.where.stripeSubscriptionId,
      )
      if (!existing) throw new Error('not found')
      Object.assign(existing, args.data, { updatedAt: new Date() })
      return existing
    },
  },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: prismaStub }))
mock.module('../services/billing.service', () => ({
  syncFromStripe: async (args: any) => {
    lastSyncArgs = args
    const stable = args.stripeSubscriptionId
    subscriptions.set(stable, {
      workspaceId: args.workspaceId,
      stripeSubscriptionId: stable,
      planId: args.planId,
      status: args.status,
      cancelAtPeriodEnd: args.cancelAtPeriodEnd ?? false,
      currentPeriodEnd: args.currentPeriodEnd,
      seats: args.seats,
      billingInterval: args.billingInterval,
      updatedAt: new Date(),
    })
  },
}))

// ─── fetch mock for Apple verify endpoint ─────────────────────────────

const originalFetch = globalThis.fetch
;(globalThis as any).fetch = async (url: string) => {
  fetchCallLog.push(String(url))
  const next = appleResponseQueue.shift()
  if (next === undefined) {
    return new Response(JSON.stringify({ status: 21000 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (next instanceof Error) throw next
  return new Response(JSON.stringify(next), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

// Import service AFTER mocks
process.env.APPLE_IAP_SHARED_SECRET = 'secret'
process.env.APPLE_IAP_SKIP_JWS_VERIFY = '1'
const svc = await import('../services/apple-iap.service')

beforeEach(() => {
  reset()
  process.env.APPLE_IAP_SHARED_SECRET = 'secret'
  process.env.APPLE_IAP_SKIP_JWS_VERIFY = '1'
  delete process.env.APPLE_IAP_BUNDLE_ID
})

// ──────────────────────────────────────────────────────────────────────
// resolveProduct
// ──────────────────────────────────────────────────────────────────────

describe('resolveProduct', () => {
  test.each([
    ['ai.shogo.app.basic.monthly', { planId: 'basic', interval: 'monthly' }],
    ['ai.shogo.app.basic.annual', { planId: 'basic', interval: 'annual' }],
    ['ai.shogo.app.pro.monthly', { planId: 'pro', interval: 'monthly' }],
    ['ai.shogo.app.pro.annual', { planId: 'pro', interval: 'annual' }],
    ['ai.shogo.app.business.monthly', { planId: 'business', interval: 'monthly' }],
    ['ai.shogo.app.business.annual', { planId: 'business', interval: 'annual' }],
  ])('maps %s correctly', (productId, expected) => {
    expect(svc.resolveProduct(productId as string)).toEqual(expected as any)
  })

  test('unknown product returns null', () => {
    expect(svc.resolveProduct('com.example.unknown')).toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────
// verifyAndDecodeJws (skip-verify mode)
// ──────────────────────────────────────────────────────────────────────

function makeJwsLike(payload: Record<string, any>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = Buffer.from('fake-sig').toString('base64url')
  return `${header}.${body}.${sig}`
}

describe('verifyAndDecodeJws (skip-verify mode)', () => {
  test('decodes payload when APPLE_IAP_SKIP_JWS_VERIFY=1', () => {
    const jws = makeJwsLike({ hello: 'world', n: 42 })
    expect(svc.verifyAndDecodeJws(jws)).toEqual({ hello: 'world', n: 42 })
  })

  test('throws on malformed JWS (skip-verify still requires base64 parts)', () => {
    expect(() => svc.verifyAndDecodeJws('not-a-jws')).toThrow(/payload decode failed/)
  })

  test('strict mode (skip flag off) requires three dot-separated parts', () => {
    delete process.env.APPLE_IAP_SKIP_JWS_VERIFY
    expect(() => svc.verifyAndDecodeJws('only.two')).toThrow(/3 dot-separated parts/)
  })

  test('strict mode: bad alg → JwsVerificationError', () => {
    delete process.env.APPLE_IAP_SKIP_JWS_VERIFY
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', x5c: ['a', 'b'] })).toString(
      'base64url',
    )
    const body = Buffer.from(JSON.stringify({})).toString('base64url')
    expect(() => svc.verifyAndDecodeJws(`${header}.${body}.sig`)).toThrow(/Unsupported JWS alg/)
  })

  test('strict mode: missing x5c → JwsVerificationError', () => {
    delete process.env.APPLE_IAP_SKIP_JWS_VERIFY
    const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url')
    const body = Buffer.from(JSON.stringify({})).toString('base64url')
    expect(() => svc.verifyAndDecodeJws(`${header}.${body}.sig`)).toThrow(
      /missing or malformed x5c/,
    )
  })

  test('strict mode: header not valid JSON → JwsVerificationError', () => {
    delete process.env.APPLE_IAP_SKIP_JWS_VERIFY
    const header = Buffer.from('not-json').toString('base64url')
    expect(() => svc.verifyAndDecodeJws(`${header}.body.sig`)).toThrow(/not valid JSON/)
  })
})

// ──────────────────────────────────────────────────────────────────────
// verifyAndSyncReceipt — input validation
// ──────────────────────────────────────────────────────────────────────

const RECEIPT = 'base64-receipt-data'
const VALID_ARGS = {
  workspaceId: 'ws_1',
  productId: 'ai.shogo.app.pro.monthly',
  transactionId: 'tx_1',
  transactionReceipt: RECEIPT,
}

describe('verifyAndSyncReceipt — input validation', () => {
  test('rejects empty receipt', async () => {
    const out = await svc.verifyAndSyncReceipt({ ...VALID_ARGS, transactionReceipt: '' })
    expect(out).toEqual({ ok: false, reason: 'transactionReceipt is required and must be a string' })
  })

  test('rejects non-string receipt', async () => {
    const out = await svc.verifyAndSyncReceipt({
      ...VALID_ARGS,
      transactionReceipt: 123 as any,
    })
    expect(out.ok).toBe(false)
  })

  test('rejects receipts larger than 200KB', async () => {
    const big = 'x'.repeat(200_001)
    const out = await svc.verifyAndSyncReceipt({ ...VALID_ARGS, transactionReceipt: big })
    expect(out).toEqual({ ok: false, reason: 'receipt too large (>200000 chars)' })
  })

  test('rejects unknown productId', async () => {
    const out = await svc.verifyAndSyncReceipt({ ...VALID_ARGS, productId: 'com.unknown' })
    expect(out).toEqual({ ok: false, reason: 'Unknown productId: com.unknown' })
  })

  test('throws when APPLE_IAP_SHARED_SECRET is missing (surfaces as reason)', async () => {
    delete process.env.APPLE_IAP_SHARED_SECRET
    const out = await svc.verifyAndSyncReceipt(VALID_ARGS)
    expect(out.ok).toBe(false)
    expect((out as any).reason).toContain('APPLE_IAP_SHARED_SECRET')
  })
})

// ──────────────────────────────────────────────────────────────────────
// verifyAndSyncReceipt — Apple response branching
// ──────────────────────────────────────────────────────────────────────

const NOW = Date.now()
const FUTURE = NOW + 30 * 24 * 60 * 60 * 1000

function makeInfo(over: Partial<any> = {}) {
  return {
    product_id: 'ai.shogo.app.pro.monthly',
    transaction_id: 'tx_1',
    original_transaction_id: 'otx_1',
    purchase_date_ms: String(NOW),
    expires_date_ms: String(FUTURE),
    ...over,
  }
}

describe('verifyAndSyncReceipt — Apple response branching', () => {
  test('Apple non-zero status → ok=false, appleStatus surfaced', async () => {
    appleResponseQueue.push({ status: 21002 })
    const out = await svc.verifyAndSyncReceipt(VALID_ARGS)
    expect(out).toEqual({
      ok: false,
      reason: 'Apple verification rejected',
      appleStatus: 21002,
    })
  })

  test('21007 → retries against sandbox', async () => {
    appleResponseQueue.push({ status: 21007 })
    appleResponseQueue.push({
      status: 0,
      receipt: { bundle_id: 'ai.shogo.app', in_app: [makeInfo()] },
      latest_receipt_info: [makeInfo()],
      pending_renewal_info: [],
    })
    const out = await svc.verifyAndSyncReceipt(VALID_ARGS)
    expect(out.ok).toBe(true)
    expect(fetchCallLog).toHaveLength(2)
    expect(fetchCallLog[0]).toContain('buy.itunes.apple.com')
    expect(fetchCallLog[1]).toContain('sandbox.itunes.apple.com')
  })

  test('Apple fetch throws → ok=false with reason', async () => {
    appleResponseQueue.push(new Error('network down'))
    const out = await svc.verifyAndSyncReceipt(VALID_ARGS)
    expect(out.ok).toBe(false)
    expect((out as any).reason).toContain('Apple verify request failed')
  })

  test('bundle_id mismatch → ok=false', async () => {
    appleResponseQueue.push({
      status: 0,
      receipt: { bundle_id: 'com.evil.app', in_app: [makeInfo()] },
      latest_receipt_info: [makeInfo()],
    })
    const out = await svc.verifyAndSyncReceipt(VALID_ARGS)
    expect(out.ok).toBe(false)
    expect((out as any).reason).toContain('bundle_id mismatch')
  })

  test('custom APPLE_IAP_BUNDLE_ID is honored', async () => {
    process.env.APPLE_IAP_BUNDLE_ID = 'com.shogo.custom'
    appleResponseQueue.push({
      status: 0,
      receipt: { bundle_id: 'com.shogo.custom', in_app: [makeInfo()] },
      latest_receipt_info: [makeInfo()],
    })
    const out = await svc.verifyAndSyncReceipt(VALID_ARGS)
    expect(out.ok).toBe(true)
  })

  test('no matching transaction → ok=false', async () => {
    appleResponseQueue.push({
      status: 0,
      receipt: { bundle_id: 'ai.shogo.app', in_app: [] },
      latest_receipt_info: [],
    })
    const out = await svc.verifyAndSyncReceipt(VALID_ARGS)
    expect(out).toEqual({ ok: false, reason: 'No matching transaction in Apple response' })
  })

  test('app_account_token mismatch → ok=false', async () => {
    appleResponseQueue.push({
      status: 0,
      receipt: { bundle_id: 'ai.shogo.app', in_app: [] },
      latest_receipt_info: [makeInfo({ app_account_token: 'someone-else' })],
    })
    const out = await svc.verifyAndSyncReceipt(VALID_ARGS)
    expect(out).toEqual({ ok: false, reason: 'app_account_token does not match workspaceId' })
  })

  test('app_account_token case-insensitive match passes', async () => {
    appleResponseQueue.push({
      status: 0,
      receipt: { bundle_id: 'ai.shogo.app', in_app: [] },
      latest_receipt_info: [makeInfo({ app_account_token: 'WS_1' })],
    })
    const out = await svc.verifyAndSyncReceipt(VALID_ARGS)
    expect(out.ok).toBe(true)
  })

  test('happy path: calls billingService.syncFromStripe with apple: prefix', async () => {
    appleResponseQueue.push({
      status: 0,
      receipt: { bundle_id: 'ai.shogo.app', in_app: [] },
      latest_receipt_info: [makeInfo()],
    })
    const out = await svc.verifyAndSyncReceipt(VALID_ARGS)
    expect(out.ok).toBe(true)
    expect(lastSyncArgs.stripeSubscriptionId).toBe('apple:otx_1')
    expect(lastSyncArgs.stripeCustomerId).toBe('apple:otx_1')
    expect(lastSyncArgs.seats).toBe(1)
    expect(lastSyncArgs.planId).toBe('pro')
    expect(lastSyncArgs.billingInterval).toBe('monthly')
  })

  test('expired receipt → status=past_due', async () => {
    appleResponseQueue.push({
      status: 0,
      receipt: { bundle_id: 'ai.shogo.app', in_app: [] },
      latest_receipt_info: [makeInfo({ expires_date_ms: String(NOW - 1000) })],
    })
    const out = await svc.verifyAndSyncReceipt(VALID_ARGS)
    expect(out.ok).toBe(true)
    expect((out as any).status).toBe('past_due')
  })

  test('trial period → status=trialing', async () => {
    appleResponseQueue.push({
      status: 0,
      receipt: { bundle_id: 'ai.shogo.app', in_app: [] },
      latest_receipt_info: [makeInfo({ is_trial_period: 'true' })],
    })
    const out = await svc.verifyAndSyncReceipt(VALID_ARGS)
    expect((out as any).status).toBe('trialing')
  })

  test('cancelled receipt → status=canceled', async () => {
    appleResponseQueue.push({
      status: 0,
      receipt: { bundle_id: 'ai.shogo.app', in_app: [] },
      latest_receipt_info: [makeInfo({ cancellation_date_ms: String(NOW - 1000) })],
    })
    const out = await svc.verifyAndSyncReceipt(VALID_ARGS)
    expect((out as any).status).toBe('canceled')
  })

  test('auto_renew_status=0 in renewal info → cancelAtPeriodEnd=true', async () => {
    appleResponseQueue.push({
      status: 0,
      receipt: { bundle_id: 'ai.shogo.app', in_app: [] },
      latest_receipt_info: [makeInfo()],
      pending_renewal_info: [{ original_transaction_id: 'otx_1', auto_renew_status: '0' }],
    })
    await svc.verifyAndSyncReceipt(VALID_ARGS)
    expect(lastSyncArgs.cancelAtPeriodEnd).toBe(true)
  })

  test('billing retry period → status=past_due', async () => {
    appleResponseQueue.push({
      status: 0,
      receipt: { bundle_id: 'ai.shogo.app', in_app: [] },
      latest_receipt_info: [makeInfo({ expires_date_ms: String(NOW - 1000) })],
      pending_renewal_info: [
        { original_transaction_id: 'otx_1', is_in_billing_retry_period: '1' },
      ],
    })
    const out = await svc.verifyAndSyncReceipt(VALID_ARGS)
    expect((out as any).status).toBe('past_due')
  })

  test('idempotency: identical state returns alreadyProcessed=true, no sync', async () => {
    subscriptions.set('apple:otx_1', {
      workspaceId: 'ws_1',
      stripeSubscriptionId: 'apple:otx_1',
      planId: 'pro',
      status: 'active',
      cancelAtPeriodEnd: false,
      currentPeriodEnd: new Date(FUTURE),
      seats: 1,
      updatedAt: new Date(NOW - 1_000_000),
    })
    appleResponseQueue.push({
      status: 0,
      receipt: { bundle_id: 'ai.shogo.app', in_app: [] },
      latest_receipt_info: [makeInfo()],
    })
    lastSyncArgs = null
    const out = await svc.verifyAndSyncReceipt(VALID_ARGS)
    expect(out).toMatchObject({ ok: true, alreadyProcessed: true })
    expect(lastSyncArgs).toBeNull()
  })

  test('falls back to receipt.in_app when latest_receipt_info empty', async () => {
    appleResponseQueue.push({
      status: 0,
      receipt: { bundle_id: 'ai.shogo.app', in_app: [makeInfo()] },
      latest_receipt_info: [],
    })
    const out = await svc.verifyAndSyncReceipt(VALID_ARGS)
    expect(out.ok).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────
// handleAppStoreNotification (skip-verify covers all branches)
// ──────────────────────────────────────────────────────────────────────

function makeNotificationJws(
  type: string,
  txOver: Partial<any> = {},
  opts: { renewal?: Record<string, any>; signedDate?: number } = {},
) {
  const tx = makeJwsLike({
    originalTransactionId: 'otx_1',
    productId: 'ai.shogo.app.pro.monthly',
    expiresDate: FUTURE,
    ...txOver,
  })
  const data: any = { signedTransactionInfo: tx }
  if (opts.renewal) {
    data.signedRenewalInfo = makeJwsLike(opts.renewal)
  }
  return makeJwsLike({
    notificationType: type,
    signedDate: opts.signedDate ?? Date.now(),
    data,
  })
}

describe('handleAppStoreNotification', () => {
  test('JWS verification failure (skip flag off + bad JWS) → ok=false', async () => {
    delete process.env.APPLE_IAP_SKIP_JWS_VERIFY
    const out = await svc.handleAppStoreNotification('not-a-jws')
    expect(out).toEqual({ ok: false, reason: 'jws_verification_failed' })
  })

  test('no signedTransactionInfo → skipped=no_transaction', async () => {
    const jws = makeJwsLike({ notificationType: 'TEST', data: {} })
    const out = await svc.handleAppStoreNotification(jws)
    expect(out).toMatchObject({
      ok: true,
      notificationType: 'TEST',
      processed: false,
      skipped: 'no_transaction',
    })
  })

  test('missing originalTransactionId → ok=false', async () => {
    const tx = makeJwsLike({ productId: 'x' })
    const wrapper = makeJwsLike({
      notificationType: 'SUBSCRIBED',
      signedDate: Date.now(),
      data: { signedTransactionInfo: tx },
    })
    const out = await svc.handleAppStoreNotification(wrapper)
    expect(out).toEqual({
      ok: false,
      notificationType: 'SUBSCRIBED',
      reason: 'missing_originalTransactionId',
    })
  })

  test('no matching subscription → skipped=no_subscription', async () => {
    const jws = makeNotificationJws('SUBSCRIBED')
    const out = await svc.handleAppStoreNotification(jws)
    expect(out).toMatchObject({
      ok: true,
      notificationType: 'SUBSCRIBED',
      processed: false,
      skipped: 'no_subscription',
    })
  })

  test('stale event (signedDate older than existing.updatedAt) → skipped=stale_event', async () => {
    const recent = Date.now()
    subscriptions.set('apple:otx_1', {
      workspaceId: 'ws_1',
      stripeSubscriptionId: 'apple:otx_1',
      planId: 'pro',
      status: 'active',
      cancelAtPeriodEnd: false,
      currentPeriodEnd: new Date(FUTURE),
      updatedAt: new Date(recent),
    })
    const stale = makeNotificationJws('DID_RENEW', {}, { signedDate: recent - 30_000 })
    const out = await svc.handleAppStoreNotification(stale)
    expect(out).toMatchObject({ ok: true, skipped: 'stale_event' })
  })

  test.each([
    ['EXPIRED', 'canceled'],
    ['REVOKE', 'canceled'],
    ['REFUND', 'canceled'],
    ['GRACE_PERIOD_EXPIRED', 'past_due'],
    ['DID_FAIL_TO_RENEW', 'past_due'],
  ])('notificationType=%s sets status=%s', async (type, expected) => {
    subscriptions.set('apple:otx_1', {
      workspaceId: 'ws_1',
      stripeSubscriptionId: 'apple:otx_1',
      planId: 'pro',
      status: 'active',
      cancelAtPeriodEnd: false,
      currentPeriodEnd: new Date(FUTURE),
      updatedAt: new Date(0),
    })
    const jws = makeNotificationJws(type as string)
    const out = await svc.handleAppStoreNotification(jws)
    expect(out).toEqual({ ok: true, notificationType: type, processed: true })
    expect(subscriptions.get('apple:otx_1').status).toBe(expected)
  })

  test('SUBSCRIBED with future expiry → status=active', async () => {
    subscriptions.set('apple:otx_1', {
      workspaceId: 'ws_1',
      stripeSubscriptionId: 'apple:otx_1',
      planId: 'pro',
      status: 'canceled',
      cancelAtPeriodEnd: false,
      currentPeriodEnd: new Date(0),
      updatedAt: new Date(0),
    })
    const jws = makeNotificationJws('SUBSCRIBED')
    const out = await svc.handleAppStoreNotification(jws)
    expect(out.processed).toBe(true)
    expect(subscriptions.get('apple:otx_1').status).toBe('active')
  })

  test('DID_CHANGE_RENEWAL_STATUS with autoRenewStatus=0 → cancelAtPeriodEnd=true', async () => {
    subscriptions.set('apple:otx_1', {
      workspaceId: 'ws_1',
      stripeSubscriptionId: 'apple:otx_1',
      planId: 'pro',
      status: 'active',
      cancelAtPeriodEnd: false,
      currentPeriodEnd: new Date(FUTURE),
      updatedAt: new Date(0),
    })
    const jws = makeNotificationJws('DID_CHANGE_RENEWAL_STATUS', {}, {
      renewal: { autoRenewStatus: 0 },
    })
    await svc.handleAppStoreNotification(jws)
    expect(subscriptions.get('apple:otx_1').cancelAtPeriodEnd).toBe(true)
  })

  test('product change in tx.productId reflects on subscription', async () => {
    subscriptions.set('apple:otx_1', {
      workspaceId: 'ws_1',
      stripeSubscriptionId: 'apple:otx_1',
      planId: 'pro',
      status: 'active',
      cancelAtPeriodEnd: false,
      currentPeriodEnd: new Date(FUTURE),
      billingInterval: 'monthly',
      updatedAt: new Date(0),
    })
    const jws = makeNotificationJws('SUBSCRIBED', {
      productId: 'ai.shogo.app.business.annual',
    })
    await svc.handleAppStoreNotification(jws)
    expect(subscriptions.get('apple:otx_1').planId).toBe('business')
    expect(subscriptions.get('apple:otx_1').billingInterval).toBe('annual')
  })
})

// Keep the original fetch reference reachable so the linter doesn't drop it.
void originalFetch
