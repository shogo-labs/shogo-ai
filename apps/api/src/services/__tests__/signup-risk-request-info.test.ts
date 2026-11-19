// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `readSignupRequestInfo` device id: header first, then the first-party
 * `shogo.device_id` cookie (SHO-440). Google and Apple sign-ups are created on
 * `/callback/:provider`, which cannot carry the header, so the cookie is the
 * only device signal those accounts have.
 */
import { describe, expect, mock, test } from 'bun:test'

mock.module('../../lib/prisma', () => ({ prisma: {} }))

const { DEVICE_ID_COOKIE, readCookie, readDeviceId, readSignupRequestInfo } = await import(
  '../signup-risk.service'
)

const VALID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'

describe('readCookie', () => {
  test('returns the value of the named cookie', () => {
    expect(readCookie({ cookie: 'a=1; shogo.device_id=abc; b=2' }, 'shogo.device_id')).toBe('abc')
  })

  test('returns null when the cookie is absent or the header is missing', () => {
    expect(readCookie({ cookie: 'a=1' }, 'shogo.device_id')).toBeNull()
    expect(readCookie({}, 'shogo.device_id')).toBeNull()
    expect(readCookie(null, 'shogo.device_id')).toBeNull()
  })

  test('URL-decodes the value', () => {
    expect(readCookie({ cookie: 'x=hello%20world' }, 'x')).toBe('hello world')
  })
})

describe('readSignupRequestInfo device id', () => {
  test('reads the header', () => {
    expect(readSignupRequestInfo({ 'x-shogo-device-id': VALID }).deviceId).toBe(VALID)
  })

  test('falls back to the cookie when there is no header', () => {
    expect(readSignupRequestInfo({ cookie: `${DEVICE_ID_COOKIE}=${VALID}` }).deviceId).toBe(VALID)
  })

  test('the header beats the cookie', () => {
    const info = readSignupRequestInfo({
      'x-shogo-device-id': VALID,
      cookie: `${DEVICE_ID_COOKIE}=cookie-value-1234`,
    })
    expect(info.deviceId).toBe(VALID)
  })

  test('an invalid header falls back to a valid cookie', () => {
    const info = readSignupRequestInfo({
      'x-shogo-device-id': 'bad value!',
      cookie: `${DEVICE_ID_COOKIE}=${VALID}`,
    })
    expect(info.deviceId).toBe(VALID)
  })

  test('invalid values are ignored', () => {
    expect(readSignupRequestInfo({ 'x-shogo-device-id': 'short' }).deviceId).toBeNull()
    expect(readSignupRequestInfo({ cookie: `${DEVICE_ID_COOKIE}=bad value!` }).deviceId).toBeNull()
    expect(readSignupRequestInfo({}).deviceId).toBeNull()
  })

  test('readDeviceId is the same rule', () => {
    expect(readDeviceId({ cookie: `${DEVICE_ID_COOKIE}=${VALID}` })).toBe(VALID)
    expect(readDeviceId({})).toBeNull()
  })
})
