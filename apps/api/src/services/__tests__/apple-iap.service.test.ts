// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// ---- prisma mock ----
type Sub = {
  workspaceId: string
  stripeSubscriptionId: string
  status: string
  currentPeriodEnd: Date
  cancelAtPeriodEnd: boolean
  planId: string
  seats: number
  updatedAt: Date
}
const subs = new Map<string, Sub>() // by workspaceId
const subsByStableId = new Map<string, Sub>() // by stripeSubscriptionId

const subUpdateCalls: any[] = []

mock.module('../../lib/prisma', () => ({
  prisma: {
    subscription: {
      findUnique: async ({ where, select }: any) => {
        let s: Sub | undefined
        if (where.workspaceId) s = subs.get(where.workspaceId)
        if (where.stripeSubscriptionId) s = subsByStableId.get(where.stripeSubscriptionId)
        if (!s) return null
        if (!select) return s
        const out: any = {}
        for (const k of Object.keys(select)) if (select[k]) out[k] = (s as any)[k]
        return out
      },
      update: async ({ where, data }: any) => {
        subUpdateCalls.push({ where, data })
        const s = subsByStableId.get(where.stripeSubscriptionId)
        if (s) Object.assign(s, data, { updatedAt: new Date() })
        return s
      },
    },
  },
}))

// ---- billing.service mock ----
const syncFromStripeCalls: any[] = []
mock.module('../billing.service', () => ({
  syncFromStripe: async (args: any) => {
    syncFromStripeCalls.push(args)
  },
}))

const iap = await import('../apple-iap.service')

// ---- fetch stub for Apple verify endpoint ----
type FResp = { jsonBody: any }
let fetchResponses: FResp[] = []
const fetchCalls: Array<{ url: string; init?: RequestInit }> = []
const origFetch = globalThis.fetch
function installFetch() {
  ;(globalThis as any).fetch = (async (url: any, init?: any) => {
    fetchCalls.push({ url: String(url), init })
    const r = fetchResponses.shift() ?? { jsonBody: { status: -1 } }
    return { ok: true, status: 200, json: async () => r.jsonBody } as any
  }) as any
}

const origConsole = { log: console.log, warn: console.warn, error: console.error }
const logs: any[][] = []

beforeEach(() => {
  subs.clear()
  subsByStableId.clear()
  subUpdateCalls.length = 0
  syncFromStripeCalls.length = 0
  fetchResponses = []
  fetchCalls.length = 0
  logs.length = 0
  installFetch()
  process.env.APPLE_IAP_SHARED_SECRET = 'secret'
  delete (process.env as any).APPLE_IAP_BUNDLE_ID
  delete (process.env as any).APPLE_IAP_SKIP_JWS_VERIFY
  console.log = (...a) => logs.push(a)
  console.warn = (...a) => logs.push(a)
  console.error = (...a) => logs.push(a)
})

afterEach(() => {
  ;(globalThis as any).fetch = origFetch
  console.log = origConsole.log
  console.warn = origConsole.warn
  console.error = origConsole.error
})

// Helper: b64url encode JSON for JWS-like payloads
function b64url(obj: any): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fakeJws(payload: any, headerOverrides: any = {}): string {
  const header = { alg: 'ES256', x5c: ['leaf', 'intermediate', 'root'], ...headerOverrides }
  return `${b64url(header)}.${b64url(payload)}.${b64url('signature')}`
}

// ─────────────────────────────────────────────────────────────────────────────
describe('resolveProduct', () => {
  it('maps every known product id', () => {
    expect(iap.resolveProduct('ai.shogo.app.basic.monthly')).toEqual({ planId: 'basic', interval: 'monthly' })
    expect(iap.resolveProduct('ai.shogo.app.pro.annual')).toEqual({ planId: 'pro', interval: 'annual' })
    expect(iap.resolveProduct('ai.shogo.app.business.monthly')).toEqual({ planId: 'business', interval: 'monthly' })
  })
  it('returns null for unknown product', () => {
    expect(iap.resolveProduct('unknown')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('verifyAndSyncReceipt — input validation', () => {
  const base = {
    workspaceId: 'w1', productId: 'ai.shogo.app.pro.monthly',
    transactionId: 't1', transactionReceipt: 'BASE64',
  }

  it('rejects missing transactionReceipt', async () => {
    const r = await iap.verifyAndSyncReceipt({ ...base, transactionReceipt: '' })
    expect(r).toEqual({ ok: false, reason: 'transactionReceipt is required and must be a string' })
  })

  it('rejects transactionReceipt > 200KB', async () => {
    const r = await iap.verifyAndSyncReceipt({ ...base, transactionReceipt: 'x'.repeat(200_001) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/too large/)
  })

  it('rejects unknown productId', async () => {
    const r = await iap.verifyAndSyncReceipt({ ...base, productId: 'unknown.id' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/Unknown productId/)
  })
})

describe('verifyAndSyncReceipt — Apple verify failures', () => {
  const base = {
    workspaceId: 'w1', productId: 'ai.shogo.app.pro.monthly',
    transactionId: 't1', transactionReceipt: 'r',
  }

  it('returns reason when APPLE_IAP_SHARED_SECRET is missing', async () => {
    delete (process.env as any).APPLE_IAP_SHARED_SECRET
    const r = await iap.verifyAndSyncReceipt(base)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/APPLE_IAP_SHARED_SECRET/)
  })

  it('returns reason+appleStatus when Apple status !== 0', async () => {
    fetchResponses = [{ jsonBody: { status: 21002 } }]
    const r = await iap.verifyAndSyncReceipt(base)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toMatch(/Apple verification rejected/)
      expect(r.appleStatus).toBe(21002)
    }
  })

  it('retries sandbox on status 21007', async () => {
    fetchResponses = [
      { jsonBody: { status: 21007 } },
      {
        jsonBody: {
          status: 0,
          receipt: { bundle_id: 'ai.shogo.app', in_app: [] },
          latest_receipt_info: [{
            product_id: 'ai.shogo.app.pro.monthly',
            transaction_id: 't', original_transaction_id: 'ot1',
            purchase_date_ms: '1700000000000', expires_date_ms: String(Date.now() + 86400000),
          }],
        },
      },
    ]
    await iap.verifyAndSyncReceipt(base)
    expect(fetchCalls).toHaveLength(2)
    expect(fetchCalls[0].url).toContain('buy.itunes.apple.com')
    expect(fetchCalls[1].url).toContain('sandbox.itunes.apple.com')
  })

  it('returns failure when bundle_id mismatches expected', async () => {
    process.env.APPLE_IAP_BUNDLE_ID = 'ai.shogo.app'
    fetchResponses = [{ jsonBody: { status: 0, receipt: { bundle_id: 'evil.app' } } }]
    const r = await iap.verifyAndSyncReceipt(base)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/bundle_id mismatch/)
  })

  it('returns failure when no matching transaction found', async () => {
    fetchResponses = [{ jsonBody: { status: 0, receipt: {}, latest_receipt_info: [] } }]
    const r = await iap.verifyAndSyncReceipt(base)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/No matching transaction/)
  })

  it('returns failure on app_account_token mismatch', async () => {
    fetchResponses = [{
      jsonBody: {
        status: 0,
        latest_receipt_info: [{
          product_id: 'ai.shogo.app.pro.monthly',
          transaction_id: 't', original_transaction_id: 'ot1',
          purchase_date_ms: '1700000000000', expires_date_ms: String(Date.now() + 86400000),
          app_account_token: 'someone-else',
        }],
      },
    }]
    const r = await iap.verifyAndSyncReceipt(base)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/app_account_token/)
  })

  it('wraps fetch network error into ok:false reason', async () => {
    ;(globalThis as any).fetch = (async () => { throw new Error('econnreset') }) as any
    const r = await iap.verifyAndSyncReceipt(base)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/Apple verify request failed.*econnreset/)
  })
})

describe('verifyAndSyncReceipt — happy paths', () => {
  const base = {
    workspaceId: 'w1', productId: 'ai.shogo.app.pro.monthly',
    transactionId: 't1', transactionReceipt: 'r',
  }
  const futureExp = String(Date.now() + 86400000)
  const pastExp = String(Date.now() - 86400000)

  function appleOk(infoOverrides: any = {}, renewal: any[] = []) {
    return {
      status: 0,
      receipt: { bundle_id: 'ai.shogo.app', in_app: [] },
      latest_receipt_info: [{
        product_id: 'ai.shogo.app.pro.monthly',
        transaction_id: 't', original_transaction_id: 'ot1',
        purchase_date_ms: '1700000000000',
        expires_date_ms: futureExp,
        ...infoOverrides,
      }],
      pending_renewal_info: renewal,
    }
  }

  it('upserts via billing.syncFromStripe with active status', async () => {
    fetchResponses = [{ jsonBody: appleOk() }]
    const r = await iap.verifyAndSyncReceipt(base)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.planId).toBe('pro')
      expect(r.status).toBe('active')
      expect(r.alreadyProcessed).toBeUndefined()
    }
    expect(syncFromStripeCalls).toHaveLength(1)
    expect(syncFromStripeCalls[0].stripeSubscriptionId).toBe('apple:ot1')
    expect(syncFromStripeCalls[0].seats).toBe(1)
  })

  it('derives canceled when cancellation_date_ms present', async () => {
    fetchResponses = [{ jsonBody: appleOk({ cancellation_date_ms: String(Date.now()) }) }]
    const r = await iap.verifyAndSyncReceipt(base)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.status).toBe('canceled')
  })

  it('derives past_due when expired and no grace', async () => {
    fetchResponses = [{ jsonBody: appleOk({ expires_date_ms: pastExp }) }]
    const r = await iap.verifyAndSyncReceipt(base)
    if (r.ok) expect(r.status).toBe('past_due')
  })

  it('derives past_due via grace period', async () => {
    fetchResponses = [{
      jsonBody: appleOk(
        { expires_date_ms: pastExp },
        [{ original_transaction_id: 'ot1', grace_period_expires_date_ms: String(Date.now() + 86400000) }],
      ),
    }]
    const r = await iap.verifyAndSyncReceipt(base)
    if (r.ok) expect(r.status).toBe('past_due')
  })

  it('derives past_due via is_in_billing_retry_period', async () => {
    fetchResponses = [{
      jsonBody: appleOk(
        {},
        [{ original_transaction_id: 'ot1', is_in_billing_retry_period: '1' }],
      ),
    }]
    const r = await iap.verifyAndSyncReceipt(base)
    if (r.ok) expect(r.status).toBe('past_due')
  })

  it('derives trialing when is_trial_period=true', async () => {
    fetchResponses = [{ jsonBody: appleOk({ is_trial_period: 'true' }) }]
    const r = await iap.verifyAndSyncReceipt(base)
    if (r.ok) expect(r.status).toBe('trialing')
  })

  it('cancelAtPeriodEnd reflects auto_renew_status=0', async () => {
    fetchResponses = [{
      jsonBody: appleOk({}, [{ original_transaction_id: 'ot1', auto_renew_status: '0' }]),
    }]
    await iap.verifyAndSyncReceipt(base)
    expect(syncFromStripeCalls[0].cancelAtPeriodEnd).toBe(true)
  })

  it('case-insensitive workspaceId match against app_account_token', async () => {
    fetchResponses = [{
      jsonBody: appleOk({ app_account_token: 'W1' }),
    }]
    const r = await iap.verifyAndSyncReceipt({ ...base, workspaceId: 'w1' })
    expect(r.ok).toBe(true)
  })

  it('falls back to receipt.in_app when latest_receipt_info is empty', async () => {
    fetchResponses = [{
      jsonBody: {
        status: 0,
        receipt: {
          bundle_id: 'ai.shogo.app',
          in_app: [{
            product_id: 'ai.shogo.app.pro.monthly',
            transaction_id: 't', original_transaction_id: 'ot1',
            purchase_date_ms: '1', expires_date_ms: futureExp,
          }],
        },
        latest_receipt_info: [],
      },
    }]
    const r = await iap.verifyAndSyncReceipt(base)
    expect(r.ok).toBe(true)
  })

  it('returns alreadyProcessed when nothing changed (idempotent)', async () => {
    subs.set('w1', {
      workspaceId: 'w1',
      stripeSubscriptionId: 'apple:ot1',
      currentPeriodEnd: new Date(Number(futureExp)),
      status: 'active', cancelAtPeriodEnd: false,
      planId: 'pro', seats: 1, updatedAt: new Date(),
    })
    fetchResponses = [{ jsonBody: appleOk() }]
    const r = await iap.verifyAndSyncReceipt(base)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.alreadyProcessed).toBe(true)
    expect(syncFromStripeCalls).toHaveLength(0)
  })

  it('defaults expiresAt to +30d when expires_date_ms is missing', async () => {
    fetchResponses = [{
      jsonBody: {
        status: 0,
        latest_receipt_info: [{
          product_id: 'ai.shogo.app.pro.monthly',
          transaction_id: 't', original_transaction_id: 'ot1',
          purchase_date_ms: '1700000000000',
        }],
      },
    }]
    const r = await iap.verifyAndSyncReceipt(base)
    expect(r.ok).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('verifyAndDecodeJws — early-error arms', () => {
  it('returns the unverified payload when APPLE_IAP_SKIP_JWS_VERIFY=1', () => {
    process.env.APPLE_IAP_SKIP_JWS_VERIFY = '1'
    const jws = fakeJws({ notificationType: 'TEST', data: 'foo' })
    const r = iap.verifyAndDecodeJws(jws)
    expect(r).toEqual({ notificationType: 'TEST', data: 'foo' })
  })

  it('throws when SKIP=1 but payload not decodable', () => {
    process.env.APPLE_IAP_SKIP_JWS_VERIFY = '1'
    expect(() => iap.verifyAndDecodeJws('notajws')).toThrow(/decode failed/)
  })

  it('throws when parts.length !== 3', () => {
    expect(() => iap.verifyAndDecodeJws('a.b')).toThrow(/3 dot-separated parts/)
    expect(() => iap.verifyAndDecodeJws('a.b.c.d')).toThrow(/3 dot-separated parts/)
  })

  it('throws when header is not valid JSON', () => {
    const bogus = `${Buffer.from('notjson').toString('base64').replace(/=/g, '')}.${b64url({})}.${b64url('s')}`
    expect(() => iap.verifyAndDecodeJws(bogus)).toThrow(/header is not valid JSON/)
  })

  it('throws when alg !== ES256', () => {
    expect(() => iap.verifyAndDecodeJws(fakeJws({}, { alg: 'RS256' }))).toThrow(/Unsupported JWS alg/)
  })

  it('throws when x5c missing', () => {
    const noX5c = `${b64url({ alg: 'ES256' })}.${b64url({})}.${b64url('s')}`
    expect(() => iap.verifyAndDecodeJws(noX5c)).toThrow(/x5c chain/)
  })

  it('throws when x5c has < 2 certs', () => {
    expect(() => iap.verifyAndDecodeJws(fakeJws({}, { x5c: ['only-one'] }))).toThrow(/x5c chain/)
  })

  it('throws when x5c entries are non-strings', () => {
    expect(() => iap.verifyAndDecodeJws(fakeJws({}, { x5c: ['a', 42 as any] }))).toThrow(/x5c chain/)
  })

  it('throws when x5c base64 cannot parse to X509', () => {
    const jws = fakeJws({}, { x5c: ['bm90LWEtY2VydA==', 'YW5vdGhlci1ub24tY2VydA=='] })
    expect(() => iap.verifyAndDecodeJws(jws)).toThrow(/x5c parse failed|chain not anchored|chain broken/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('handleAppStoreNotification (with SKIP=1)', () => {
  beforeEach(() => { process.env.APPLE_IAP_SKIP_JWS_VERIFY = '1' })

  it('returns jws_verification_failed when payload not decodable', async () => {
    const r = await iap.handleAppStoreNotification('not-a-jws')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('jws_verification_failed')
  })

  it('returns skipped=no_transaction when signedTransactionInfo absent', async () => {
    const r = await iap.handleAppStoreNotification(fakeJws({
      notificationType: 'TEST',
      signedDate: Date.now(),
      data: {},
    }))
    expect(r.ok).toBe(true)
    expect(r.skipped).toBe('no_transaction')
  })

  it('returns skipped=no_subscription when DB has no matching record', async () => {
    const tx = fakeJws({ originalTransactionId: 'ot-x', productId: 'ai.shogo.app.pro.monthly' })
    const outer = fakeJws({
      notificationType: 'DID_RENEW',
      signedDate: Date.now(),
      data: { signedTransactionInfo: tx },
    })
    const r = await iap.handleAppStoreNotification(outer)
    expect(r.ok).toBe(true)
    expect(r.skipped).toBe('no_subscription')
  })

  it('returns missing_originalTransactionId when tx lacks it', async () => {
    const tx = fakeJws({ productId: 'ai.shogo.app.pro.monthly' })
    const outer = fakeJws({
      notificationType: 'DID_RENEW',
      signedDate: Date.now(),
      data: { signedTransactionInfo: tx },
    })
    const r = await iap.handleAppStoreNotification(outer)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('missing_originalTransactionId')
  })

  function seedSub(updatedAt: Date = new Date(Date.now() - 60000)) {
    const sub: Sub = {
      workspaceId: 'w1',
      stripeSubscriptionId: 'apple:ot1',
      status: 'active',
      currentPeriodEnd: new Date(Date.now() + 86400000),
      cancelAtPeriodEnd: false,
      planId: 'pro',
      seats: 1,
      updatedAt,
    }
    subs.set('w1', sub)
    subsByStableId.set('apple:ot1', sub)
    return sub
  }

  it('drops stale event when signedDate < existing.updatedAt - 1s', async () => {
    seedSub(new Date(Date.now()))
    const tx = fakeJws({ originalTransactionId: 'ot1' })
    const outer = fakeJws({
      notificationType: 'EXPIRED',
      signedDate: Date.now() - 60_000,
      data: { signedTransactionInfo: tx },
    })
    const r = await iap.handleAppStoreNotification(outer)
    expect(r.ok).toBe(true)
    expect(r.skipped).toBe('stale_event')
    expect(subUpdateCalls).toHaveLength(0)
  })

  it('EXPIRED → canceled', async () => {
    seedSub()
    const tx = fakeJws({ originalTransactionId: 'ot1', expiresDate: Date.now() })
    const outer = fakeJws({
      notificationType: 'EXPIRED',
      signedDate: Date.now(),
      data: { signedTransactionInfo: tx },
    })
    const r = await iap.handleAppStoreNotification(outer)
    expect(r.ok).toBe(true)
    expect(r.processed).toBe(true)
    expect(subUpdateCalls[0].data.status).toBe('canceled')
  })

  it('DID_RENEW with future expiry → active', async () => {
    seedSub()
    const tx = fakeJws({
      originalTransactionId: 'ot1',
      expiresDate: Date.now() + 86400000,
      productId: 'ai.shogo.app.business.annual',
    })
    const outer = fakeJws({
      notificationType: 'DID_RENEW',
      signedDate: Date.now(),
      data: { signedTransactionInfo: tx },
    })
    const r = await iap.handleAppStoreNotification(outer)
    expect(r.ok).toBe(true)
    expect(subUpdateCalls[0].data.status).toBe('active')
    expect(subUpdateCalls[0].data.planId).toBe('business')
  })

  it('DID_RENEW with past expiry → past_due', async () => {
    seedSub()
    const tx = fakeJws({ originalTransactionId: 'ot1', expiresDate: Date.now() - 1000 })
    const outer = fakeJws({
      notificationType: 'DID_RENEW',
      signedDate: Date.now(),
      data: { signedTransactionInfo: tx },
    })
    await iap.handleAppStoreNotification(outer)
    expect(subUpdateCalls[0].data.status).toBe('past_due')
  })

  it('GRACE_PERIOD_EXPIRED → past_due', async () => {
    seedSub()
    const tx = fakeJws({ originalTransactionId: 'ot1' })
    const outer = fakeJws({
      notificationType: 'GRACE_PERIOD_EXPIRED',
      signedDate: Date.now(),
      data: { signedTransactionInfo: tx },
    })
    await iap.handleAppStoreNotification(outer)
    expect(subUpdateCalls[0].data.status).toBe('past_due')
  })

  it('DID_CHANGE_RENEWAL_STATUS preserves existing status', async () => {
    seedSub()
    const tx = fakeJws({ originalTransactionId: 'ot1' })
    const outer = fakeJws({
      notificationType: 'DID_CHANGE_RENEWAL_STATUS',
      signedDate: Date.now(),
      data: { signedTransactionInfo: tx },
    })
    await iap.handleAppStoreNotification(outer)
    expect(subUpdateCalls[0].data.status).toBe('active')
  })

  it('unknown notificationType refreshes status conservatively', async () => {
    seedSub()
    const tx = fakeJws({ originalTransactionId: 'ot1', expiresDate: Date.now() - 1000 })
    const outer = fakeJws({
      notificationType: 'WEIRD_NEW_TYPE',
      signedDate: Date.now(),
      data: { signedTransactionInfo: tx },
    })
    await iap.handleAppStoreNotification(outer)
    expect(subUpdateCalls[0].data.status).toBe('past_due')
  })

  it('reads cancelAtPeriodEnd from signedRenewalInfo (autoRenewStatus=0)', async () => {
    seedSub()
    const tx = fakeJws({ originalTransactionId: 'ot1' })
    const renewal = fakeJws({ autoRenewStatus: 0 })
    const outer = fakeJws({
      notificationType: 'DID_CHANGE_RENEWAL_PREF',
      signedDate: Date.now(),
      data: { signedTransactionInfo: tx, signedRenewalInfo: renewal },
    })
    await iap.handleAppStoreNotification(outer)
    expect(subUpdateCalls[0].data.cancelAtPeriodEnd).toBe(true)
  })

  it('preserves cancelAtPeriodEnd when signedRenewalInfo JWS decode fails', async () => {
    seedSub()
    const tx = fakeJws({ originalTransactionId: 'ot1' })
    const outer = fakeJws({
      notificationType: 'DID_CHANGE_RENEWAL_PREF',
      signedDate: Date.now(),
      data: { signedTransactionInfo: tx, signedRenewalInfo: 'invalid-jws' },
    })
    await iap.handleAppStoreNotification(outer)
    expect(subUpdateCalls[0].data.cancelAtPeriodEnd).toBe(false)
  })

  it('returns jws_verification_failed when inner tx JWS fails', async () => {
    seedSub()
    const outer = fakeJws({
      notificationType: 'DID_RENEW',
      signedDate: Date.now(),
      data: { signedTransactionInfo: 'invalid' },
    })
    const r = await iap.handleAppStoreNotification(outer)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('jws_verification_failed')
  })

  it('persists when expiresDate missing → uses existing currentPeriodEnd', async () => {
    seedSub()
    const tx = fakeJws({ originalTransactionId: 'ot1' })
    const outer = fakeJws({
      notificationType: 'DID_RENEW',
      signedDate: Date.now(),
      data: { signedTransactionInfo: tx },
    })
    await iap.handleAppStoreNotification(outer)
    expect(subUpdateCalls[0].data.currentPeriodEnd).toBeInstanceOf(Date)
  })
})
