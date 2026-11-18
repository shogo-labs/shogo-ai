// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The signup-time attribution row (SHO-258 §7).
 *
 * `signup_attributions` held 14 rows, all from March, because the client-side
 * flush reads UTMs from the wrong origin. The row is written by the server now,
 * from the cookies on the signup POST — including when there are none, because
 * a `direct` row is itself the number we were missing.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test'

const upsert = mock(() => Promise.resolve({ id: 'attr-1' }))

mock.module('../prisma', () => ({
  prisma: { signupAttribution: { upsert } },
}))

const {
  parseUtmCookie,
  attributionFromCookieHeader,
  recordSignupAttribution,
  metaIdsFromCookieHeader,
  signupEventId,
} = await import('../signup-attribution')

beforeEach(() => {
  upsert.mockClear()
})

describe('parseUtmCookie', () => {
  test('reads the JSON blob the marketing site sets', () => {
    expect(
      parseUtmCookie(
        JSON.stringify({ utmSource: 'sho258', utmMedium: 'email', landingPage: '/pricing' }),
      ),
    ).toEqual({
      utmSource: 'sho258',
      utmMedium: 'email',
      utmCampaign: null,
      utmContent: null,
      utmTerm: null,
      referrer: null,
      landingPage: '/pricing',
      funnel: null,
      fbclid: null,
    })
  })

  test('keeps the funnel id and the Meta click id the funnel pages store', () => {
    const parsed = parseUtmCookie(JSON.stringify({ utmSource: 'meta', funnel: 'f1', fbclid: 'IwAR123' }))
    expect(parsed.funnel).toBe('f1')
    expect(parsed.fbclid).toBe('IwAR123')
    expect(parseUtmCookie('utm_source=meta&funnel=f3&fbclid=abc').funnel).toBe('f3')
  })

  test('accepts snake_case keys and a plain query string', () => {
    expect(parseUtmCookie('utm_source=newsletter&utm_medium=email').utmSource).toBe('newsletter')
    expect(parseUtmCookie(JSON.stringify({ utm_source: 'x' })).utmSource).toBe('x')
  })

  test('an unparseable cookie is "no UTMs", never an error', () => {
    expect(parseUtmCookie('{not json')).toEqual({})
    expect(parseUtmCookie(null)).toEqual({})
  })
})

describe('attributionFromCookieHeader', () => {
  test('picks the UTM cookie out of a busy cookie header', () => {
    const header = [
      'theme=dark',
      `__shogo_utm=${encodeURIComponent(JSON.stringify({ utmSource: 'sho258', utmMedium: 'email' }))}`,
      'better-auth.session=abc',
    ].join('; ')
    expect(attributionFromCookieHeader(header).utmSource).toBe('sho258')
  })

  test('no cookie header means no attribution to read', () => {
    expect(attributionFromCookieHeader(undefined)).toEqual({})
  })
})

describe('recordSignupAttribution', () => {
  test('writes a row with the derived tag for a UTM signup', async () => {
    const tag = await recordSignupAttribution({
      userId: 'user-1',
      cookieHeader: `__shogo_utm=${encodeURIComponent(
        JSON.stringify({ utmSource: 'sho258' }),
      )}`,
      method: 'social',
    })

    expect(tag).toBe('sho258')
    const call = upsert.mock.calls[0]![0] as any
    expect(call.where).toEqual({ userId: 'user-1' })
    expect(call.create.utmSource).toBe('sho258')
    expect(call.create.signupMethod).toBe('social')
    expect(call.create.sourceTag).toBe('sho258')
    // The row is created once and never rewritten on a replay.
    expect(call.update).toEqual({})
  })

  test('a signup with no cookies still writes a row, tagged direct', async () => {
    const tag = await recordSignupAttribution({ userId: 'user-2', cookieHeader: '', method: 'credential' })

    expect(tag).toBe('direct')
    const call = upsert.mock.calls[0]![0] as any
    expect(call.create.sourceTag).toBe('direct')
    expect(call.create.utmSource).toBeNull()
  })

  test('a database failure is swallowed — attribution can never fail a signup', async () => {
    upsert.mockImplementationOnce(() => Promise.reject(new Error('db down')))
    await expect(
      recordSignupAttribution({ userId: 'user-3', cookieHeader: '', method: 'credential' }),
    ).resolves.toBeNull()
  })
})

describe('Meta Conversions API at signup', () => {
  const realFetch = globalThis.fetch
  const env = { ...process.env }

  test('stores the browser ids and sends CompleteRegistration with the browser twin\'s event id', async () => {
    process.env.META_PIXEL_ID = '1606779090556329'
    process.env.META_CAPI_TOKEN = 'test-token'
    process.env.META_TEST_EVENT_CODE = 'TEST123'
    const sent: any[] = []
    globalThis.fetch = mock(async (_url: any, init: any) => {
      sent.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ events_received: 1 }), { status: 200 })
    }) as any
    try {
      const cookie = [
        `__shogo_utm=${encodeURIComponent(JSON.stringify({ utmSource: 'meta', utmContent: 'ad-7', funnel: 'f1', landingPage: '/for/meta-ads' }))}`,
        '_fbp=fb.1.1700000000000.111',
        '_fbc=fb.1.1700000000000.IwAR9',
      ].join('; ')
      await recordSignupAttribution({
        userId: 'user-meta',
        cookieHeader: cookie,
        method: 'credential',
        email: 'New@Example.com',
        clientIp: '203.0.113.9',
        userAgent: 'Mozilla/5.0',
      })
      const row = (upsert.mock.calls[0]![0] as any).create
      expect(row.funnel).toBe('f1')
      expect(row.fbp).toBe('fb.1.1700000000000.111')
      expect(row.fbc).toBe('fb.1.1700000000000.IwAR9')
      expect(row.clientIp).toBe('203.0.113.9')

      await new Promise((r) => setTimeout(r, 0))
      expect(sent).toHaveLength(1)
      const event = sent[0].data[0]
      expect(event.event_name).toBe('CompleteRegistration')
      expect(event.event_id).toBe(signupEventId('user-meta'))
      expect(event.event_id).toBe('signup_user-meta')
      expect(event.event_source_url).toBe('https://shogo.ai/for/meta-ads')
      expect(event.user_data.fbc).toBe('fb.1.1700000000000.IwAR9')
      expect(event.user_data.em[0]).toHaveLength(64)
      expect(event.custom_data.funnel).toBe('f1')
      expect(sent[0].test_event_code).toBe('TEST123')
    } finally {
      globalThis.fetch = realFetch
      process.env = env
    }
  })

  test('builds _fbc from a kept fbclid when the Pixel never set one', () => {
    const ids = metaIdsFromCookieHeader('_fbp=fb.1.1.2', 'IwARclick')
    expect(ids.fbp).toBe('fb.1.1.2')
    expect(ids.fbc).toMatch(/^fb\.1\.\d+\.IwARclick$/)
    expect(metaIdsFromCookieHeader('', null)).toEqual({ fbp: null, fbc: null })
  })
})
