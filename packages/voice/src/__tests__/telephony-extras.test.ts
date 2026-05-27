// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
// Coverage closeout for src/telephony.ts — uncovered methods on
// HostedRuntimeTokenClient, HostedTelephonyClient, DirectTelephonyClient
// that the prior suites didn't reach: releaseNumber, getUsage, listCalls,
// getCall variants + direct-mode releaseNumber.
import { describe, expect, test } from 'bun:test'
import {
  DirectTelephonyClient,
  HostedRuntimeTokenClient,
  HostedTelephonyClient,
  TelephonyConfigError,
} from '../telephony.js'

function makeMockFetch(
  handler: (req: { url: string; init: RequestInit }) => { status?: number; body?: unknown },
) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString()
    calls.push({ url, init })
    const { status = 200, body } = handler({ url, init })
    return new Response(body == null ? '' : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, calls }
}

describe('HostedRuntimeTokenClient — list/get/usage/release', () => {
  const baseOpts = { runtimeToken: 'rt', projectId: 'p1', apiUrl: 'http://api' }

  test('releaseNumber DELETEs /api/voice/twilio/number/<projectId> and returns {released:true}', async () => {
    const { fetch: fetchImpl, calls } = makeMockFetch(() => ({ status: 200 }))
    const client = new HostedRuntimeTokenClient({ ...baseOpts, fetch: fetchImpl })
    const r = await client.releaseNumber()
    expect(r).toEqual({ released: true })
    expect(calls[0].url).toContain('/api/voice/twilio/number/p1')
    expect(calls[0].init.method).toBe('DELETE')
    expect(calls[0].url).toContain('projectId=p1')
  })

  test('getUsage adds from/to to the query and parses body', async () => {
    const { fetch: fetchImpl, calls } = makeMockFetch(() => ({
      status: 200,
      body: { totalCalls: 7, totalUsd: 12.5 },
    }))
    const client = new HostedRuntimeTokenClient({ ...baseOpts, fetch: fetchImpl })
    const r = await client.getUsage({ from: '2026-05-01', to: '2026-05-27' })
    expect(r).toEqual({ totalCalls: 7, totalUsd: 12.5 } as any)
    expect(calls[0].url).toContain('/api/voice/usage/p1')
    expect(calls[0].url).toContain('from=2026-05-01')
    expect(calls[0].url).toContain('to=2026-05-27')
  })

  test('getUsage with no range omits from/to but still includes projectId', async () => {
    const { fetch: fetchImpl, calls } = makeMockFetch(() => ({ status: 200, body: {} }))
    const client = new HostedRuntimeTokenClient({ ...baseOpts, fetch: fetchImpl })
    await client.getUsage()
    expect(calls[0].url).toContain('/api/voice/usage/p1')
    expect(calls[0].url).not.toContain('from=')
  })

  test('listCalls passes limit + includeTranscript and unwraps {calls:[...]}', async () => {
    const { fetch: fetchImpl, calls } = makeMockFetch(() => ({
      status: 200,
      body: { projectId: 'p1', calls: [{ callSid: 'CA1' }, { callSid: 'CA2' }] },
    }))
    const client = new HostedRuntimeTokenClient({ ...baseOpts, fetch: fetchImpl })
    const r = await client.listCalls({ limit: 5, includeTranscript: true })
    expect(r).toHaveLength(2)
    expect(r[0]).toEqual({ callSid: 'CA1' } as any)
    expect(calls[0].url).toContain('limit=5')
    expect(calls[0].url).toContain('includeTranscript=1')
  })

  test('listCalls with no opts still GETs the bare endpoint', async () => {
    const { fetch: fetchImpl, calls } = makeMockFetch(() => ({
      status: 200, body: { projectId: 'p1', calls: [] },
    }))
    const client = new HostedRuntimeTokenClient({ ...baseOpts, fetch: fetchImpl })
    const r = await client.listCalls()
    expect(r).toEqual([])
    expect(calls[0].init.method).toBe('GET')
  })

  test('getCall builds the per-call path and parses the detail', async () => {
    const { fetch: fetchImpl, calls } = makeMockFetch(() => ({
      status: 200,
      body: { callSid: 'CA42', transcript: 'hello' },
    }))
    const client = new HostedRuntimeTokenClient({ ...baseOpts, fetch: fetchImpl })
    const r = await client.getCall('CA42')
    expect(r.callSid).toBe('CA42')
    expect(calls[0].url).toContain('/api/voice/calls/p1/CA42')
  })

  test('getCall URL-encodes the callId', async () => {
    const { fetch: fetchImpl, calls } = makeMockFetch(() => ({
      status: 200, body: { callSid: 'with/slash' },
    }))
    const client = new HostedRuntimeTokenClient({ ...baseOpts, fetch: fetchImpl })
    await client.getCall('with/slash')
    expect(calls[0].url).toContain('/with%2Fslash')
  })
})

describe('HostedTelephonyClient — list/get/usage/release', () => {
  const baseOpts = { shogoApiKey: 'sk_test', projectId: 'p1', apiUrl: 'http://api' }

  test('releaseNumber DELETEs with Authorization header and returns {released:true}', async () => {
    const { fetch: fetchImpl, calls } = makeMockFetch(() => ({ status: 200 }))
    const client = new HostedTelephonyClient({ ...baseOpts, fetch: fetchImpl })
    const r = await client.releaseNumber()
    expect(r).toEqual({ released: true })
    expect(calls[0].url).toContain('/api/voice/twilio/number/p1')
    expect(calls[0].init.method).toBe('DELETE')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers['authorization'] ?? headers['Authorization']).toContain('Bearer')
  })

  test('getUsage on hosted-api-key with range', async () => {
    const { fetch: fetchImpl, calls } = makeMockFetch(() => ({
      status: 200, body: { totalCalls: 3, totalUsd: 1.5 },
    }))
    const client = new HostedTelephonyClient({ ...baseOpts, fetch: fetchImpl })
    const r = await client.getUsage({ from: 'a', to: 'b' })
    expect(r).toEqual({ totalCalls: 3, totalUsd: 1.5 } as any)
    expect(calls[0].url).toContain('from=a')
    expect(calls[0].url).toContain('to=b')
  })

  test('listCalls + getCall on hosted-api-key', async () => {
    const { fetch: fetchImpl, calls } = makeMockFetch(({ url }) => {
      if (url.includes('/CAxx')) return { status: 200, body: { callSid: 'CAxx' } }
      return { status: 200, body: { projectId: 'p1', calls: [{ callSid: 'CAxx' }] } }
    })
    const client = new HostedTelephonyClient({ ...baseOpts, fetch: fetchImpl })
    const list = await client.listCalls({ limit: 2 })
    expect(list[0]).toEqual({ callSid: 'CAxx' } as any)
    const one = await client.getCall('CAxx')
    expect(one.callSid).toBe('CAxx')
    expect(calls[0].url).toContain('limit=2')
    expect(calls[1].url).toContain('/api/voice/calls/p1/CAxx')
  })
})

describe('DirectTelephonyClient — releaseNumber', () => {
  const directOpts = {
    elevenlabs: { apiKey: 'xi', agentId: 'agt' },
    twilio: { accountSid: 'AC', authToken: 'tok' },
  } as const

  test('releases nothing when state has no Twilio nor EL phone id', async () => {
    const client = new DirectTelephonyClient(directOpts as any)
    const r = await client.releaseNumber()
    expect(r).toEqual({ released: false })
  })

  test('releases EL + Twilio when both are present, clears state', async () => {
    let elDeleted = false
    let twReleased = false
    const fakeEl = { deletePhoneNumber: async (_id: string) => { elDeleted = true } }
    const fakeTw = { releaseNumber: async (_sid: string) => { twReleased = true } }
    const client = new DirectTelephonyClient(directOpts as any)
    ;(client as any).el = fakeEl
    ;(client as any).tw = fakeTw
    ;(client as any).state = { twilioSid: 'PN1', elevenlabsPhoneId: 'epid1' }
    const r = await client.releaseNumber()
    expect(r).toEqual({ released: true })
    expect(elDeleted).toBe(true)
    expect(twReleased).toBe(true)
    expect((client as any).state).toEqual({})
  })

  test('getUsage throws TelephonyConfigError (Mode A has no Shogo billing)', async () => {
    const client = new DirectTelephonyClient(directOpts as any)
    await expect(client.getUsage()).rejects.toThrow(TelephonyConfigError)
  })
})
