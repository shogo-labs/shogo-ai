// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Meta Conversions API client (SHO-611).
 *
 * `fetch` is stubbed in every test here: no event ever leaves the process, and
 * the suite passes with no token, which is also the desktop/CI behaviour.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import {
  buildMetaEvent,
  hashEmail,
  isMetaCapiConfigured,
  sendMetaEvents,
} from '../meta-capi'

const realFetch = globalThis.fetch
let fetchCalls: Array<{ url: string; init: RequestInit }> = []

beforeEach(() => {
  fetchCalls = []
  globalThis.fetch = mock(async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init })
    return new Response('{"events_received":1}', { status: 200 })
  }) as unknown as typeof fetch
  delete process.env.META_CAPI_ACCESS_TOKEN
  delete process.env.META_CAPI_TEST_EVENT_CODE
  delete process.env.FB_PIXEL_ID
})

afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.META_CAPI_ACCESS_TOKEN
  delete process.env.META_CAPI_TEST_EVENT_CODE
  delete process.env.FB_PIXEL_ID
})

describe('buildMetaEvent', () => {
  test('hashes the email and the external id, and leaves the click ids alone', () => {
    const event = buildMetaEvent(
      {
        eventName: 'CompleteRegistration',
        eventId: 'signup_user-1',
        email: '  Ada@Example.COM ',
        externalId: 'user-1',
        fbc: 'fb.1.1700000000000.click',
        fbp: 'fb.1.1700000000000.browser',
        clientIp: '203.0.113.7',
        userAgent: 'Mozilla/5.0',
        eventTime: 1_700_000_000_000,
      },
      1_700_000_500_000,
    )

    expect(event.event_name).toBe('CompleteRegistration')
    // Meta takes seconds, and the event's own time wins over `now`.
    expect(event.event_time).toBe(1_700_000_000)
    expect(event.event_id).toBe('signup_user-1')
    expect(event.action_source).toBe('website')
    // Lowercased and trimmed before hashing.
    expect(event.user_data.em).toEqual([hashEmail('ada@example.com')])
    expect(event.user_data.em![0]).not.toContain('@')
    expect(event.user_data.external_id).toEqual([hashEmail('user-1')])
    // These travel unhashed — Meta matches on them itself.
    expect(event.user_data.fbc).toBe('fb.1.1700000000000.click')
    expect(event.user_data.fbp).toBe('fb.1.1700000000000.browser')
    expect(event.user_data.client_ip_address).toBe('203.0.113.7')
    expect(event.user_data.client_user_agent).toBe('Mozilla/5.0')
  })

  test('derives fbc from a bare fbclid in Meta\u2019s documented format', () => {
    const event = buildMetaEvent(
      { eventName: 'Purchase', eventId: 'cs_1', fbclid: 'IwAR123', eventTime: 1_700_000_000_000 },
      1_700_100_000_000,
    )
    expect(event.user_data.fbc).toBe('fb.1.1700100000000.IwAR123')
  })

  test('a real _fbc wins over a derived one', () => {
    const event = buildMetaEvent({
      eventName: 'Purchase',
      eventId: 'cs_1',
      fbclid: 'IwAR123',
      fbc: 'fb.1.1690000000000.pixel',
    })
    expect(event.user_data.fbc).toBe('fb.1.1690000000000.pixel')
  })

  test('empty fields are left out entirely, not sent as empty strings', () => {
    const event = buildMetaEvent({
      eventName: 'CompleteRegistration',
      eventId: 'signup_user-2',
      email: '   ',
      externalId: null,
      fbp: '',
      clientIp: '',
    })
    expect(event.user_data).toEqual({})
    expect(event.custom_data).toBeUndefined()
    expect(event.event_source_url).toBeUndefined()
  })

  test('keeps custom data and the source url when given', () => {
    const event = buildMetaEvent({
      eventName: 'Purchase',
      eventId: 'cs_1',
      customData: { value: 78, currency: 'USD' },
      sourceUrl: 'https://studio.shogo.ai/?checkout=success',
    })
    expect(event.custom_data).toEqual({ value: 78, currency: 'USD' })
    expect(event.event_source_url).toBe('https://studio.shogo.ai/?checkout=success')
  })
})

describe('sendMetaEvents', () => {
  test('with no token nothing is sent and nothing is logged', async () => {
    const warnings: unknown[] = []
    const realWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args) }
    try {
      process.env.FB_PIXEL_ID = 'pixel-1'
      const sent = await sendMetaEvents([buildMetaEvent({ eventName: 'Purchase', eventId: 'cs_1' })])
      expect(sent).toBe(false)
      expect(fetchCalls).toHaveLength(0)
      expect(warnings).toHaveLength(0)
      expect(isMetaCapiConfigured()).toBe(false)
    } finally {
      console.warn = realWarn
    }
  })

  test('with no pixel id nothing is sent either', async () => {
    process.env.META_CAPI_ACCESS_TOKEN = 'token'
    const sent = await sendMetaEvents([buildMetaEvent({ eventName: 'Purchase', eventId: 'cs_1' })])
    expect(sent).toBe(false)
    expect(fetchCalls).toHaveLength(0)
  })

  test('is configured only when both halves of the credential are present', () => {
    // The webhook gates on this, so an incomplete secret must not look configured.
    expect(isMetaCapiConfigured()).toBe(false)
    process.env.FB_PIXEL_ID = 'pixel-1'
    expect(isMetaCapiConfigured()).toBe(false)
    process.env.META_CAPI_ACCESS_TOKEN = 'token'
    expect(isMetaCapiConfigured()).toBe(true)
  })

  test('posts every event to the pinned pixel endpoint with the token and the test code', async () => {
    process.env.META_CAPI_ACCESS_TOKEN = 'token-abc'
    process.env.FB_PIXEL_ID = 'pixel-1'
    process.env.META_CAPI_TEST_EVENT_CODE = 'TEST123'

    const events = [
      buildMetaEvent({ eventName: 'Purchase', eventId: 'cs_1' }),
      buildMetaEvent({ eventName: 'Subscribe', eventId: 'cs_1_sub' }),
    ]
    const sent = await sendMetaEvents(events)

    expect(sent).toBe(true)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]!.url).toBe('https://graph.facebook.com/v27.0/pixel-1/events')
    const body = JSON.parse(String(fetchCalls[0]!.init.body))
    expect(body.access_token).toBe('token-abc')
    expect(body.test_event_code).toBe('TEST123')
    expect(body.data.map((e: any) => e.event_id)).toEqual(['cs_1', 'cs_1_sub'])
  })

  test('leaves the test code out when there is none', async () => {
    process.env.META_CAPI_ACCESS_TOKEN = 'token-abc'
    process.env.FB_PIXEL_ID = 'pixel-1'
    await sendMetaEvents([buildMetaEvent({ eventName: 'Purchase', eventId: 'cs_1' })])
    const body = JSON.parse(String(fetchCalls[0]!.init.body))
    expect(body.test_event_code).toBeUndefined()
  })

  test('a rejected batch is a status-only warning, never a throw and never a payload', async () => {
    process.env.META_CAPI_ACCESS_TOKEN = 'token-abc'
    process.env.FB_PIXEL_ID = 'pixel-1'
    globalThis.fetch = mock(async () => new Response('{"error":{}}', { status: 400 })) as unknown as typeof fetch

    const warnings: string[] = []
    const realWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')) }
    try {
      const sent = await sendMetaEvents([buildMetaEvent({ eventName: 'Purchase', eventId: 'cs_1', email: 'a@b.com' })])
      expect(sent).toBe(false)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('HTTP 400')
      expect(warnings[0]).not.toContain('token-abc')
      expect(warnings[0]).not.toContain('a@b.com')
    } finally {
      console.warn = realWarn
    }
  })

  test('a network failure never throws', async () => {
    process.env.META_CAPI_ACCESS_TOKEN = 'token-abc'
    process.env.FB_PIXEL_ID = 'pixel-1'
    globalThis.fetch = mock(async () => { throw new DOMException('timed out', 'TimeoutError') }) as unknown as typeof fetch

    const realWarn = console.warn
    console.warn = () => {}
    try {
      await expect(
        sendMetaEvents([buildMetaEvent({ eventName: 'Purchase', eventId: 'cs_1' })]),
      ).resolves.toBe(false)
    } finally {
      console.warn = realWarn
    }
  })
})
