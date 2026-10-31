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
