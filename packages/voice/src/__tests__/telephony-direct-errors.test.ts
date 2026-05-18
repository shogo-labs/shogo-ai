// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `telephony.ts` — covers the Direct-mode "unavailable" error branches
 * (`getUsage`, `listCalls`, `getCall`) plus a couple of Hosted-mode
 * query-string edge cases that weren't otherwise exercised.
 */

import { describe, test, expect } from 'bun:test'
import {
  DirectTelephonyClient,
  HostedTelephonyClient,
  TelephonyConfigError,
  createTelephonyClient,
} from '../telephony'

function makeDirect() {
  return new DirectTelephonyClient({
    elevenlabs: { apiKey: 'k', agentId: 'a' },
    twilio: { accountSid: 'AC', authToken: 't' },
  })
}

describe('DirectTelephonyClient — Mode A read methods all throw TelephonyConfigError', () => {
  test('getUsage throws', () => {
    expect(makeDirect().getUsage()).rejects.toBeInstanceOf(TelephonyConfigError)
  })

  test('listCalls throws', () => {
    expect(makeDirect().listCalls()).rejects.toBeInstanceOf(TelephonyConfigError)
  })

  test('getCall throws', () => {
    expect(makeDirect().getCall()).rejects.toBeInstanceOf(TelephonyConfigError)
  })
})

describe('DirectTelephonyClient — constructor validation', () => {
  test('requires elevenlabs.apiKey', () => {
    expect(
      () =>
        new DirectTelephonyClient({
          elevenlabs: { apiKey: '', agentId: 'a' },
          twilio: { accountSid: 'AC', authToken: 't' },
        }),
    ).toThrow(TelephonyConfigError)
  })

  test('requires elevenlabs.agentId', () => {
    expect(
      () =>
        new DirectTelephonyClient({
          elevenlabs: { apiKey: 'k', agentId: '' },
          twilio: { accountSid: 'AC', authToken: 't' },
        }),
    ).toThrow(TelephonyConfigError)
  })

  test('requires twilio.accountSid + twilio.authToken', () => {
    expect(
      () =>
        new DirectTelephonyClient({
          elevenlabs: { apiKey: 'k', agentId: 'a' },
          twilio: { accountSid: '', authToken: '' },
        }),
    ).toThrow(TelephonyConfigError)
  })

  test('outboundCall before provisioning rejects with TelephonyConfigError', () => {
    expect(
      makeDirect().outboundCall({ to: '+15551234567' }),
    ).rejects.toBeInstanceOf(TelephonyConfigError)
  })
})

describe('HostedTelephonyClient — usage range query string', () => {
  test('listCalls forwards limit and includeTranscript', async () => {
    const seen: string[] = []
    const fakeFetch = ((url: string, _init?: any) => {
      seen.push(url)
      return Promise.resolve(
        new Response(JSON.stringify({ projectId: 'p', calls: [] }), { status: 200 }),
      )
    }) as typeof fetch
    const client = new HostedTelephonyClient({
      shogoApiKey: 'shogo_sk_t',
      projectId: 'p',
      apiUrl: 'https://example.test',
      fetch: fakeFetch,
    })
    await client.listCalls({ limit: 5, includeTranscript: true })
    expect(seen[0]).toContain('limit=5')
    expect(seen[0]).toContain('includeTranscript=1')
  })

  test('getUsage forwards from + to query params', async () => {
    const seen: string[] = []
    const fakeFetch = ((url: string, _init?: any) => {
      seen.push(url)
      return Promise.resolve(
        new Response(
          JSON.stringify({
            projectId: 'p',
            range: { from: '2024-01-01', to: '2024-01-31' },
            totals: {
              minutesInbound: 0,
              minutesOutbound: 0,
              billedUsdInbound: 0,
              billedUsdOutbound: 0,
              billedUsdNumbers: 0,
              billedUsd: 0,
              calls: 0,
              inboundCalls: 0,
              outboundCalls: 0,
            },
            events: [],
          }),
          { status: 200 },
        ),
      )
    }) as typeof fetch
    const client = new HostedTelephonyClient({
      shogoApiKey: 'shogo_sk_t',
      projectId: 'p',
      apiUrl: 'https://example.test',
      fetch: fakeFetch,
    })
    await client.getUsage({ from: '2024-01-01', to: '2024-01-31' })
    expect(seen[0]).toContain('from=2024-01-01')
    expect(seen[0]).toContain('to=2024-01-31')
  })
})

describe('createTelephonyClient factory', () => {
  test('dispatches mode: direct to DirectTelephonyClient', () => {
    const c = createTelephonyClient({
      mode: 'direct',
      elevenlabs: { apiKey: 'k', agentId: 'a' },
      twilio: { accountSid: 'AC', authToken: 't' },
    })
    expect(c.mode).toBe('direct')
  })

  test('dispatches mode: hosted to HostedTelephonyClient', () => {
    const c = createTelephonyClient({
      mode: 'hosted',
      shogoApiKey: 'shogo_sk_t',
      projectId: 'p',
      apiUrl: 'https://example.test',
    })
    expect(c.mode).toBe('hosted')
  })
})
