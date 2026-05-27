// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { TwilioApiError, DEFAULT_TWILIO_BASE_URL } from '../twilio.js'

describe('TwilioApiError', () => {
  test('extends Error with name, status, body fields', () => {
    const err = new TwilioApiError('boom', 502, 'gateway timeout body')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(TwilioApiError)
    expect(err.name).toBe('TwilioApiError')
    expect(err.message).toBe('boom')
    expect(err.status).toBe(502)
    expect(err.body).toBe('gateway timeout body')
  })
  test('can be caught as Error', () => {
    try {
      throw new TwilioApiError('x', 400, 'bad')
    } catch (e) {
      expect((e as Error).name).toBe('TwilioApiError')
      expect((e as TwilioApiError).status).toBe(400)
    }
  })
})

describe('DEFAULT_TWILIO_BASE_URL', () => {
  test('points at the official Twilio API host', () => {
    expect(DEFAULT_TWILIO_BASE_URL).toBe('https://api.twilio.com')
  })
})
