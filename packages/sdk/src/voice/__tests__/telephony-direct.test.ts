// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * DirectTelephonyClient (Mode A) unit tests. The SDK talks directly to
 * Twilio REST + ElevenLabs REST using the developer's credentials —
 * Shogo's API is never contacted. We assert on the fetch-host allowlist
 * to enforce that contract.
 *
 *   bun test packages/sdk/src/voice/__tests__/telephony-direct.test.ts
 */

import { describe, expect, test } from 'bun:test'
import {
  DirectTelephonyClient,
  TelephonyConfigError,
} from '../telephony'

interface Recorded {
  url: string
  method: string
  body?: string
}

function scriptedFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Recorded[] = []
  let i = 0
  const impl: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url
    const rawBody = init?.body
    const bodyStr =
      typeof rawBody === 'string'
        ? rawBody
        : rawBody == null
          ? undefined
          : undefined
    calls.push({ url, method: init?.method ?? 'GET', body: bodyStr })
    const next = responses[i++] ?? responses[responses.length - 1]!
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { impl, calls }
}

function assertNoShogoHits(calls: Recorded[]) {
  for (const c of calls) {
    expect(c.url).not.toContain('shogo')
    expect(c.url).not.toContain('/api/voice/')
    // Allowlist: everything must be Twilio or ElevenLabs.
    const ok =
      c.url.startsWith('https://api.twilio.com') ||
      c.url.startsWith('https://api.elevenlabs.io')
    expect(ok).toBe(true)
  }
}

describe('DirectTelephonyClient', () => {
  test('rejects construction without ElevenLabs creds', () => {
    expect(
      () =>
        new DirectTelephonyClient({
          elevenlabs: { apiKey: '', agentId: 'a' },
          twilio: { accountSid: 'AC', authToken: 't' },
        }),
    ).toThrow(TelephonyConfigError)
  })

  test('provisionNumber calls Twilio search + purchase + EL link, never Shogo', async () => {
    const { impl, calls } = scriptedFetch([
      {
        status: 200,
        body: {
          available_phone_numbers: [
            {
              phone_number: '+14155550001',
              friendly_name: '+14155550001',
              region: 'CA',
              locality: 'SF',
              iso_country: 'US',
            },
          ],
        },
      },
      {
        status: 201,
        body: {
          sid: 'PN1',
          phone_number: '+14155550001',
          friendly_name: '+14155550001',
        },
      },
      { status: 200, body: { phone_number_id: 'el_1' } },
      { status: 200, body: { phone_number_id: 'el_1' } },
    ])

    const client = new DirectTelephonyClient({
      elevenlabs: { apiKey: 'sk_el', agentId: 'agent_1' },
      twilio: { accountSid: 'AC123', authToken: 'tok' },
      fetch: impl,
    })
    const result = await client.provisionNumber({ areaCode: '415' })

    expect(result.phoneNumber).toBe('+14155550001')
    expect(result.twilioPhoneSid).toBe('PN1')
    expect(result.elevenlabsPhoneId).toBe('el_1')
    assertNoShogoHits(calls)
    expect(calls[0].url).toContain(
      '/2010-04-01/Accounts/AC123/AvailablePhoneNumbers/US/Local.json',
    )
    expect(calls[1].url).toContain('/IncomingPhoneNumbers.json')
    // Current EL API: POST /v1/convai/phone-numbers to import the number,
    // then PATCH /v1/convai/phone-numbers/{id} to assign the agent.
    expect(calls[2].url).toContain('/v1/convai/phone-numbers')
    expect(calls[2].url).not.toContain('/create/twilio')
    expect(calls[2].method).toBe('POST')
    expect(calls[3].url).toContain('/v1/convai/phone-numbers/el_1')
    expect(calls[3].method).toBe('PATCH')
  })

  test('outboundCall hits provider-scoped EL /twilio/outbound-call with phone id in body', async () => {
    const { impl, calls } = scriptedFetch([
      {
        status: 200,
        body: { call_sid: 'CA1', conversation_id: 'conv_1' },
      },
    ])
    const client = new DirectTelephonyClient({
      elevenlabs: {
        apiKey: 'sk_el',
        agentId: 'agent_1',
        phoneNumberId: 'el_existing',
      },
      twilio: {
        accountSid: 'AC123',
        authToken: 'tok',
        fromNumber: '+14155550001',
      },
      fetch: impl,
    })
    const result = await client.outboundCall({ to: '+14155559999' })
    expect(result.callSid).toBe('CA1')
    expect(result.conversationId).toBe('conv_1')
    // EL 2026-Q2 API: provider-scoped route, `agent_phone_number_id`
    // travels in the JSON body rather than the URL path.
    expect(calls[0].url).toContain('/v1/convai/twilio/outbound-call')
    expect(calls[0].url).not.toContain('/phone-numbers/el_existing/outbound-call')
    expect(calls[0].method).toBe('POST')
    const body = JSON.parse(calls[0].body ?? '{}') as Record<string, unknown>
    expect(body).toMatchObject({
      agent_id: 'agent_1',
      agent_phone_number_id: 'el_existing',
      to_number: '+14155559999',
    })
    assertNoShogoHits(calls)
  })

  test('outboundCall without a provisioned EL phone id throws TelephonyConfigError', async () => {
    const { impl } = scriptedFetch([])
    const client = new DirectTelephonyClient({
      elevenlabs: { apiKey: 'sk_el', agentId: 'agent_1' },
      twilio: { accountSid: 'AC123', authToken: 'tok' },
      fetch: impl,
    })
    let caught: unknown = null
    try {
      await client.outboundCall({ to: '+14155559999' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(TelephonyConfigError)
  })

  test('getUsage throws — Mode A has no Shogo billing data', async () => {
    const { impl } = scriptedFetch([])
    const client = new DirectTelephonyClient({
      elevenlabs: { apiKey: 'sk_el', agentId: 'agent_1' },
      twilio: { accountSid: 'AC123', authToken: 'tok' },
      fetch: impl,
    })
    let caught: unknown = null
    try {
      await client.getUsage()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(TelephonyConfigError)
  })

  test('if EL linking fails, the purchased Twilio number is released', async () => {
    const { impl, calls } = scriptedFetch([
      {
        status: 200,
        body: {
          available_phone_numbers: [
            { phone_number: '+14155550001' },
          ],
        },
      },
      {
        status: 201,
        body: { sid: 'PN1', phone_number: '+14155550001' },
      },
      // EL link fails
      { status: 500, body: { detail: 'boom' } },
      // Compensating Twilio DELETE succeeds
      { status: 204, body: {} },
    ])

    const client = new DirectTelephonyClient({
      elevenlabs: { apiKey: 'sk_el', agentId: 'agent_1' },
      twilio: { accountSid: 'AC123', authToken: 'tok' },
      fetch: impl,
    })
    let caught: unknown = null
    try {
      await client.provisionNumber()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeTruthy()
    // 4 calls: search, purchase, EL create (failed), Twilio DELETE
    expect(calls.length).toBe(4)
    expect(calls[3].method).toBe('DELETE')
    expect(calls[3].url).toContain('/IncomingPhoneNumbers/PN1.json')
  })
})
