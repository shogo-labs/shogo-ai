// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * HostedTelephonyClient (Mode B) unit tests. Asserts the client hits
 * the right Shogo API URLs with a bearer auth header and maps the
 * response shape correctly. No network.
 *
 *   bun test packages/sdk/src/voice/__tests__/telephony-hosted.test.ts
 */

import { describe, expect, test } from 'bun:test'
import {
  HostedTelephonyClient,
  TelephonyApiError,
  TelephonyConfigError,
} from '../telephony'

interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
  credentials?: RequestCredentials
}

function mockFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Recorded[] = []
  let i = 0
  const impl: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url
    const headers: Record<string, string> = {}
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          headers[k] = v
        })
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) headers[k] = v
      } else {
        for (const [k, v] of Object.entries(init.headers)) headers[k] = String(v)
      }
    }
    let parsed: unknown
    if (typeof init?.body === 'string') {
      try {
        parsed = JSON.parse(init.body)
      } catch {
        parsed = init.body
      }
    }
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: parsed,
      credentials: init?.credentials,
    })
    const next = responses[i++] ?? responses[responses.length - 1]!
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { impl, calls }
}

describe('HostedTelephonyClient', () => {
  test('rejects construction without a Shogo API key', () => {
    expect(
      () =>
        new HostedTelephonyClient({
          shogoApiKey: '',
          projectId: 'p',
          apiUrl: 'https://api.test',
        }),
    ).toThrow(TelephonyConfigError)
  })

  test('provisionNumber posts to /api/voice/twilio/provision-number/:projectId with bearer', async () => {
    const { impl, calls } = mockFetch([
      {
        status: 200,
        body: {
          phoneNumber: '+14155550001',
          twilioPhoneSid: 'PN1',
          elevenlabsPhoneId: 'el_1',
          setupBilledUsd: 2.4,
          monthlyBilledUsd: 3.6,
          usageDebited: { setup: true, monthly: true },
        },
      },
    ])

    const client = new HostedTelephonyClient({
      shogoApiKey: 'shogo_sk_test',
      projectId: 'proj-xyz',
      apiUrl: 'https://api.test/',
      fetch: impl,
    })
    const result = await client.provisionNumber({ areaCode: '415' })

    expect(result.phoneNumber).toBe('+14155550001')
    expect(result.twilioPhoneSid).toBe('PN1')
    expect(result.elevenlabsPhoneId).toBe('el_1')
    expect(result.setupBilledUsd).toBe(2.4)
    expect(result.monthlyBilledUsd).toBe(3.6)
    expect(result.usageDebited).toEqual({ setup: true, monthly: true })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(
      'https://api.test/api/voice/twilio/provision-number/proj-xyz',
    )
    expect(calls[0].method).toBe('POST')
    expect(calls[0].headers.authorization).toBe('Bearer shogo_sk_test')
    expect(calls[0].credentials).toBe('omit')
    expect(calls[0].body).toEqual({
      areaCode: '415',
      country: undefined,
      friendlyName: undefined,
    })
  })

  test('outboundCall posts to /api/voice/twilio/outbound/:projectId', async () => {
    const { impl, calls } = mockFetch([
      {
        status: 200,
        body: {
          callSid: 'CA1',
          conversationId: 'conv_1',
          estimatedBilledUsd: 0.288,
          billedUsdPerMinute: 0.288,
        },
      },
    ])

    const client = new HostedTelephonyClient({
      shogoApiKey: 'shogo_sk_test',
      projectId: 'proj-xyz',
      apiUrl: 'https://api.test',
      fetch: impl,
    })
    const result = await client.outboundCall({
      to: '+14155559999',
      dynamicVariables: { campaign: 'x' },
    })

    expect(result.callSid).toBe('CA1')
    expect(result.conversationId).toBe('conv_1')
    expect(result.estimatedBilledUsd).toBe(0.288)
    expect(result.billedUsdPerMinute).toBe(0.288)
    expect(calls[0].url).toBe(
      'https://api.test/api/voice/twilio/outbound/proj-xyz',
    )
    expect((calls[0].body as any).to).toBe('+14155559999')
    expect((calls[0].body as any).dynamicVariables).toEqual({ campaign: 'x' })
  })

  test('usage-limit-reached error maps to TelephonyApiError(402)', async () => {
    const { impl } = mockFetch([
      {
        status: 402,
        body: { error: 'usage_limit_reached' },
      },
    ])
    const client = new HostedTelephonyClient({
      shogoApiKey: 'shogo_sk_test',
      projectId: 'proj-xyz',
      apiUrl: 'https://api.test',
      fetch: impl,
    })

    let caught: unknown = null
    try {
      await client.outboundCall({ to: '+14155559999' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(TelephonyApiError)
    expect((caught as TelephonyApiError).status).toBe(402)
    expect((caught as TelephonyApiError).message).toContain(
      'usage_limit_reached',
    )
  })

  test('releaseNumber DELETEs /api/voice/twilio/number/:projectId', async () => {
    const { impl, calls } = mockFetch([{ status: 200, body: { released: true } }])
    const client = new HostedTelephonyClient({
      shogoApiKey: 'shogo_sk_test',
      projectId: 'proj-xyz',
      apiUrl: 'https://api.test',
      fetch: impl,
    })
    const result = await client.releaseNumber()
    expect(result.released).toBe(true)
    expect(calls[0].method).toBe('DELETE')
    expect(calls[0].url).toBe('https://api.test/api/voice/twilio/number/proj-xyz')
  })
})
