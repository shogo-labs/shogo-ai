// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * HostedRuntimeTokenClient unit tests — pod-native telephony path.
 *
 * Authenticates via `x-runtime-token` (not `Authorization: Bearer`) and
 * always appends `?projectId=` so Shogo's authMiddleware can re-derive
 * the token.
 *
 * Run: bun test packages/sdk/src/voice/__tests__/telephony-runtime-token.test.ts
 */

import { describe, expect, test } from 'bun:test'

import {
  DirectTelephonyClient,
  HostedRuntimeTokenClient,
  HostedTelephonyClient,
  TelephonyConfigError,
  createTelephonyClient,
} from '../telephony'

function makeMockFetch(
  handler: (req: { url: string; init: RequestInit }) => {
    status?: number
    body?: unknown
  },
): {
  fetch: typeof fetch
  calls: Array<{ url: string; init: RequestInit }>
} {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (input: any, init: any = {}) => {
    const url =
      typeof input === 'string' ? input : (input as URL | Request).toString()
    calls.push({ url, init })
    const { status = 200, body } = handler({ url, init })
    return new Response(body == null ? '' : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, calls }
}

describe('HostedRuntimeTokenClient', () => {
  test('requires runtimeToken, projectId, apiUrl', () => {
    expect(
      () =>
        new HostedRuntimeTokenClient({
          runtimeToken: '',
          projectId: 'p',
          apiUrl: 'http://x',
        }),
    ).toThrow(TelephonyConfigError)
    expect(
      () =>
        new HostedRuntimeTokenClient({
          runtimeToken: 't',
          projectId: '',
          apiUrl: 'http://x',
        }),
    ).toThrow(TelephonyConfigError)
    expect(
      () =>
        new HostedRuntimeTokenClient({
          runtimeToken: 't',
          projectId: 'p',
          apiUrl: '',
        }),
    ).toThrow(TelephonyConfigError)
  })

  test('mode === hosted', () => {
    const c = new HostedRuntimeTokenClient({
      runtimeToken: 't',
      projectId: 'p',
      apiUrl: 'http://x',
      fetch: (async () => new Response('')) as any,
    })
    expect(c.mode).toBe('hosted')
  })

  test('outboundCall sends x-runtime-token header + ?projectId= query', async () => {
    const projectId = 'proj_abc'
    const runtimeToken = 'deadbeef-cafe'
    const apiUrl = 'https://api.shogo.test'
    const { fetch: fetchImpl, calls } = makeMockFetch(() => ({
      status: 200,
      body: { callSid: 'CA1', conversationId: 'conv_1', estimatedCredits: 3 },
    }))
    const client = new HostedRuntimeTokenClient({
      runtimeToken,
      projectId,
      apiUrl,
      fetch: fetchImpl,
    })
    const result = await client.outboundCall({ to: '+15551234567' })
    expect(result.callSid).toBe('CA1')
    expect(result.conversationId).toBe('conv_1')

    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call.url).toContain('/api/voice/twilio/outbound/proj_abc')
    expect(call.url).toContain(`projectId=${encodeURIComponent(projectId)}`)
    const headers = (call.init.headers ?? {}) as Record<string, string>
    expect(headers['x-runtime-token']).toBe(runtimeToken)
    expect(headers.authorization).toBeUndefined()
    expect(headers.Authorization).toBeUndefined()
    expect(call.init.credentials).toBe('omit')
  })

  test('provisionNumber POSTs the right path and returns parsed body', async () => {
    const { fetch: fetchImpl, calls } = makeMockFetch(() => ({
      status: 200,
      body: {
        phoneNumber: '+15550001111',
        twilioPhoneSid: 'PN1',
        elevenlabsPhoneId: 'epid_1',
        creditsDebited: { setup: 100, monthly: 500 },
      },
    }))
    const client = new HostedRuntimeTokenClient({
      runtimeToken: 'rt',
      projectId: 'p1',
      apiUrl: 'http://api',
      fetch: fetchImpl,
    })
    const res = await client.provisionNumber({ areaCode: '415' })
    expect(res.phoneNumber).toBe('+15550001111')
    expect(res.creditsDebited?.setup).toBe(100)

    expect(calls[0].url).toContain('/api/voice/twilio/provision-number/p1')
    expect(calls[0].url).toContain('projectId=p1')
    expect(calls[0].init.method).toBe('POST')
  })

  test('non-2xx → TelephonyApiError with parsed body', async () => {
    const { fetch: fetchImpl } = makeMockFetch(() => ({
      status: 403,
      body: { error: 'Runtime token scope mismatch' },
    }))
    const client = new HostedRuntimeTokenClient({
      runtimeToken: 'rt',
      projectId: 'p1',
      apiUrl: 'http://api',
      fetch: fetchImpl,
    })
    await expect(client.outboundCall({ to: '+1' })).rejects.toThrow(
      /scope mismatch/i,
    )
  })

  test('URL query merging preserves existing ?limit= etc.', async () => {
    const { fetch: fetchImpl, calls } = makeMockFetch(() => ({
      status: 200,
      body: { projectId: 'p1', calls: [] },
    }))
    const client = new HostedRuntimeTokenClient({
      runtimeToken: 'rt',
      projectId: 'p1',
      apiUrl: 'http://api',
      fetch: fetchImpl,
    })
    await client.listCalls({ limit: 10, includeTranscript: true })
    const url = calls[0].url
    expect(url).toContain('limit=10')
    expect(url).toContain('includeTranscript=1')
    expect(url).toContain('projectId=p1')
    expect(url.split('?').length).toBe(2)
  })
})

describe('createTelephonyClient factory', () => {
  test('mode: runtime-token → HostedRuntimeTokenClient', () => {
    const client = createTelephonyClient({
      mode: 'runtime-token',
      runtimeToken: 'rt',
      projectId: 'p',
      apiUrl: 'http://x',
    })
    expect(client).toBeInstanceOf(HostedRuntimeTokenClient)
  })

  test('mode: hosted → HostedTelephonyClient', () => {
    const client = createTelephonyClient({
      mode: 'hosted',
      shogoApiKey: 'shogo_sk_x',
      projectId: 'p',
      apiUrl: 'http://x',
    })
    expect(client).toBeInstanceOf(HostedTelephonyClient)
  })

  test('mode: direct → DirectTelephonyClient', () => {
    const client = createTelephonyClient({
      mode: 'direct',
      elevenlabs: { apiKey: 'k', agentId: 'a' },
      twilio: { accountSid: 'AC', authToken: 't' },
    })
    expect(client).toBeInstanceOf(DirectTelephonyClient)
  })
})
