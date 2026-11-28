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
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'

const upsert = mock(() => Promise.resolve({ id: 'attr-1' }))

mock.module('../prisma', () => ({
  prisma: { signupAttribution: { upsert } },
}))

const {
  parseUtmCookie,
  attributionFromCookieHeader,
  recordSignupAttribution,
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
      fbclid: null,
      gclid: null,
      fbc: null,
      fbp: null,
      phDid: null,
    })
  })

  test('accepts snake_case keys and a plain query string', () => {
    expect(parseUtmCookie('utm_source=newsletter&utm_medium=email').utmSource).toBe('newsletter')
    expect(parseUtmCookie(JSON.stringify({ utm_source: 'x' })).utmSource).toBe('x')
  })

  test('reads the click ids and the website PostHog id, in either key style (SHO-611)', () => {
    const camel = parseUtmCookie(
      JSON.stringify({ utmSource: 'meta', fbclid: 'IwAR1', gclid: 'Cj0K', phDid: 'ph_abc' }),
    )
    expect(camel.fbclid).toBe('IwAR1')
    expect(camel.gclid).toBe('Cj0K')
    expect(camel.phDid).toBe('ph_abc')

    const snake = parseUtmCookie(
      JSON.stringify({ utm_source: 'meta', fbclid: 'IwAR2', gclid: 'Cj0L', ph_did: 'ph_def' }),
    )
    expect(snake.fbclid).toBe('IwAR2')
    expect(snake.gclid).toBe('Cj0L')
    expect(snake.phDid).toBe('ph_def')

    const query = parseUtmCookie('utm_source=meta&fbclid=IwAR3&gclid=Cj0M&ph_did=ph_ghi')
    expect(query.fbclid).toBe('IwAR3')
    expect(query.gclid).toBe('Cj0M')
    expect(query.phDid).toBe('ph_ghi')
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

  test('picks up Meta\u2019s own _fbc/_fbp cookies, and prefers them over a derived fbc', () => {
    const header = [
      `__shogo_utm=${encodeURIComponent(JSON.stringify({ fbclid: 'IwARcookie' }))}`,
      '_fbc=fb.1.1690000000000.pixel',
      '_fbp=fb.1.1690000000000.browser',
    ].join('; ')
    const attribution = attributionFromCookieHeader(header)
    expect(attribution.fbclid).toBe('IwARcookie')
    expect(attribution.fbc).toBe('fb.1.1690000000000.pixel')
    expect(attribution.fbp).toBe('fb.1.1690000000000.browser')
  })

  test('a URL-encoded JSON cookie survives the trip, click ids and all', () => {
    const header = `__shogo_utm=${encodeURIComponent(
      JSON.stringify({
        utmSource: 'meta',
        utmMedium: 'paid',
        fbclid: 'IwAR7',
        gclid: 'Cj0K7',
        phDid: 'ph_7',
        landingPage: '/pricing?utm_source=meta',
      }),
    )}`
    const attribution = attributionFromCookieHeader(header)
    expect(attribution).toMatchObject({
      utmSource: 'meta',
      utmMedium: 'paid',
      fbclid: 'IwAR7',
      gclid: 'Cj0K7',
      phDid: 'ph_7',
      landingPage: '/pricing?utm_source=meta',
    })
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

  test('stores the click ids, Meta\u2019s cookies and the website\u2019s PostHog id (SHO-611, AC4)', async () => {
    const header = [
      `__shogo_utm=${encodeURIComponent(
        JSON.stringify({
          utmSource: 'meta',
          utmMedium: 'paid',
          fbclid: 'IwAR4',
          gclid: 'Cj0K4',
          phDid: 'ph_did_4',
          referrer: 'https://www.facebook.com/',
          landingPage: '/pricing?utm_source=meta',
        }),
      )}`,
      '_fbc=fb.1.1690000000000.pixel',
      '_fbp=fb.1.1690000000000.browser',
    ].join('; ')

    for (const method of ['credential', 'social']) {
      upsert.mockClear()
      await recordSignupAttribution({
        userId: `user-${method}`,
        cookieHeader: header,
        method,
        email: 'ada@example.com',
      })
      const call = upsert.mock.calls[0]![0] as any
      expect(call.create).toMatchObject({
        fbclid: 'IwAR4',
        gclid: 'Cj0K4',
        fbc: 'fb.1.1690000000000.pixel',
        fbp: 'fb.1.1690000000000.browser',
        posthogDistinctId: 'ph_did_4',
        utmSource: 'meta',
        referrer: 'https://www.facebook.com/',
        landingPage: '/pricing?utm_source=meta',
        signupMethod: method,
      })
    }
  })
})

/**
 * Cometly (SHO-441): the same hook reports the sign-up, gated on the token
 * cookie the web sign-in page writes before the Google round trip. `fetch` is
 * stubbed, so no event ever leaves the test.
 */
describe('recordSignupAttribution → Cometly', () => {
  const realFetch = globalThis.fetch
  let cometCalls: Array<{ url: string; body: any }> = []

  beforeEach(() => {
    cometCalls = []
    process.env.COMETLY_API_KEY = 'test-key'
    globalThis.fetch = mock(async (url: string, init: RequestInit) => {
      cometCalls.push({ url, body: JSON.parse(String(init.body)) })
      return new Response('{}', { status: 202 })
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    delete process.env.COMETLY_API_KEY
  })

  const cometCookie = `theme=dark; __shogo_comet_token=${encodeURIComponent('tok_abc')}`

  test('a new Google account sends exactly one sign_up, keyed by the user id', async () => {
    await recordSignupAttribution({
      userId: 'user-9',
      cookieHeader: cometCookie,
      method: 'social',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
    })

    expect(cometCalls).toHaveLength(1)
    expect(cometCalls[0]!.url).toBe('https://app.cometly.com/public-api/v1/events/track')
    expect(cometCalls[0]!.body).toEqual({
      event_name: 'sign_up',
      email: 'ada@example.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
      comet_token: 'tok_abc',
      idempotency_key: 'signup_user-9',
    })
  })

  test('no token cookie (pixel blocked, or a native sign-in) still reports the sign-up, without the token', async () => {
    await recordSignupAttribution({
      userId: 'user-10',
      cookieHeader: 'theme=dark',
      method: 'social',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
    })

    // SHO-611 widened this from social-only + token to every sign-up: the token
    // is optional, the email is what Cometly keys the account on.
    expect(cometCalls).toHaveLength(1)
    expect(cometCalls[0]!.body).toEqual({
      event_name: 'sign_up',
      email: 'ada@example.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
      idempotency_key: 'signup_user-10',
    })
  })

  test('an email/password sign-up reports sign_up too (SHO-611)', async () => {
    await recordSignupAttribution({
      userId: 'user-11',
      cookieHeader: cometCookie,
      method: 'credential',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
    })

    expect(cometCalls).toHaveLength(1)
    expect(cometCalls[0]!.body).toEqual({
      event_name: 'sign_up',
      email: 'ada@example.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
      comet_token: 'tok_abc',
      idempotency_key: 'signup_user-11',
    })
  })

  test('an account with no email sends nothing', async () => {
    await recordSignupAttribution({
      userId: 'user-12',
      cookieHeader: cometCookie,
      method: 'social',
      name: 'Ada Lovelace',
    })

    expect(cometCalls).toHaveLength(0)
  })

  test('with COMETLY_API_KEY unset a social sign-up still writes its row and sends nothing', async () => {
    delete process.env.COMETLY_API_KEY

    const tag = await recordSignupAttribution({
      userId: 'user-13',
      cookieHeader: cometCookie,
      method: 'social',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
    })

    expect(tag).toBe('direct')
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(cometCalls).toHaveLength(0)
  })
})

/**
 * Meta Conversions API (SHO-611, AC2): one CompleteRegistration per sign-up,
 * carrying the same `signup_<userId>` id the browser pixel sends so Meta
 * dedupes them. `fetch` is stubbed — nothing leaves the test.
 */
describe('recordSignupAttribution → Meta CAPI', () => {
  const realFetch = globalThis.fetch
  let metaCalls: Array<{ url: string; body: any }> = []

  beforeEach(() => {
    upsert.mockClear()
    metaCalls = []
    process.env.META_CAPI_ACCESS_TOKEN = 'test-token'
    process.env.FB_PIXEL_ID = 'pixel-test'
    globalThis.fetch = mock(async (url: string, init: RequestInit) => {
      metaCalls.push({ url, body: JSON.parse(String(init.body)) })
      return new Response('{"events_received":1}', { status: 200 })
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    delete process.env.META_CAPI_ACCESS_TOKEN
    delete process.env.FB_PIXEL_ID
    delete process.env.META_CAPI_TEST_EVENT_CODE
    delete process.env.COMETLY_API_KEY
  })

  const cookieHeader = [
    `__shogo_utm=${encodeURIComponent(
      JSON.stringify({ utmSource: 'meta', fbclid: 'IwARsig', landingPage: '/pricing' }),
    )}`,
    '_fbp=fb.1.1690000000000.browser',
  ].join('; ')

  for (const method of ['credential', 'social']) {
    test(`${method} sign-up builds exactly one CompleteRegistration keyed signup_<userId>`, async () => {
      await recordSignupAttribution({
        userId: `user-${method}`,
        cookieHeader,
        method,
        email: 'Ada@Example.com',
        name: 'Ada Lovelace',
        clientIp: '203.0.113.9',
        userAgent: 'Mozilla/5.0',
      })

      expect(metaCalls).toHaveLength(1)
      expect(metaCalls[0]!.url).toBe('https://graph.facebook.com/v21.0/pixel-test/events')
      const data = metaCalls[0]!.body.data
      expect(data).toHaveLength(1)
      expect(data[0].event_name).toBe('CompleteRegistration')
      expect(data[0].event_id).toBe(`signup_user-${method}`)
      expect(data[0].action_source).toBe('website')
      // Hashed, never the raw values.
      expect(data[0].user_data.em).toHaveLength(1)
      expect(data[0].user_data.em[0]).toMatch(/^[a-f0-9]{64}$/)
      expect(data[0].user_data.external_id[0]).toMatch(/^[a-f0-9]{64}$/)
      expect(data[0].user_data.fbp).toBe('fb.1.1690000000000.browser')
      expect(data[0].user_data.fbc).toMatch(/^fb\.1\.\d+\.IwARsig$/)
      expect(data[0].user_data.client_ip_address).toBe('203.0.113.9')
    })
  }

  test('reports to Cometly as well, for both methods', async () => {
    process.env.COMETLY_API_KEY = 'comet-key'

    await recordSignupAttribution({
      userId: 'user-both',
      cookieHeader,
      method: 'credential',
      email: 'ada@example.com',
    })

    const urls = metaCalls.map((c) => c.url)
    expect(urls.some((u) => u.startsWith('https://graph.facebook.com/'))).toBe(true)
    expect(urls.some((u) => u.startsWith('https://app.cometly.com/'))).toBe(true)
  })

  test('with no token nothing is sent and nothing is logged (AC6)', async () => {
    delete process.env.META_CAPI_ACCESS_TOKEN
    delete process.env.COMETLY_API_KEY
    const warnings: string[] = []
    const realWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')) }
    try {
      const tag = await recordSignupAttribution({
        userId: 'user-quiet',
        cookieHeader,
        method: 'credential',
        email: 'ada@example.com',
      })
      expect(tag).toBe('meta')
      expect(metaCalls).toHaveLength(0)
      expect(warnings).toHaveLength(0)
      expect(upsert).toHaveBeenCalledTimes(1)
    } finally {
      console.warn = realWarn
    }
  })
})
