// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
// Extra coverage for shared/sessionPayload.ts fetchSignedUrl (L131-140).
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { fetchSignedUrl } from '../shared/sessionPayload.js'

const origFetch = globalThis.fetch
let lastInit: any = null

afterEach(() => {
  globalThis.fetch = origFetch
  lastInit = null
})

describe('fetchSignedUrl', () => {
  test('passes credentials and authHeaders to fetch and returns parsed JSON', async () => {
    globalThis.fetch = (async (_url: string, init: any) => {
      lastInit = init
      return new Response(JSON.stringify({ signed_url: 'wss://x' }), { status: 200 })
    }) as any
    const r = await fetchSignedUrl({
      path: '/api/voice/signed-url?projectId=p',
      fetchCredentials: 'include',
      authHeaders: () => ({ 'x-auth': 'abc' }),
    })
    expect(r).toEqual({ signed_url: 'wss://x' } as any)
    expect(lastInit.credentials).toBe('include')
    expect(lastInit.headers['x-auth']).toBe('abc')
  })

  test('throws when response is not ok', async () => {
    globalThis.fetch = (async () =>
      new Response('forbidden', { status: 403 })) as any
    await expect(
      fetchSignedUrl({
        path: '/x',
        fetchCredentials: 'include',
        authHeaders: () => ({}),
      }),
    ).rejects.toThrow(/Signed URL request failed: 403/)
  })

  test('passes "omit" credentials through', async () => {
    globalThis.fetch = (async (_url: string, init: any) => {
      lastInit = init
      return new Response('{}', { status: 200 })
    }) as any
    await fetchSignedUrl({ path: '/x', fetchCredentials: 'omit', authHeaders: () => ({}) })
    expect(lastInit.credentials).toBe('omit')
  })
})
