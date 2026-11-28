// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The marketing intent a sign-up link carries through auth (SHO-613).
 *
 * An Instagram ad lands on `/sign-up?utm_source=ig&plan=pro&prompt=…`; the tab
 * redirect, the sign-in form and the OAuth round trip all rewrote that URL. This
 * proves the allow-list, first-touch-wins, and the replay onto the post-auth
 * destination.
 */
import { beforeEach, describe, expect, test, mock } from 'bun:test'

const platform = { OS: 'web' as string }
mock.module('react-native', () => ({ Platform: platform }))

const {
  SIGNUP_INTENT_KEYS,
  captureSignupIntent,
  clearSignupIntent,
  pickSignupIntent,
  readSignupIntent,
  withSignupIntent,
} = await import('../signup-intent')

beforeEach(() => {
  clearSignupIntent()
})

describe('pickSignupIntent', () => {
  test('keeps only the allow-listed keys', () => {
    expect(
      pickSignupIntent({
        utm_source: 'ig',
        plan: 'pro',
        prompt: 'build me a site',
        secret: 'nope',
        email: 'a@b.com',
      }),
    ).toEqual({ utm_source: 'ig', plan: 'pro', prompt: 'build me a site' })
  })

  test('drops empty values and reads the first of a repeated parameter', () => {
    expect(pickSignupIntent({ plan: ['pro', 'team'], trial: '', utm_term: undefined })).toEqual({
      plan: 'pro',
    })
  })

  test('no params is an empty intent', () => {
    expect(pickSignupIntent(undefined)).toEqual({})
    expect(pickSignupIntent({})).toEqual({})
  })
})

describe('captureSignupIntent', () => {
  test('stores what the landing URL carried', () => {
    captureSignupIntent({ utm_source: 'ig', utm_campaign: 'launch', plan: 'pro' })
    expect(readSignupIntent()).toEqual({
      utm_source: 'ig',
      utm_campaign: 'launch',
      plan: 'pro',
    })
  })

  test('first touch wins per key, and a later hop can add a missing one', () => {
    captureSignupIntent({ plan: 'pro' })
    captureSignupIntent({ plan: 'team', trial: '14' })
    expect(readSignupIntent()).toEqual({ plan: 'pro', trial: '14' })
  })

  test('a URL with no intent does not clear what an earlier one captured', () => {
    captureSignupIntent({ plan: 'pro' })
    captureSignupIntent({ next: '/auth/cli-link' })
    expect(readSignupIntent()).toEqual({ plan: 'pro' })
  })
})

describe('withSignupIntent', () => {
  test('appends the intent to a bare path', () => {
    expect(withSignupIntent('/', { plan: 'pro', utm_source: 'ig' })).toBe(
      '/?plan=pro&utm_source=ig',
    )
  })

  test('appends with & when the path already has a query, and keeps the hash', () => {
    expect(withSignupIntent('/x?next=%2Fa#frag', { plan: 'pro' })).toBe(
      '/x?next=%2Fa&plan=pro#frag',
    )
  })

  test('encodes a prompt', () => {
    expect(withSignupIntent('/', { prompt: 'build me a site' })).toBe(
      '/?prompt=build%20me%20a%20site',
    )
  })

  test('an empty intent leaves the destination exactly as it was', () => {
    expect(withSignupIntent('/')).toBe('/')
    expect(withSignupIntent('/x?next=%2Fa')).toBe('/x?next=%2Fa')
  })

  test('defaults to the captured intent', () => {
    captureSignupIntent({ utm_source: 'fb' })
    expect(withSignupIntent('/')).toBe('/?utm_source=fb')
  })

  test('every allow-listed key is replayed', () => {
    const intent = Object.fromEntries(SIGNUP_INTENT_KEYS.map((key) => [key, `v-${key}`]))
    const replayed = withSignupIntent('/', intent)
    for (const key of SIGNUP_INTENT_KEYS) {
      expect(replayed).toContain(`${key}=v-${key}`)
    }
  })
})
