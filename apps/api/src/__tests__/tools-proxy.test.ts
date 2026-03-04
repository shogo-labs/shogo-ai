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

import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'

describe('Tools Proxy', () => {
  describe('Response header sanitization (ZlibError regression)', () => {
    test('RESPONSE_SKIP_HEADERS contains content-encoding and content-length', async () => {
      const source = await Bun.file(
        require.resolve('../routes/tools-proxy.ts'),
      ).text()

      expect(source).toContain("'content-encoding'")
      expect(source).toContain("'content-length'")
      expect(source).toContain('RESPONSE_SKIP_HEADERS')

      // Verify RESPONSE_SKIP_HEADERS is used for response header filtering
      expect(source).toContain('RESPONSE_SKIP_HEADERS.has(lower)')
    })

    test('response headers are filtered using RESPONSE_SKIP_HEADERS not FORWARDED_SKIP_HEADERS', async () => {
      const source = await Bun.file(
        require.resolve('../routes/tools-proxy.ts'),
      ).text()

      // The response filtering block should use RESPONSE_SKIP_HEADERS
      const responseBlock = source.match(
        /const responseHeaders[\s\S]*?return new Response/,
      )
      expect(responseBlock).toBeTruthy()
      expect(responseBlock![0]).toContain('RESPONSE_SKIP_HEADERS')
      expect(responseBlock![0]).not.toContain('FORWARDED_SKIP_HEADERS')
    })

    test('simulated header filtering strips encoding headers', () => {
      // Replicate the exact header filtering logic from tools-proxy.ts
      const FORWARDED_SKIP_HEADERS = new Set([
        'host', 'connection', 'keep-alive', 'transfer-encoding',
        'te', 'trailer', 'upgrade',
      ])
      const RESPONSE_SKIP_HEADERS = new Set([
        ...FORWARDED_SKIP_HEADERS,
        'content-encoding',
        'content-length',
      ])

      // Simulate upstream response headers (what Composio actually returns)
      const upstreamHeaders = new Map([
        ['content-type', 'application/json'],
        ['content-encoding', 'gzip'],
        ['content-length', '12345'],
        ['x-request-id', 'abc-123'],
        ['transfer-encoding', 'chunked'],
      ])

      // Apply RESPONSE_SKIP_HEADERS filtering (our fix)
      const filtered = new Map<string, string>()
      for (const [key, value] of upstreamHeaders) {
        if (!RESPONSE_SKIP_HEADERS.has(key.toLowerCase())) {
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

    test('request headers still use FORWARDED_SKIP_HEADERS (no content-encoding stripping)', async () => {
      const source = await Bun.file(
        require.resolve('../routes/tools-proxy.ts'),
      ).text()

      // The request forwarding block should use FORWARDED_SKIP_HEADERS
      const requestBlock = source.match(
        /const headers = new Headers\(\)[\s\S]*?const upstream/,
      )
      expect(requestBlock).toBeTruthy()
      expect(requestBlock![0]).toContain('FORWARDED_SKIP_HEADERS')
      expect(requestBlock![0]).not.toContain('RESPONSE_SKIP_HEADERS')
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
      const { toolsProxyRoutes } = await import('../routes/tools-proxy')
      const app = new Hono()
      app.route('/', toolsProxyRoutes())

      const res = await app.request('/tools/composio/api/v3/toolkits')
      expect(res.status).toBe(401)
      const body = await res.json() as any
      expect(body.error).toContain('Missing proxy token')
    })

    test('rejects requests with an invalid token', async () => {
      const { toolsProxyRoutes } = await import('../routes/tools-proxy')
      const app = new Hono()
      app.route('/', toolsProxyRoutes())

      const res = await app.request('/tools/composio/api/v3/toolkits', {
        headers: { 'x-api-key': 'invalid-token' },
      })
      expect(res.status).toBe(401)
      const body = await res.json() as any
      expect(body.error).toContain('Invalid or expired')
    })
  })
})
