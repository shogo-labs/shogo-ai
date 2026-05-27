// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
// Extra coverage for src/elevenlabs.ts — deletePhoneNumber method
// (L424-440 in the file as of the Wave A baseline) which the original
// elevenlabs.test.ts suite never exercised.
import { describe, expect, test } from 'bun:test'
import { ElevenLabsApiError, ElevenLabsClient } from '../elevenlabs.js'

function makeFetch(responses: Array<{ status: number; body?: string | object }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = []
  let i = 0
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const method = init?.method ?? 'GET'
    const headers: Record<string, string> = {}
    if (init?.headers && !Array.isArray(init.headers) && !(init.headers instanceof Headers)) {
      for (const [k, v] of Object.entries(init.headers)) headers[k] = String(v)
    }
    calls.push({ url, method, headers })
    const next = responses[i++] ?? responses[responses.length - 1]!
    const body = typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {})
    return new Response(body, { status: next.status, headers: { 'content-type': 'application/json' } })
  }
  return { impl, calls }
}

describe('ElevenLabsClient.deletePhoneNumber', () => {
  test('resolves on 2xx success', async () => {
    const { impl, calls } = makeFetch([{ status: 204 }])
    const el = new ElevenLabsClient({ apiKey: 'xi_test', fetch: impl })
    await el.deletePhoneNumber('pn_123')
    expect(calls.length).toBe(1)
    expect(calls[0].method).toBe('DELETE')
    expect(calls[0].url).toContain('/v1/convai/phone-numbers/pn_123')
    expect(calls[0].headers['xi-api-key']).toBe('xi_test')
  })

  test('URL-encodes the phone number id', async () => {
    const { impl, calls } = makeFetch([{ status: 204 }])
    const el = new ElevenLabsClient({ apiKey: 'k', fetch: impl })
    await el.deletePhoneNumber('pn/with slash')
    expect(calls[0].url).toContain('/v1/convai/phone-numbers/pn%2Fwith%20slash')
  })

  test('treats 404 as success (already-released)', async () => {
    const { impl } = makeFetch([{ status: 404, body: 'not found' }])
    const el = new ElevenLabsClient({ apiKey: 'k', fetch: impl })
    await el.deletePhoneNumber('gone')
  })

  test('throws ElevenLabsApiError on non-2xx, non-404 statuses', async () => {
    const { impl } = makeFetch([{ status: 500, body: 'server boom' }])
    const el = new ElevenLabsClient({ apiKey: 'k', fetch: impl })
    let thrown: ElevenLabsApiError | undefined
    try {
      await el.deletePhoneNumber('pn_x')
    } catch (e) {
      thrown = e as ElevenLabsApiError
    }
    expect(thrown).toBeInstanceOf(ElevenLabsApiError)
    expect(thrown!.status).toBe(500)
    expect(thrown!.message).toContain('deletePhoneNumber failed')
    expect(String(thrown!.body)).toContain('server boom')
  })

  test('throws on 401 unauthorized', async () => {
    const { impl } = makeFetch([{ status: 401, body: 'unauthorized' }])
    const el = new ElevenLabsClient({ apiKey: 'k', fetch: impl })
    await expect(el.deletePhoneNumber('pn_x')).rejects.toBeInstanceOf(ElevenLabsApiError)
  })
})
