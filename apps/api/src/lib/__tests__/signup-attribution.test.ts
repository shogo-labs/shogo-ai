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
    })
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

  test('no token cookie (pixel blocked, or a native sign-in) sends nothing', async () => {
    await recordSignupAttribution({
      userId: 'user-10',
      cookieHeader: 'theme=dark',
      method: 'social',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
    })

    expect(cometCalls).toHaveLength(0)
  })

  test('an email/password sign-up sends nothing — the pixel reads that form', async () => {
    await recordSignupAttribution({
      userId: 'user-11',
      cookieHeader: cometCookie,
      method: 'credential',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
    })

    expect(cometCalls).toHaveLength(0)
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
