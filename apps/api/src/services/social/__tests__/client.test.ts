// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  LOCAL_SCOPE_HEADER,
  SOCIAL_RELAY_PATH,
  SocialError,
  getSocialClient,
  resolveSocialClientConfig,
  setSocialClient,
} from '../client'

const originalFetch = globalThis.fetch
const savedEnv = {
  SHOGO_LOCAL_MODE: process.env.SHOGO_LOCAL_MODE,
  SHOGO_API_KEY: process.env.SHOGO_API_KEY,
  ZERNIO_API_KEY: process.env.ZERNIO_API_KEY,
  ZERNIO_USER_API_KEY: process.env.ZERNIO_USER_API_KEY,
  SOCIAL_MODE: process.env.SOCIAL_MODE,
}

function useCloudEnv() {
  delete process.env.SHOGO_LOCAL_MODE
  delete process.env.SHOGO_API_KEY
  delete process.env.ZERNIO_USER_API_KEY
  delete process.env.SOCIAL_MODE
  process.env.ZERNIO_API_KEY = 'zernio_master'
}

beforeEach(() => {
  useCloudEnv()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  setSocialClient(null)
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = value
  }
})

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

describe('social client mode', () => {
  test('the cloud uses the master key directly', () => {
    const config = resolveSocialClientConfig({ ZERNIO_API_KEY: 'zernio_master' } as any)
    expect(config.mode).toBe('cloud')
    expect(config.baseUrl).toBe('https://zernio.com/api/v1')
  })

  test('a desktop forwards to the cloud relay with SHOGO_API_KEY', () => {
    const config = resolveSocialClientConfig({
      SHOGO_API_KEY: 'shogo_sk_desktop',
      ZERNIO_USER_API_KEY: 'ignored_unless_byok',
    } as any)
    expect(config.mode).toBe('relay')
    expect(config.baseUrl.endsWith(SOCIAL_RELAY_PATH)).toBe(true)
    expect(config.apiKey).toBe('shogo_sk_desktop')
  })

  test('BYOK bypasses the relay entirely', () => {
    const config = resolveSocialClientConfig({
      SOCIAL_MODE: 'byok',
      ZERNIO_USER_API_KEY: 'zernio_user',
      SHOGO_API_KEY: 'shogo_sk_desktop',
    } as any)
    expect(config.mode).toBe('byok')
    expect(config.baseUrl).toBe('https://zernio.com/api/v1')
    expect(config.apiKey).toBe('zernio_user')
  })

  test('byok without a user key falls back to the relay', () => {
    const config = resolveSocialClientConfig({ SOCIAL_MODE: 'byok', SHOGO_API_KEY: 'shogo_sk_desktop' } as any)
    expect(config.mode).toBe('relay')
  })

  test('an unconfigured cloud refuses with an actionable error', () => {
    expect(() => resolveSocialClientConfig({} as any)).toThrow(SocialError)
    try {
      resolveSocialClientConfig({} as any)
    } catch (err) {
      expect((err as SocialError).status).toBe(503)
      expect((err as SocialError).code).toBe('social_not_configured')
    }
  })
})

describe('social client requests', () => {
  beforeEach(() => {
    setSocialClient(null)
    useCloudEnv()
  })

  test('normalises a provider error to Zernio’s documented shape', async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse(
        { error: 'Instagram rate limited', type: 'rate_limited', platform: 'instagram', docUrl: 'https://docs.zernio.com' },
        400,
      ),
    ) as any

    const client = getSocialClient()
    const error = await client.request({ method: 'GET', path: '/accounts' }).catch((err) => err)
    expect(error).toBeInstanceOf(SocialError)
    expect((error as SocialError).status).toBe(400)
    expect((error as SocialError).code).toBe('rate_limited')
    expect((error as SocialError).details.platform).toBe('instagram')
    expect((error as SocialError).details.docUrl).toBe('https://docs.zernio.com')
  })

  test('retries once on 429 and honours Retry-After', async () => {
    const bodies = [jsonResponse({ error: 'slow down' }, 429, { 'retry-after': '0' }), jsonResponse({ data: [] })]
    let calls = 0
    globalThis.fetch = mock(async () => bodies[calls++]!) as any

    const result = await getSocialClient().request({ method: 'GET', path: '/accounts' })
    expect(result).toEqual({ data: [] })
    expect(calls).toBe(2)
  })

  test('sends the idempotency key and bearer token', async () => {
    let seen: { url: string; init: any } | null = null
    globalThis.fetch = mock(async (url: any, init: any) => {
      seen = { url: String(url), init }
      return jsonResponse({ id: 'post_1' })
    }) as any

    await getSocialClient().request({
      method: 'POST',
      path: '/posts',
      body: { content: 'hello' },
      idempotencyKey: 'abc123',
    })

    expect(seen!.url).toBe('https://zernio.com/api/v1/posts')
    expect(seen!.init.headers.Authorization).toBe('Bearer zernio_master')
    expect(seen!.init.headers['Idempotency-Key']).toBe('abc123')
    expect(JSON.parse(seen!.init.body)).toEqual({ content: 'hello' })
  })

  test('relays the local workspace scope so the cloud can keep one profile per scope', async () => {
    process.env.SHOGO_LOCAL_MODE = '1'
    process.env.SHOGO_API_KEY = 'shogo_sk_desktop'
    process.env.SOCIAL_MODE = 'relay'
    delete process.env.ZERNIO_API_KEY

    const localWorkspaceId = crypto.randomUUID()
    let seen: any = null
    globalThis.fetch = mock(async (_url: any, init: any) => {
      seen = init
      return jsonResponse({ profiles: [] })
    }) as any

    await getSocialClient().request({ method: 'GET', path: '/profiles', workspaceId: localWorkspaceId })

    // The cloud reads this together with the key: this desktop's own workspace
    // is a scope of its own, not the cloud workspace the key belongs to.
    expect(seen.headers[LOCAL_SCOPE_HEADER]).toBe(localWorkspaceId)
  })

  test('a call with no workspace scope sends no scope header', async () => {
    process.env.SHOGO_LOCAL_MODE = '1'
    process.env.SHOGO_API_KEY = 'shogo_sk_desktop'
    process.env.SOCIAL_MODE = 'relay'
    delete process.env.ZERNIO_API_KEY

    let seen: any = null
    globalThis.fetch = mock(async (_url: any, init: any) => {
      seen = init
      return jsonResponse({ id: 'post_1' })
    }) as any

    await getSocialClient().request({ method: 'GET', path: '/profiles' })
    expect(seen.headers[LOCAL_SCOPE_HEADER]).toBeUndefined()
  })

  test('an unreachable provider is a 502, not a thrown fetch error', async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError('fetch failed')
    }) as any

    const error = await getSocialClient()
      .request({ method: 'GET', path: '/profiles' })
      .catch((err) => err)
    expect(error).toBeInstanceOf(SocialError)
    expect((error as SocialError).status).toBe(502)
  })
})
