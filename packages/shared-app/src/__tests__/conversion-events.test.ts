// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The browser/server conversion contract (SHO-611).
 *
 * Both sides import this module, so these assertions are what stops the pixel
 * event and the Conversions API event from drifting into two conversions Meta
 * cannot dedupe.
 */
import { describe, test, expect } from 'bun:test'
import {
  ATTRIBUTION_COOKIE_MAX_AGE_SECONDS,
  META_FBC_COOKIE,
  META_FBP_COOKIE,
  POSTHOG_DISTINCT_ID_PARAM,
  SHOGO_UTM_COOKIE,
  buildFbcFromFbclid,
  purchaseEventId,
  signupEventId,
  subscribeEventId,
} from '../lib/conversion-events'

describe('conversion event ids', () => {
  test('a sign-up is keyed signup_<userId>', () => {
    expect(signupEventId('user-1')).toBe('signup_user-1')
  })

  test('a purchase is the checkout session id, and Subscribe adds _sub', () => {
    expect(purchaseEventId('cs_test_1')).toBe('cs_test_1')
    expect(subscribeEventId('cs_test_1')).toBe('cs_test_1_sub')
    // The two can never collide: Meta dedupes per event name + id.
    expect(purchaseEventId('cs_test_1')).not.toBe(subscribeEventId('cs_test_1'))
  })
})

describe('the attribution cookie contract', () => {
  test('names the cookies and the link parameter card 5 has to write', () => {
    expect(SHOGO_UTM_COOKIE).toBe('__shogo_utm')
    expect(META_FBC_COOKIE).toBe('_fbc')
    expect(META_FBP_COOKIE).toBe('_fbp')
    expect(POSTHOG_DISTINCT_ID_PARAM).toBe('ph_did')
    expect(ATTRIBUTION_COOKIE_MAX_AGE_SECONDS).toBe(90 * 24 * 60 * 60)
  })

  test('builds _fbc in the format Meta documents', () => {
    expect(buildFbcFromFbclid('IwAR123', 1_700_000_000_000)).toBe('fb.1.1700000000000.IwAR123')
  })
})
