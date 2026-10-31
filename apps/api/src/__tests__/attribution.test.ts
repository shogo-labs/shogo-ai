// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Attribution Tests
 *
 * Tests source tag derivation and the attribution API endpoint.
 *
 * Run: bun test apps/api/src/__tests__/attribution.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'

const mockUser = { id: 'user-1', email: 'test@example.com', role: 'user' }

const mockPrisma = {
  signupAttribution: {
    upsert: mock(() => Promise.resolve({ id: 'attr-1', userId: 'user-1' })),
    findUnique: mock((): Promise<any> => Promise.resolve(null)),
  },
}

mock.module('../lib/prisma', () => ({ prisma: mockPrisma }))

mock.module('../middleware/auth', () => ({
  // Mirrors the real middleware contract: `authMiddleware` sets the `auth`
  // context var (never `user`), and `requireAuth` reads it.
  authMiddleware: async (c: any, next: any) => {
    // `x-no-auth` exercises the signed-out path without a second module mock.
    if (!c.req.header('x-no-auth')) {
      c.set('auth', { userId: mockUser.id, isAuthenticated: true, via: 'session' })
      c.set('session', { id: 'sess-1' })
    }
    await next()
  },
  requireAuth: async (_c: any, next: any) => { await next() },
}))

mock.module('../middleware/super-admin', () => ({
  requireSuperAdmin: async (_c: any, next: any) => { await next() },
}))

const { userAttributionRoute } = await import('../routes/admin')
const { deriveSourceTag } = await import('../services/analytics.service')

beforeEach(() => {
  mockPrisma.signupAttribution.upsert.mockReset()
  mockPrisma.signupAttribution.findUnique.mockReset()
  mockPrisma.signupAttribution.findUnique.mockImplementation(() => Promise.resolve(null))
})

describe('deriveSourceTag', () => {
  const cases: [Record<string, string | null | undefined>, string][] = [
    [{ utmSource: 'google', utmMedium: 'cpc' }, 'google-ads'],
    [{ utmSource: 'facebook', utmMedium: 'cpc' }, 'facebook-ads'],
    [{ utmSource: 'twitter', utmMedium: 'cpc' }, 'twitter-ads'],
    [{ utmSource: 'bing', utmMedium: 'cpc' }, 'bing-ads'],
    [{ utmSource: 'newsletter', utmMedium: 'email' }, 'newsletter'],
    [{ utmSource: 'producthunt' }, 'producthunt'],
    [{ referrer: 'https://www.google.com/' }, 'organic:google'],
    [{ referrer: 'https://www.bing.com/search' }, 'organic:bing'],
    [{ referrer: 'https://news.ycombinator.com/' }, 'referral:news.ycombinator.com'],
    [{ method: 'google' }, 'google-oauth'],
    [{}, 'direct'],
    [{ utmSource: null, referrer: null }, 'direct'],
    [{ utmSource: 'Google', utmMedium: 'CPC' }, 'google-ads'],
  ]

  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} -> "${expected}"`, () => {
      expect(deriveSourceTag(input)).toBe(expected)
    })
  }
})

describe('POST /users/me/attribution', () => {
  let app: Hono

  beforeEach(() => {
    app = new Hono()
    app.route('/api', userAttributionRoute())
  })

  test('creates attribution with derived source tag', async () => {
    const res = await app.request('/api/users/me/attribution', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        utmSource: 'google',
        utmMedium: 'cpc',
        utmCampaign: 'spring2026',
        method: 'email',
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)

    expect(mockPrisma.signupAttribution.upsert).toHaveBeenCalledTimes(1)
    const call = mockPrisma.signupAttribution.upsert.mock.calls[0][0] as any
    expect(call.where.userId).toBe('user-1')
    expect(call.create.sourceTag).toBe('google-ads')
    expect(call.create.utmSource).toBe('google')
    expect(call.create.utmCampaign).toBe('spring2026')
    expect(call.create.signupMethod).toBe('email')
    // update is empty -> first-write-wins
    expect(call.update).toEqual({})
  })

  test('upsert prevents overwriting existing data', async () => {
    // First call
    await app.request('/api/users/me/attribution', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ utmSource: 'google', method: 'email' }),
    })
    // Second call
    await app.request('/api/users/me/attribution', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ utmSource: 'facebook', method: 'email' }),
    })

    expect(mockPrisma.signupAttribution.upsert).toHaveBeenCalledTimes(2)
    const secondCall = mockPrisma.signupAttribution.upsert.mock.calls[1][0] as any
    expect(secondCall.update).toEqual({})
  })

  test('enriches a row the server wrote at signup instead of overwriting it', async () => {
    // The signup-time row: no UTMs, so the server recorded `direct`.
    mockPrisma.signupAttribution.findUnique.mockImplementation(() =>
      Promise.resolve({
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        utmContent: null,
        utmTerm: null,
        referrer: null,
        landingPage: null,
        signupMethod: 'credential',
        sourceTag: 'direct',
      }),
    )

    await app.request('/api/users/me/attribution', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ utmSource: 'facebook', utmMedium: 'cpc', method: 'email' }),
    })

    const call = mockPrisma.signupAttribution.upsert.mock.calls[0][0] as any
    expect(call.update).toEqual({
      utmSource: 'facebook',
      utmMedium: 'cpc',
      sourceTag: 'facebook-ads',
    })
    // `signupMethod` was already recorded at signup and is not re-stamped.
    expect(call.update.signupMethod).toBeUndefined()
  })

  test('never clobbers a source tag that already says where the user came from', async () => {
    mockPrisma.signupAttribution.findUnique.mockImplementation(() =>
      Promise.resolve({
        utmSource: 'newsletter',
        utmMedium: null,
        utmCampaign: null,
        utmContent: null,
        utmTerm: null,
        referrer: null,
        landingPage: null,
        signupMethod: 'credential',
        sourceTag: 'newsletter',
      }),
    )

    await app.request('/api/users/me/attribution', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ utmSource: 'bing', utmMedium: 'cpc' }),
    })

    const call = mockPrisma.signupAttribution.upsert.mock.calls[0][0] as any
    // The empty `utmMedium` is filled in; the tag that already says "newsletter"
    // is not replaced by `bing-ads`.
    expect(call.update).toEqual({ utmMedium: 'cpc' })
    expect(call.update.sourceTag).toBeUndefined()
  })

  test('handles missing optional fields', async () => {
    const res = await app.request('/api/users/me/attribution', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'google' }),
    })

    expect(res.status).toBe(200)
    const call = mockPrisma.signupAttribution.upsert.mock.calls[0][0] as any
    expect(call.create.sourceTag).toBe('google-oauth')
    expect(call.create.utmSource).toBeNull()
  })

  test('rejects a signed-out request instead of writing a row', async () => {
    const res = await app.request('/api/users/me/attribution', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-no-auth': '1' },
      body: JSON.stringify({ utmSource: 'sho258' }),
    })

    // Regression guard: the handler must read the identity `authMiddleware`
    // actually sets (`auth`), not a `user` var nothing populates — that made
    // the endpoint 401 for every caller, including an authenticated one.
    expect(res.status).toBe(401)
    expect(mockPrisma.signupAttribution.upsert).not.toHaveBeenCalled()
  })
})
