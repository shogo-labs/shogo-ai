// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the mobile-side affiliate API helpers.
 *
 * Strategy: drive the helpers with a fake HttpClient that records calls
 * and returns scripted payloads. This is purely a contract test of the
 * URL / payload mapping — the server logic is covered separately by the
 * route tests in apps/api/src/routes/__tests__/affiliates.test.ts.
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { affiliateApi, buildReferralLink } from '../affiliate-api'

interface Call { method: string; url: string; body?: unknown }

function makeHttp(scriptedResponses: Record<string, any> = {}) {
  const calls: Call[] = []
  const http: any = {
    get: async (url: string) => {
      calls.push({ method: 'GET', url })
      return { data: scriptedResponses[`GET ${url.split('?')[0]}`] ?? scriptedResponses[`GET ${url}`] }
    },
    post: async (url: string, body?: unknown) => {
      calls.push({ method: 'POST', url, body })
      return { data: scriptedResponses[`POST ${url}`] }
    },
  }
  return { http, calls }
}

describe('buildReferralLink', () => {
  test('uses default base', () => {
    expect(buildReferralLink('alice')).toBe('https://shogo.ai/r/alice')
  })

  test('encodes special characters', () => {
    expect(buildReferralLink('al ice')).toBe('https://shogo.ai/r/al%20ice')
  })

  test('respects custom base and strips trailing slash', () => {
    expect(buildReferralLink('bob', 'https://staging.shogo.ai/')).toBe(
      'https://staging.shogo.ai/r/bob',
    )
  })
})

describe('affiliateApi.me', () => {
  test('returns enrolled=false on empty payload', async () => {
    const { http } = makeHttp({})
    const res = await affiliateApi.me(http)
    expect(res).toEqual({ enrolled: false })
  })

  test('returns summary when enrolled', async () => {
    const { http, calls } = makeHttp({
      'GET /api/affiliates/me': {
        enrolled: true,
        affiliate: { id: 'aff_1', code: 'alice' },
        pendingPayoutCents: 1000,
        lifetimePayoutCents: 5000,
        commissionsLast30d: 3,
        clicksLast30d: 12,
        signupsLast30d: 1,
      },
    })
    const res: any = await affiliateApi.me(http)
    expect(res.enrolled).toBe(true)
    expect(res.affiliate.code).toBe('alice')
    expect(calls[0]).toEqual({ method: 'GET', url: '/api/affiliates/me' })
  })
})

describe('affiliateApi.enroll', () => {
  test('posts trimmed payload to enroll endpoint', async () => {
    const { http, calls } = makeHttp({
      'POST /api/affiliates/enroll': { ok: true, affiliate: { id: 'aff_new' } },
    })
    const res = await affiliateApi.enroll(http, {
      termsAccepted: true, parentCode: 'alice', code: 'mycode',
    })
    expect(res?.ok).toBe(true)
    expect(calls[0]).toEqual({
      method: 'POST',
      url: '/api/affiliates/enroll',
      body: { termsAccepted: true, parentCode: 'alice', code: 'mycode' },
    })
  })
})

describe('affiliateApi.listCommissions', () => {
  test('builds query string from filter options', async () => {
    const { http, calls } = makeHttp({
      'GET /api/affiliates/me/commissions': { commissions: [], nextCursor: null },
    })
    await affiliateApi.listCommissions(http, { status: 'approved', limit: 25, cursor: 'c_1' })
    expect(calls[0].url).toBe('/api/affiliates/me/commissions?status=approved&limit=25&cursor=c_1')
  })

  test('omits query when no options given', async () => {
    const { http, calls } = makeHttp({
      'GET /api/affiliates/me/commissions': { commissions: [{ id: 'c1' }], nextCursor: null },
    })
    const res = await affiliateApi.listCommissions(http)
    expect(calls[0].url).toBe('/api/affiliates/me/commissions')
    expect(res.commissions.length).toBe(1)
  })
})

describe('affiliateApi.getDownline', () => {
  test('passes level=all only when requested', async () => {
    const { http, calls } = makeHttp({
      'GET /api/affiliates/me/downline': { downline: [] },
    })
    await affiliateApi.getDownline(http)
    expect(calls[0].url).toBe('/api/affiliates/me/downline')
    await affiliateApi.getDownline(http, { level: 'all' })
    expect(calls[1].url).toBe('/api/affiliates/me/downline?level=all')
  })
})

describe('affiliateApi stripe connect helpers', () => {
  test('onboardStripeConnect posts with empty body', async () => {
    const { http, calls } = makeHttp({
      'POST /api/affiliates/me/stripe-connect/onboard': { onboardUrl: 'https://x/y' },
    })
    const res = await affiliateApi.onboardStripeConnect(http)
    expect(res.onboardUrl).toBe('https://x/y')
    expect(calls[0]).toEqual({
      method: 'POST',
      url: '/api/affiliates/me/stripe-connect/onboard',
      body: {},
    })
  })

  test('submitPayoutDetails forwards the body', async () => {
    const { http, calls } = makeHttp({
      'POST /api/affiliates/me/stripe-connect/details': { ok: true },
    })
    await affiliateApi.submitPayoutDetails(http, { firstName: 'Alice' })
    expect(calls[0].body).toEqual({ firstName: 'Alice' })
  })
})
