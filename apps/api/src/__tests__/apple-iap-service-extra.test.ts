// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Coverage extras for src/services/apple-iap.service.ts:
//   - verifyAndDecodeJws strict-mode error branches (x5c parse failure)
//   - decodeJwsPayloadUnverified malformed-input paths via the skip-verify entrypoint
//   - handleAppStoreNotification:
//       * signedTransactionInfo JWS verification failure
//       * signedRenewalInfo JWS verification failure (processing continues)
//       * autoRenewStatus number updates cancelAtPeriodEnd
//       * notificationType DID_CHANGE_RENEWAL_STATUS / DID_CHANGE_RENEWAL_PREF (status unchanged)
//       * unknown notificationType with past expiry → past_due
//       * SUBSCRIBED with past expiry → past_due (not active)

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const subscriptions = new Map<string, any>()
function reset() { subscriptions.clear() }

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    subscription: {
      findUnique: async (args: any) => {
        if (args.where.stripeSubscriptionId) {
          for (const s of subscriptions.values()) {
            if (s.stripeSubscriptionId === args.where.stripeSubscriptionId) return s
          }
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
  },
}))

mock.module('../services/billing.service', () => ({ syncFromStripe: async () => {} }))

process.env.APPLE_IAP_SHARED_SECRET = 'secret'
process.env.APPLE_IAP_SKIP_JWS_VERIFY = '1'

const svc = await import('../services/apple-iap.service')

const NOW = Date.now()
const FUTURE = NOW + 30 * 24 * 60 * 60 * 1000
const PAST = NOW - 30 * 24 * 60 * 60 * 1000

function makeJwsLike(payload: Record<string, any>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = Buffer.from('fake-sig').toString('base64url')
  return `${header}.${body}.${sig}`
}

function seedSubscription(over: Partial<any> = {}) {
  const sub = {
    workspaceId: 'ws_1',
    stripeSubscriptionId: 'apple:otx_1',
    planId: 'pro',
    status: 'active',
    cancelAtPeriodEnd: false,
    currentPeriodEnd: new Date(FUTURE),
    updatedAt: new Date(0),
    seats: 1,
    billingInterval: 'month',
    ...over,
  }
  subscriptions.set(sub.stripeSubscriptionId, sub)
  return sub
}

beforeEach(() => {
  reset()
  process.env.APPLE_IAP_SHARED_SECRET = 'secret'
  process.env.APPLE_IAP_SKIP_JWS_VERIFY = '1'
})

// ─── verifyAndDecodeJws — additional skip-mode / strict-mode edges ─────

describe('verifyAndDecodeJws — skip-mode + strict-mode edges', () => {
  test('skip-mode: JWS with only one part throws payload decode failed', () => {
    expect(() => svc.verifyAndDecodeJws('onlyOnePart')).toThrow(/decode/i)
  })

  test('skip-mode: JWS whose payload is not valid JSON throws decode failed', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url')
    const body = Buffer.from('not json at all').toString('base64url')
    const jws = `${header}.${body}.${Buffer.from('sig').toString('base64url')}`
    expect(() => svc.verifyAndDecodeJws(jws)).toThrow(/decode/i)
  })

  test('strict-mode: x5c entries that are not valid X509 certs → JwsVerificationError', () => {
    delete process.env.APPLE_IAP_SKIP_JWS_VERIFY
    // Three-part JWS, ES256, x5c array of garbage base64 (parses but not a cert).
    const header = Buffer.from(JSON.stringify({
      alg: 'ES256',
      x5c: ['ZmFrZWNlcnQ=', 'ZmFrZWNlcnQ='], // "fakecert" base64 — not a real cert
    })).toString('base64url')
    const body = Buffer.from(JSON.stringify({})).toString('base64url')
    const sig = Buffer.from('xxx').toString('base64url')
    expect(() => svc.verifyAndDecodeJws(`${header}.${body}.${sig}`)).toThrow(/x5c parse failed/i)
  })

  test('strict-mode: empty x5c array → JwsVerificationError', () => {
    delete process.env.APPLE_IAP_SKIP_JWS_VERIFY
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', x5c: [] })).toString('base64url')
    const body = Buffer.from(JSON.stringify({})).toString('base64url')
    expect(() => svc.verifyAndDecodeJws(`${header}.${body}.sig`)).toThrow(/x5c/i)
  })

  test('strict-mode: x5c with single cert (length < 2) → JwsVerificationError', () => {
    delete process.env.APPLE_IAP_SKIP_JWS_VERIFY
    const header = Buffer.from(JSON.stringify({
      alg: 'ES256', x5c: ['ZmFrZQ=='],
    })).toString('base64url')
    const body = Buffer.from(JSON.stringify({})).toString('base64url')
    expect(() => svc.verifyAndDecodeJws(`${header}.${body}.sig`)).toThrow(/x5c/i)
  })

  test('strict-mode: x5c entries of wrong type (not strings) → JwsVerificationError', () => {
    delete process.env.APPLE_IAP_SKIP_JWS_VERIFY
    const header = Buffer.from(JSON.stringify({
      alg: 'ES256', x5c: [123, 456],
    })).toString('base64url')
    const body = Buffer.from(JSON.stringify({})).toString('base64url')
    expect(() => svc.verifyAndDecodeJws(`${header}.${body}.sig`)).toThrow(/x5c/i)
  })
})

// ─── handleAppStoreNotification — additional branches ─────────────────

describe('handleAppStoreNotification — additional branches', () => {
  function makeNotificationJws(
    type: string,
    txOver: Partial<any> = {},
    opts: {
      renewal?: Record<string, any>
      signedDate?: number
      mangleTransaction?: boolean
      mangleRenewal?: boolean
    } = {},
  ) {
    const tx = opts.mangleTransaction
      ? 'broken.jws.shape'
      : makeJwsLike({
          originalTransactionId: 'otx_1',
          productId: 'ai.shogo.app.pro.monthly',
          expiresDate: FUTURE,
          ...txOver,
        })
    const data: any = { signedTransactionInfo: tx }
    if (opts.renewal !== undefined) {
      data.signedRenewalInfo = opts.mangleRenewal
        ? 'broken.jws.shape'
        : makeJwsLike(opts.renewal)
    }
    return makeJwsLike({
      notificationType: type,
      signedDate: opts.signedDate ?? Date.now(),
      data,
    })
  }

  test('signedTransactionInfo JWS verification failure → ok=false, reason=jws_verification_failed', async () => {
    seedSubscription()
    const wrapper = makeJwsLike({
      notificationType: 'SUBSCRIBED',
      signedDate: Date.now(),
      data: { signedTransactionInfo: 'not-a-jws-at-all' },
    })
    const out = await svc.handleAppStoreNotification(wrapper)
    expect(out).toMatchObject({
      ok: false,
      notificationType: 'SUBSCRIBED',
      reason: 'jws_verification_failed',
    })
  })

  test('signedRenewalInfo JWS verification failure → processing continues; status still updates', async () => {
    seedSubscription({ status: 'canceled', currentPeriodEnd: new Date(0) })
    // SUBSCRIBED with FUTURE expiry → status should flip to 'active' even
    // though the renewal JWS is broken (we swallow that error).
    const jws = makeNotificationJws('SUBSCRIBED', {}, { mangleRenewal: true, renewal: { autoRenewStatus: 0 } })
    const out = await svc.handleAppStoreNotification(jws)
    expect(out).toEqual({ ok: true, notificationType: 'SUBSCRIBED', processed: true })
    expect(subscriptions.get('apple:otx_1').status).toBe('active')
    // cancelAtPeriodEnd untouched because renewal decode failed.
    expect(subscriptions.get('apple:otx_1').cancelAtPeriodEnd).toBe(false)
  })

  test('signedRenewalInfo with autoRenewStatus=0 → cancelAtPeriodEnd flips to true', async () => {
    seedSubscription({ cancelAtPeriodEnd: false })
    const jws = makeNotificationJws('DID_CHANGE_RENEWAL_STATUS', {}, { renewal: { autoRenewStatus: 0 } })
    const out = await svc.handleAppStoreNotification(jws)
    expect(out).toEqual({ ok: true, notificationType: 'DID_CHANGE_RENEWAL_STATUS', processed: true })
    const sub = subscriptions.get('apple:otx_1')
    expect(sub.cancelAtPeriodEnd).toBe(true)
    // DID_CHANGE_RENEWAL_STATUS does NOT touch status.
    expect(sub.status).toBe('active')
  })

  test('signedRenewalInfo with autoRenewStatus=1 → cancelAtPeriodEnd is false', async () => {
    seedSubscription({ cancelAtPeriodEnd: true })
    const jws = makeNotificationJws('DID_CHANGE_RENEWAL_PREF', {}, { renewal: { autoRenewStatus: 1 } })
    const out = await svc.handleAppStoreNotification(jws)
    expect(out.processed).toBe(true)
    expect(subscriptions.get('apple:otx_1').cancelAtPeriodEnd).toBe(false)
  })

  test('renewal payload without numeric autoRenewStatus leaves cancelAtPeriodEnd unchanged', async () => {
    seedSubscription({ cancelAtPeriodEnd: true })
    const jws = makeNotificationJws('DID_CHANGE_RENEWAL_PREF', {}, { renewal: { autoRenewStatus: 'NOT_A_NUMBER' as any } })
    await svc.handleAppStoreNotification(jws)
    expect(subscriptions.get('apple:otx_1').cancelAtPeriodEnd).toBe(true)
  })

  test('SUBSCRIBED with past expiry → status=past_due (not active)', async () => {
    seedSubscription({ status: 'active', currentPeriodEnd: new Date(FUTURE) })
    const jws = makeNotificationJws('SUBSCRIBED', { expiresDate: PAST })
    const out = await svc.handleAppStoreNotification(jws)
    expect(out.processed).toBe(true)
    expect(subscriptions.get('apple:otx_1').status).toBe('past_due')
  })

  test('Unknown notificationType with past expiry → status=past_due (conservative refresh)', async () => {
    seedSubscription({ status: 'active' })
    const jws = makeNotificationJws('FUTURE_UNKNOWN_EVENT', { expiresDate: PAST })
    const out = await svc.handleAppStoreNotification(jws)
    expect(out).toEqual({ ok: true, notificationType: 'FUTURE_UNKNOWN_EVENT', processed: true })
    expect(subscriptions.get('apple:otx_1').status).toBe('past_due')
  })

  test('Unknown notificationType with future expiry → status unchanged', async () => {
    seedSubscription({ status: 'active' })
    const jws = makeNotificationJws('FUTURE_UNKNOWN_EVENT', { expiresDate: FUTURE })
    await svc.handleAppStoreNotification(jws)
    expect(subscriptions.get('apple:otx_1').status).toBe('active')
  })

  test('expiresDate missing on transaction → falls back to existing.currentPeriodEnd', async () => {
    seedSubscription({ status: 'canceled', currentPeriodEnd: new Date(FUTURE) })
    const tx = makeJwsLike({
      originalTransactionId: 'otx_1',
      productId: 'ai.shogo.app.pro.monthly',
      // no expiresDate
    })
    const wrapper = makeJwsLike({
      notificationType: 'SUBSCRIBED',
      signedDate: Date.now(),
      data: { signedTransactionInfo: tx },
    })
    const out = await svc.handleAppStoreNotification(wrapper)
    expect(out.processed).toBe(true)
    // FUTURE-based currentPeriodEnd → status=active.
    expect(subscriptions.get('apple:otx_1').status).toBe('active')
  })

  test('productId change on the transaction is remapped onto the subscription', async () => {
    seedSubscription({ planId: 'starter', billingInterval: 'month' })
    const jws = makeNotificationJws('DID_RENEW', {
      productId: 'ai.shogo.app.pro.annual',
    })
    await svc.handleAppStoreNotification(jws)
    const sub = subscriptions.get('apple:otx_1')
    // resolveProduct mapped the new productId to the pro/annual plan.
    expect(sub.planId).toBe('pro')
    expect(sub.billingInterval).toBe('annual')
  })

  test('unknown productId on the transaction is NOT remapped (existing plan stays)', async () => {
    seedSubscription({ planId: 'starter', billingInterval: 'month' })
    const jws = makeNotificationJws('DID_RENEW', { productId: 'ai.shogo.app.MYSTERY' })
    await svc.handleAppStoreNotification(jws)
    const sub = subscriptions.get('apple:otx_1')
    expect(sub.planId).toBe('starter')
    expect(sub.billingInterval).toBe('month')
  })
})
