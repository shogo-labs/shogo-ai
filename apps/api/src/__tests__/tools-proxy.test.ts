// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tools Proxy Tests
 *
 * Validates the third-party tools passthrough proxy:
 * - Response headers are sanitized (content-encoding/content-length stripped)
 * - Auth enforcement (missing/invalid tokens rejected)
 * - Upstream path extraction
 *
 * The content-encoding regression is critical: Bun's fetch() auto-decompresses
 * gzip/br responses but the proxy was forwarding the original content-encoding
 * header, causing downstream clients to try decompressing already-decompressed
 * data (ZlibError). See commit b9188d75.
 *
 * Run: bun test apps/api/src/__tests__/tools-proxy.test.ts
 */

import { afterEach, beforeEach, describe, test, expect, mock } from 'bun:test'
import { Hono } from 'hono'

const resolveApiKeyMock = mock(async (_key: string) => null as any)

mock.module('../routes/api-keys', () => ({
  resolveApiKey: resolveApiKeyMock,
}))

const ENV_KEYS = [
  'AI_PROXY_SECRET',
  'COMPOSIO_API_KEY',
  'SERPER_API_KEY',
  'OPENAI_API_KEY',
  'SHOGO_API_KEY',
  'SHOGO_CLOUD_URL',
  'LOCAL_LLM_BASE_URL',
  'LOCAL_EMBEDDING_MODEL',
  'LOCAL_EMBEDDING_DIMENSIONS',
] as const
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.env.AI_PROXY_SECRET = 'tools-proxy-test-secret'
  resolveApiKeyMock.mockClear()
  resolveApiKeyMock.mockImplementation(async () => null)
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  delete (globalThis as any).fetch
})

async function makeToken() {
  const { generateProxyToken } = await import('../lib/ai-proxy-token')
  return generateProxyToken('project-1', 'workspace-1', 'user-1')
}

async function makeApp() {
  const { toolsProxyRoutes } = await import('../routes/tools-proxy')
  const app = new Hono()
  app.route('/', toolsProxyRoutes())
  return app
}

describe('Tools Proxy', () => {
  describe('Response header sanitization (ZlibError regression)', () => {
    // The actual skip-list constants live in `apps/api/src/lib/proxy-headers.ts`
    // (shared with marketplace.ts and integrations.ts). These tests assert
    // that tools-proxy uses the response-flavoured skip list (which strips
    // content-encoding/content-length) when building the response, and the
    // request-flavoured skip list (which doesn't) when forwarding.

    test('RESPONSE_FORWARD_SKIP_HEADERS contains content-encoding and content-length', async () => {
      const { RESPONSE_FORWARD_SKIP_HEADERS } = await import('../lib/proxy-headers')
      expect(RESPONSE_FORWARD_SKIP_HEADERS.has('content-encoding')).toBe(true)
      expect(RESPONSE_FORWARD_SKIP_HEADERS.has('content-length')).toBe(true)
      expect(RESPONSE_FORWARD_SKIP_HEADERS.has('transfer-encoding')).toBe(true)
    })

    test('REQUEST_FORWARD_SKIP_HEADERS does not strip content-encoding (request bodies are passed through verbatim)', async () => {
      const { REQUEST_FORWARD_SKIP_HEADERS } = await import('../lib/proxy-headers')
      expect(REQUEST_FORWARD_SKIP_HEADERS.has('content-encoding')).toBe(false)
      expect(REQUEST_FORWARD_SKIP_HEADERS.has('content-length')).toBe(false)
      // Hop-by-hop headers ARE stripped from requests too.
      expect(REQUEST_FORWARD_SKIP_HEADERS.has('host')).toBe(true)
      expect(REQUEST_FORWARD_SKIP_HEADERS.has('transfer-encoding')).toBe(true)
    })

    test('tools-proxy uses shouldSkipResponseHeader for response filtering and shouldSkipForwardedHeader for request forwarding', async () => {
      const source = await Bun.file(
        require.resolve('../routes/tools-proxy.ts'),
      ).text()

      const responseBlock = source.match(
        /const responseHeaders[\s\S]*?return new Response/,
      )
      expect(responseBlock).toBeTruthy()
      expect(responseBlock![0]).toContain('shouldSkipResponseHeader')
      expect(responseBlock![0]).not.toContain('shouldSkipForwardedHeader')

      const requestBlock = source.match(
        /const headers = new Headers\(\)[\s\S]*?const upstream/,
      )
      expect(requestBlock).toBeTruthy()
      expect(requestBlock![0]).toContain('shouldSkipForwardedHeader')
      expect(requestBlock![0]).not.toContain('shouldSkipResponseHeader')
    })

    test('simulated header filtering strips encoding headers from responses', async () => {
      const { shouldSkipResponseHeader } = await import('../lib/proxy-headers')

      // Simulate upstream response headers (what Composio actually returns)
      const upstreamHeaders = new Map([
        ['content-type', 'application/json'],
        ['content-encoding', 'gzip'],
        ['content-length', '12345'],
        ['x-request-id', 'abc-123'],
        ['transfer-encoding', 'chunked'],
      ])

      const filtered = new Map<string, string>()
      for (const [key, value] of upstreamHeaders) {
        if (!shouldSkipResponseHeader(key)) {
          filtered.set(key, value)
        }
      }

      expect(filtered.has('content-encoding')).toBe(false)
      expect(filtered.has('content-length')).toBe(false)
      expect(filtered.has('transfer-encoding')).toBe(false)
      expect(filtered.has('content-type')).toBe(true)
      expect(filtered.get('content-type')).toBe('application/json')
      expect(filtered.has('x-request-id')).toBe(true)
    })
  })

  describe('extractUpstreamPath', () => {
    function extractUpstreamPath(fullPath: string, servicePrefix: string): string {
      const idx = fullPath.indexOf(`/tools/${servicePrefix}`)
      if (idx === -1) return '/'
      return fullPath.slice(idx + `/tools/${servicePrefix}`.length) || '/'
    }

    test('extracts path after service prefix', () => {
      expect(extractUpstreamPath('/api/tools/composio/api/v3/toolkits', 'composio'))
        .toBe('/api/v3/toolkits')
      expect(extractUpstreamPath('/api/tools/serper/search', 'serper'))
        .toBe('/search')
      expect(extractUpstreamPath('/api/tools/openai/v1/embeddings', 'openai'))
        .toBe('/v1/embeddings')
    })

    test('returns / for unmatched paths', () => {
      expect(extractUpstreamPath('/something/else', 'composio')).toBe('/')
    })

    test('returns / for prefix-only paths', () => {
      expect(extractUpstreamPath('/tools/composio', 'composio')).toBe('/')
    })
  })

  describe('Auth enforcement', () => {
    test('rejects requests without a token', async () => {
      const app = await makeApp()

      const res = await app.request('/tools/composio/api/v3/toolkits')
      expect(res.status).toBe(401)
      const body = await res.json() as any
      expect(body.error).toContain('Missing proxy token')
    })

    test('rejects requests with an invalid token', async () => {
      const app = await makeApp()

      const res = await app.request('/tools/composio/api/v3/toolkits', {
        headers: { 'x-api-key': 'invalid-token' },
      })
      expect(res.status).toBe(401)
      const body = await res.json() as any
      expect(body.error).toContain('Invalid or expired')
    })
  })

  describe('Forwarding routes', () => {
    test('returns 503 when the upstream API key is not configured locally', async () => {
      const app = await makeApp()
      const token = await makeToken()

      const res = await app.request('/tools/composio/api/v3/toolkits', {
        headers: { 'x-api-key': token },
      })

      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({
        error: 'COMPOSIO_API_KEY not configured on API server',
      })
    })

    test('forwards local Composio requests with sanitized request and response headers', async () => {
      const app = await makeApp()
      const token = await makeToken()
      const calls: any[] = []
      process.env.COMPOSIO_API_KEY = 'real-composio-key'
      globalThis.fetch = (async (url: string, init: any) => {
        calls.push({ url, init })
        return new Response('ok', {
          status: 201,
          statusText: 'Created',
          headers: {
            'content-type': 'application/json',
            'content-encoding': 'gzip',
            'content-length': '123',
            'x-upstream-id': 'req-1',
          },
        })
      }) as any

      const res = await app.request('/tools/composio/api/v3/toolkits?limit=1', {
        headers: {
          'x-api-key': token,
          host: 'api.local',
          'x-custom': 'keep-me',
        },
      })

      expect(calls[0].url).toBe('https://backend.composio.dev/api/v3/toolkits?limit=1')
      expect(calls[0].init.headers.get('x-api-key')).toBe('real-composio-key')
      expect(calls[0].init.headers.get('x-custom')).toBe('keep-me')
      expect(calls[0].init.headers.get('host')).toBeNull()
      expect(res.status).toBe(201)
      expect(res.headers.get('content-encoding')).toBeNull()
      expect(res.headers.get('content-length')).toBeNull()
      expect(res.headers.get('x-upstream-id')).toBe('req-1')
    })

    test('forwards to Shogo Cloud when SHOGO_API_KEY is configured', async () => {
      const app = await makeApp()
      const token = await makeToken()
      const calls: any[] = []
      process.env.SHOGO_API_KEY = 'shogo-cloud-key'
      process.env.SHOGO_CLOUD_URL = 'https://cloud.example/'
      globalThis.fetch = (async (url: string, init: any) => {
        calls.push({ url, init })
        return new Response('cloud-ok', { headers: { 'x-cloud': 'yes' } })
      }) as any

      const res = await app.request('/tools/serper/search?q=agents', {
        headers: {
          authorization: `Bearer ${token}`,
          'x-original': 'present',
        },
      })

      expect(calls[0].url).toBe('https://cloud.example/api/tools/serper/search?q=agents')
      expect(calls[0].init.headers.get('Authorization')).toBe('Bearer shogo-cloud-key')
      expect(calls[0].init.headers.get('x-original')).toBe('present')
      expect(await res.text()).toBe('cloud-ok')
    })

    test('rewrites local OpenAI embedding requests to the configured local model', async () => {
      const app = await makeApp()
      const token = await makeToken()
      const calls: any[] = []
      process.env.LOCAL_LLM_BASE_URL = 'http://localhost:11434/'
      process.env.LOCAL_EMBEDDING_MODEL = 'nomic-embed-text'
      process.env.LOCAL_EMBEDDING_DIMENSIONS = '768'
      globalThis.fetch = (async (url: string, init: any) => {
        calls.push({ url, init })
        return Response.json({ data: [] })
      }) as any

      const res = await app.request('/tools/openai/v1/embeddings', {
        method: 'POST',
        headers: {
          'x-api-key': token,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ input: 'hello', model: 'ignored' }),
      })

      expect(calls[0].url).toBe('http://localhost:11434/v1/embeddings')
      expect(JSON.parse(calls[0].init.body)).toEqual({
        input: 'hello',
        model: 'nomic-embed-text',
        dimensions: 768,
      })
      expect(res.status).toBe(200)
    })

    test('falls back to streaming request body when local embedding JSON parse fails', async () => {
      const app = await makeApp()
      const token = await makeToken()
      const calls: any[] = []
      process.env.LOCAL_LLM_BASE_URL = 'http://localhost:11434'
      process.env.LOCAL_EMBEDDING_MODEL = 'nomic-embed-text'
      globalThis.fetch = (async (url: string, init: any) => {
        calls.push({ url, init })
        return Response.json({ data: [] })
      }) as any

      const res = await app.request('/tools/openai/v1/embeddings', {
        method: 'POST',
        headers: { 'x-api-key': token },
        body: 'not-json',
      })

      expect(calls[0].url).toBe('http://localhost:11434/v1/embeddings')
      expect(calls[0].init.body).toBeDefined()
      expect(res.status).toBe(200)
    })

    test('accepts shogo_sk API keys as legacy proxy auth', async () => {
      resolveApiKeyMock.mockImplementationOnce(async () => ({
        userId: 'user-1',
        workspaceId: 'workspace-1',
      }))
      const app = await makeApp()
      process.env.SERPER_API_KEY = 'serper-key'
      globalThis.fetch = (async () => Response.json({ ok: true })) as any

      const res = await app.request('/tools/serper/search', {
        headers: { 'x-api-key': 'shogo_sk_test' },
      })

      expect(res.status).toBe(200)
    })

    test('shogo_sk_ token: resolveApiKey returns ws → projectId ws_{workspaceId}', async () => {
      resolveApiKeyMock.mockImplementation(async () => ({ workspaceId: 'w-77', userId: 'u-77' }) as any)
      process.env.OPENAI_API_KEY = 'sk-openai-real'
      const calls: any[] = []
      globalThis.fetch = (async (url: string, init: any) => {
        calls.push({ url, init })
        return Response.json({ ok: true })
      }) as any

      const app = await makeApp()
      const res = await app.request('/tools/openai/v1/embeddings', {
        method: 'POST',
        headers: { authorization: 'Bearer shogo_sk_validkey' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(200)
      expect(calls[0].url).toBe('https://api.openai.com/v1/embeddings')
      expect(resolveApiKeyMock).toHaveBeenCalled()
    })

    test('shogo_sk_ token: resolveApiKey throws → catch swallows → 401', async () => {
      resolveApiKeyMock.mockImplementation(async () => {
        throw new Error('db down')
      })

      const app = await makeApp()
      const res = await app.request('/tools/serper/search', {
        headers: { authorization: 'Bearer shogo_sk_bad' },
      })
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'Invalid or expired proxy token' })
    })

    test('OpenAI non-embedding path forwards with Authorization: Bearer header', async () => {
      process.env.OPENAI_API_KEY = 'sk-openai-real'
      const calls: any[] = []
      globalThis.fetch = (async (url: string, init: any) => {
        calls.push({ url, init })
        return Response.json({ ok: true })
      }) as any

      const app = await makeApp()
      const token = await makeToken()
      const res = await app.request('/tools/openai/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: 'gpt-4o' }),
      })
      expect(res.status).toBe(200)
      expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions')
      expect(calls[0].init.headers.get('Authorization')).toBe('Bearer sk-openai-real')
    })
  })
})
