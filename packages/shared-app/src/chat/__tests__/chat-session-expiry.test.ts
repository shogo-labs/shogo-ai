// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A send refused for want of a session has to be recognisable from the thrown
 * value alone: the AI SDK rethrows the raw response body as an `Error`
 * message, so the 401 status never reaches the panel (SHO-431).
 */

import { describe, it, expect } from 'vitest'
import {
  CHAT_SESSION_EXPIRED_MESSAGE,
  ERROR_CODE_MESSAGES,
  formatErrorMessage,
  isChatUnauthorizedError,
} from '../message-helpers'

/** Exactly what `requireAuth` in apps/api answers a refused chat send. */
const API_401_BODY = JSON.stringify({
  error: { code: 'unauthorized', message: 'Authentication required' },
})

describe('isChatUnauthorizedError', () => {
  it('recognises the API envelope rethrown verbatim by the AI SDK', () => {
    expect(isChatUnauthorizedError(new Error(API_401_BODY))).toBe(true)
  })

  it('recognises the envelope as a bare string', () => {
    expect(isChatUnauthorizedError(API_401_BODY)).toBe(true)
  })

  it('recognises a thrown value that kept its status', () => {
    expect(isChatUnauthorizedError({ status: 401 })).toBe(true)
    expect(isChatUnauthorizedError({ statusCode: 401 })).toBe(true)
    expect(isChatUnauthorizedError({ response: { status: 401 } })).toBe(true)
  })

  it('recognises the code on a structured error', () => {
    expect(isChatUnauthorizedError({ code: 'unauthorized' })).toBe(true)
  })

  it('recognises the bare refusal the SDK client raises', () => {
    expect(
      isChatUnauthorizedError(new Error('ShogoError: Authentication required')),
    ).toBe(true)
  })

  it('leaves a network drop to isClientNetworkFailure', () => {
    expect(isChatUnauthorizedError(new TypeError('Failed to fetch'))).toBe(false)
    expect(isChatUnauthorizedError(new Error('network error'))).toBe(false)
  })

  it('leaves another API refusal alone', () => {
    expect(
      isChatUnauthorizedError(
        JSON.stringify({ error: { code: 'usage_limit_reached' } }),
      ),
    ).toBe(false)
    expect(isChatUnauthorizedError({ status: 403 })).toBe(false)
  })

  it('does not read a long payload that merely mentions authentication', () => {
    // A tool/stream failure whose text happens to contain the phrase must not
    // be mistaken for a refused session and trigger a pointless re-auth.
    const blob = `${'x'.repeat(300)} Authentication required`
    expect(isChatUnauthorizedError(new Error(blob))).toBe(false)
  })

  it('is false for an empty value', () => {
    expect(isChatUnauthorizedError(null)).toBe(false)
    expect(isChatUnauthorizedError(undefined)).toBe(false)
    expect(isChatUnauthorizedError('')).toBe(false)
  })
})

describe('session-refused copy', () => {
  it('maps the API code to the message the panel shows', () => {
    expect(ERROR_CODE_MESSAGES.unauthorized).toBe(CHAT_SESSION_EXPIRED_MESSAGE)
  })

  it('is what formatErrorMessage renders for the raw envelope', () => {
    expect(formatErrorMessage(API_401_BODY)).toBe(CHAT_SESSION_EXPIRED_MESSAGE)
  })

  it('never renders the envelope itself', () => {
    const rendered = formatErrorMessage(API_401_BODY)
    expect(rendered).not.toContain('{')
    expect(rendered).not.toContain('unauthorized')
  })
})
