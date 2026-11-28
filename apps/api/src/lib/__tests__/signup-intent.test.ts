// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The server half of the sign-up intent (SHO-614): what `user.create.after`
 * reads out of the sign-up request's `__shogo_intent` cookie.
 *
 * The fixtures are the same shapes the client writes (and the shared module
 * tests), so a rule enforced on one side can't be missing on the other.
 */
import { describe, expect, test } from 'bun:test'
import {
  SIGNUP_INTENT_COOKIE_MAX,
  serializeSignupIntent,
  type SignupIntent,
} from '../../../../../packages/shared-app/src/signup-intent'
import {
  SIGNUP_INTENT_COOKIE,
  parseSignupIntentCookie,
  parseStoredSignupIntent,
} from '../signup-intent'

function cookieHeader(intent: SignupIntent | string): string {
  const value = typeof intent === 'string' ? intent : serializeSignupIntent(intent)
  return `theme=dark; __shogo_utm=utm_source%3Dx; ${SIGNUP_INTENT_COOKIE}=${value}; foo=bar`
}

describe('parseSignupIntentCookie', () => {
  test('reads the intent out of a busy cookie header', () => {
    expect(parseSignupIntentCookie(cookieHeader({ prompt: 'A booking page for my salon', intent: 'hero_prompt' })))
      .toEqual({ prompt: 'A booking page for my salon', intent: 'hero_prompt' })
  })

  test('reads a pricing intent', () => {
    expect(parseSignupIntentCookie(cookieHeader({ plan: 'basic', trial: true }))).toEqual({
      plan: 'basic',
      trial: true,
    })
  })

  test('returns null when there is no cookie, no header, or nothing valid', () => {
    expect(parseSignupIntentCookie('')).toBeNull()
    expect(parseSignupIntentCookie(undefined)).toBeNull()
    expect(parseSignupIntentCookie('theme=dark')).toBeNull()
    expect(parseSignupIntentCookie(`${SIGNUP_INTENT_COOKIE}=`)).toBeNull()
    // A crafted value can't smuggle in an unknown plan or a bad slug.
    const crafted = encodeURIComponent(JSON.stringify({ plan: 'free', template: '<script>' }))
    expect(parseSignupIntentCookie(`${SIGNUP_INTENT_COOKIE}=${crafted}`)).toBeNull()
  })

  test('never throws on garbage', () => {
    for (const raw of ['not%20json', '%7B', '[]', 'null', encodeURIComponent('{"prompt":42}')]) {
      expect(() => parseSignupIntentCookie(`${SIGNUP_INTENT_COOKIE}=${raw}`)).not.toThrow()
      expect(parseSignupIntentCookie(`${SIGNUP_INTENT_COOKIE}=${raw}`)).toBeNull()
    }
  })

  test('an oversized prompt is trimmed by the writer, not rejected on read', () => {
    const prompt = 'é'.repeat(1000)
    const header = cookieHeader({ prompt })
    const parsed = parseSignupIntentCookie(header)
    expect(parsed?.prompt?.length).toBeGreaterThan(0)
    expect(parsed!.prompt!.length).toBeLessThan(1000)
    expect(serializeSignupIntent({ prompt }).length).toBeLessThanOrEqual(SIGNUP_INTENT_COOKIE_MAX)
  })
})

describe('parseStoredSignupIntent', () => {
  test('reads what the signup hook wrote to the row', () => {
    expect(parseStoredSignupIntent(JSON.stringify({ prompt: 'A job tracker for my crew' }))).toEqual({
      prompt: 'A job tracker for my crew',
    })
  })

  test('treats null / garbage as no intent', () => {
    expect(parseStoredSignupIntent(null)).toBeNull()
    expect(parseStoredSignupIntent('')).toBeNull()
    expect(parseStoredSignupIntent('{oops')).toBeNull()
  })
})
