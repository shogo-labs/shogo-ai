// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The server half of Cometly sign-up tracking (SHO-441).
 *
 * Everything here is offline: `fetch` is stubbed, so no event ever reaches
 * Cometly from a test run.
 */
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { sendCometlyEvent, splitName, COMET_TOKEN_COOKIE } from '../cometly'

const realFetch = globalThis.fetch
let calls: Array<{ url: string; init: RequestInit }> = []
let respond: () => Promise<Response> = async () => new Response('{}', { status: 202 })

function stubFetch(): void {
  calls = []
  globalThis.fetch = mock(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return respond()
  }) as unknown as typeof fetch
}

beforeEach(() => {
  stubFetch()
  process.env.COMETLY_API_KEY = 'test-key'
})

afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.COMETLY_API_KEY
})

describe('splitName', () => {
  test('first word is the first name, the rest is the last name', () => {
    expect(splitName('Ada Lovelace')).toEqual({ firstName: 'Ada', lastName: 'Lovelace' })
    expect(splitName('  Ada   King  Lovelace ')).toEqual({
      firstName: 'Ada',
      lastName: 'King Lovelace',
    })
  })

  test('a single name has no last name, and a missing name has neither', () => {
    expect(splitName('Cher')).toEqual({ firstName: 'Cher', lastName: '' })
    expect(splitName('')).toEqual({ firstName: '', lastName: '' })
    expect(splitName(null)).toEqual({ firstName: '', lastName: '' })
    expect(splitName(undefined)).toEqual({ firstName: '', lastName: '' })
  })
})

describe('sendCometlyEvent', () => {
  test('posts the Create Event payload Cometly documents', async () => {
    await expect(
      sendCometlyEvent({
        eventName: 'sign_up',
        email: 'ada@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        cometToken: 'tok_123',
        idempotencyKey: 'signup_user-1',
      }),
    ).resolves.toBe(true)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://app.cometly.com/public-api/v1/events/track')
    expect(calls[0]!.init.method).toBe('POST')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer test-key')
    expect(headers['content-type']).toBe('application/json')
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      event_name: 'sign_up',
      email: 'ada@example.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
      comet_token: 'tok_123',
      idempotency_key: 'signup_user-1',
    })
  })

  test('leaves the optional fields out rather than sending an empty string', async () => {
    await sendCometlyEvent({ eventName: 'sign_up', email: 'solo@example.com', firstName: 'Solo', lastName: '' })

    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      event_name: 'sign_up',
      email: 'solo@example.com',
      first_name: 'Solo',
    })
  })

  test('with no API key there is no request at all, and nothing is logged', async () => {
    delete process.env.COMETLY_API_KEY
    const warn = spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      sendCometlyEvent({ eventName: 'sign_up', email: 'ada@example.com', cometToken: 'tok_123' }),
    ).resolves.toBe(false)

    expect(calls).toHaveLength(0)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  test('a 5xx is one warning with the status and never the key', async () => {
    respond = async () => new Response('{"error":"nope"}', { status: 503 })
    const warn = spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      sendCometlyEvent({ eventName: 'sign_up', email: 'ada@example.com', cometToken: 'tok_123' }),
    ).resolves.toBe(false)

    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0]![0])
    expect(message).toContain('503')
    expect(message).not.toContain('test-key')
    warn.mockRestore()
  })

  test('a timeout is swallowed — a slow Cometly can never fail a signup', async () => {
    respond = async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError')
    }
    const warn = spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      sendCometlyEvent({ eventName: 'sign_up', email: 'ada@example.com', cometToken: 'tok_123' }),
    ).resolves.toBe(false)

    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).not.toContain('test-key')
    warn.mockRestore()
  })

  test('the cookie name the web sign-in page writes is the one the hook reads', () => {
    expect(COMET_TOKEN_COOKIE).toBe('__shogo_comet_token')
  })
})
