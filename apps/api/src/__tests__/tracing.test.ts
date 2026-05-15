// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Mock @opentelemetry/api BEFORE importing the middleware. We capture
// every span method call so we can assert on the lifecycle.
type Span = {
  setAttribute: ReturnType<typeof mock>
  setStatus: ReturnType<typeof mock>
  recordException: ReturnType<typeof mock>
  updateName: ReturnType<typeof mock>
  end: ReturnType<typeof mock>
}

let lastSpan: Span | null = null
let startActiveCalls: { name: string; opts: any }[] = []

function makeSpan(): Span {
  return {
    setAttribute: mock(() => {}),
    setStatus: mock(() => {}),
    recordException: mock(() => {}),
    updateName: mock(() => {}),
    end: mock(() => {}),
  }
}

mock.module('@opentelemetry/api', () => {
  const startActiveSpan = mock(async (name: string, opts: any, fn: (s: Span) => unknown) => {
    const span = makeSpan()
    lastSpan = span
    startActiveCalls.push({ name, opts })
    return await fn(span)
  })
  return {
    trace: { getTracer: () => ({ startActiveSpan }) },
    SpanKind: { SERVER: 'SERVER' },
    SpanStatusCode: { ERROR: 'ERROR', UNSET: 'UNSET', OK: 'OK' },
    context: {},
  }
})

const { tracingMiddleware } = await import('../middleware/tracing')

// Build a minimal Hono-Context-shaped object that the middleware actually reads.
function makeCtx(opts: {
  method?: string
  path: string
  url?: string
  userAgent?: string
  routePath?: string
  status?: number
}) {
  const status = opts.status ?? 200
  return {
    req: {
      path: opts.path,
      method: opts.method ?? 'GET',
      url: opts.url ?? `http://localhost${opts.path}`,
      routePath: opts.routePath,
      header: (k: string) => (k === 'user-agent' ? opts.userAgent ?? '' : undefined),
    },
    res: { status },
  } as unknown as Parameters<typeof tracingMiddleware>[0]
}

beforeEach(() => {
  lastSpan = null
  startActiveCalls = []
})

describe('tracingMiddleware — path filtering', () => {
  test('skips span creation for /api/health', async () => {
    const ctx = makeCtx({ path: '/api/health' })
    const next = mock(async () => {})
    await tracingMiddleware(ctx, next)

    expect(startActiveCalls).toHaveLength(0)
    expect(next).toHaveBeenCalledTimes(1)
  })

  test('skips span creation for /healthz', async () => {
    const ctx = makeCtx({ path: '/healthz' })
    const next = mock(async () => {})
    await tracingMiddleware(ctx, next)
    expect(startActiveCalls).toHaveLength(0)
    expect(next).toHaveBeenCalledTimes(1)
  })

  test('skips span creation for /ready', async () => {
    const ctx = makeCtx({ path: '/ready' })
    const next = mock(async () => {})
    await tracingMiddleware(ctx, next)
    expect(startActiveCalls).toHaveLength(0)
  })

  test('DOES create a span for paths that merely contain "health" but are not exact matches', async () => {
    const ctx = makeCtx({ path: '/api/health/check' })
    const next = mock(async () => {})
    await tracingMiddleware(ctx, next)
    expect(startActiveCalls).toHaveLength(1)
  })
})

describe('tracingMiddleware — path normalization for span name', () => {
  test('replaces a UUID in the path with :id', async () => {
    const ctx = makeCtx({
      method: 'GET',
      path: '/api/projects/123e4567-e89b-12d3-a456-426614174000/files',
    })
    await tracingMiddleware(ctx, async () => {})
    expect(startActiveCalls[0].name).toBe('GET /api/projects/:id/files')
  })

  test('replaces multiple UUIDs in the same path', async () => {
    const ctx = makeCtx({
      path: '/api/projects/123e4567-e89b-12d3-a456-426614174000/files/abcdef12-3456-7890-abcd-ef1234567890',
    })
    await tracingMiddleware(ctx, async () => {})
    expect(startActiveCalls[0].name).toBe('GET /api/projects/:id/files/:id')
  })

  test('UUID match is case-insensitive', async () => {
    const ctx = makeCtx({
      path: '/api/x/123E4567-E89B-12D3-A456-426614174000',
    })
    await tracingMiddleware(ctx, async () => {})
    expect(startActiveCalls[0].name).toBe('GET /api/x/:id')
  })

  test('replaces cuid-style ids (20-30 lowercase alphanumerics between slashes)', async () => {
    const ctx = makeCtx({
      path: '/api/x/clxabc1234567890abcdef/items',
    })
    await tracingMiddleware(ctx, async () => {})
    expect(startActiveCalls[0].name).toBe('GET /api/x/:id/items')
  })

  test('replaces cuid at end of path (no trailing slash)', async () => {
    const ctx = makeCtx({
      path: '/api/x/clxabc1234567890abcdef',
    })
    await tracingMiddleware(ctx, async () => {})
    expect(startActiveCalls[0].name).toBe('GET /api/x/:id')
  })

  test('does NOT replace short ids (< 20 chars)', async () => {
    const ctx = makeCtx({ path: '/api/x/short' })
    await tracingMiddleware(ctx, async () => {})
    expect(startActiveCalls[0].name).toBe('GET /api/x/short')
  })

  test('does NOT replace ids with uppercase chars (cuid is lowercase)', async () => {
    const ctx = makeCtx({ path: '/api/x/CLXABC1234567890ABCDEF/items' })
    await tracingMiddleware(ctx, async () => {})
    expect(startActiveCalls[0].name).toBe('GET /api/x/CLXABC1234567890ABCDEF/items')
  })

  test('uses the HTTP method in the span name', async () => {
    const ctx = makeCtx({ method: 'POST', path: '/api/x' })
    await tracingMiddleware(ctx, async () => {})
    expect(startActiveCalls[0].name).toBe('POST /api/x')
  })
})

describe('tracingMiddleware — span attributes', () => {
  test('sets http.method, target, url, route, user_agent on span start', async () => {
    const ctx = makeCtx({
      method: 'PUT',
      path: '/api/items/123e4567-e89b-12d3-a456-426614174000',
      url: 'http://example.test/api/items/123e4567-e89b-12d3-a456-426614174000?q=1',
      userAgent: 'curl/8.0',
    })
    await tracingMiddleware(ctx, async () => {})

    const attrs = startActiveCalls[0].opts.attributes
    expect(attrs['http.method']).toBe('PUT')
    expect(attrs['http.target']).toBe('/api/items/123e4567-e89b-12d3-a456-426614174000')
    expect(attrs['http.url']).toBe('http://example.test/api/items/123e4567-e89b-12d3-a456-426614174000?q=1')
    expect(attrs['http.route']).toBe('/api/items/:id')
    expect(attrs['http.user_agent']).toBe('curl/8.0')
  })

  test('defaults user_agent to empty string when header is missing', async () => {
    const ctx = makeCtx({ path: '/api/x' })
    await tracingMiddleware(ctx, async () => {})
    expect(startActiveCalls[0].opts.attributes['http.user_agent']).toBe('')
  })

  test('span kind is SERVER', async () => {
    const ctx = makeCtx({ path: '/api/x' })
    await tracingMiddleware(ctx, async () => {})
    expect(startActiveCalls[0].opts.kind).toBe('SERVER')
  })

  test('records http.status_code after next() completes', async () => {
    const ctx = makeCtx({ path: '/api/x', status: 201 })
    await tracingMiddleware(ctx, async () => {})
    const calls = lastSpan!.setAttribute.mock.calls
    const statusCall = calls.find((c) => c[0] === 'http.status_code')
    expect(statusCall).toBeDefined()
    expect(statusCall![1]).toBe(201)
  })
})

describe('tracingMiddleware — status code → span status mapping', () => {
  test('5xx response sets span status to ERROR with "HTTP <code>" message', async () => {
    const ctx = makeCtx({ path: '/api/x', status: 503 })
    await tracingMiddleware(ctx, async () => {})
    expect(lastSpan!.setStatus).toHaveBeenCalledWith({
      code: 'ERROR',
      message: 'HTTP 503',
    })
  })

  test('4xx response sets span status to UNSET and attribute http.error_type', async () => {
    const ctx = makeCtx({ path: '/api/x', status: 404 })
    await tracingMiddleware(ctx, async () => {})
    expect(lastSpan!.setStatus).toHaveBeenCalledWith({ code: 'UNSET' })
    const errType = lastSpan!.setAttribute.mock.calls.find((c) => c[0] === 'http.error_type')
    expect(errType![1]).toBe('404')
  })

  test('2xx response sets no extra status / error_type', async () => {
    const ctx = makeCtx({ path: '/api/x', status: 200 })
    await tracingMiddleware(ctx, async () => {})
    expect(lastSpan!.setStatus).not.toHaveBeenCalled()
    const errType = lastSpan!.setAttribute.mock.calls.find((c) => c[0] === 'http.error_type')
    expect(errType).toBeUndefined()
  })

  test('3xx redirect is treated as non-error (no setStatus call)', async () => {
    const ctx = makeCtx({ path: '/api/x', status: 302 })
    await tracingMiddleware(ctx, async () => {})
    expect(lastSpan!.setStatus).not.toHaveBeenCalled()
  })

  test('exact boundary 400 sets UNSET + error_type, 500 sets ERROR', async () => {
    const ctx400 = makeCtx({ path: '/api/a', status: 400 })
    await tracingMiddleware(ctx400, async () => {})
    expect(lastSpan!.setStatus).toHaveBeenCalledWith({ code: 'UNSET' })

    const ctx500 = makeCtx({ path: '/api/b', status: 500 })
    await tracingMiddleware(ctx500, async () => {})
    expect(lastSpan!.setStatus).toHaveBeenCalledWith({
      code: 'ERROR',
      message: 'HTTP 500',
    })
  })
})

describe('tracingMiddleware — thrown errors', () => {
  test('records the exception, sets ERROR status, and re-throws', async () => {
    const ctx = makeCtx({ path: '/api/x' })
    const boom = new Error('boom!')
    await expect(
      tracingMiddleware(ctx, async () => {
        throw boom
      })
    ).rejects.toThrow('boom!')
    expect(lastSpan!.setStatus).toHaveBeenCalledWith({ code: 'ERROR', message: 'boom!' })
    expect(lastSpan!.recordException).toHaveBeenCalledWith(boom)
  })

  test('still calls span.end() even when next() throws', async () => {
    const ctx = makeCtx({ path: '/api/x' })
    await expect(
      tracingMiddleware(ctx, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow()
    expect(lastSpan!.end).toHaveBeenCalledTimes(1)
  })
})

describe('tracingMiddleware — routePath integration (finally block)', () => {
  test('updates http.route + span name from Hono routePath when available', async () => {
    const ctx = makeCtx({
      method: 'GET',
      path: '/api/items/123e4567-e89b-12d3-a456-426614174000',
      routePath: '/api/items/:itemId',
    })
    await tracingMiddleware(ctx, async () => {})

    const routeAttr = lastSpan!.setAttribute.mock.calls.find((c) => c[0] === 'http.route')
    expect(routeAttr![1]).toBe('/api/items/:itemId')
    expect(lastSpan!.updateName).toHaveBeenCalledWith('GET /api/items/:itemId')
  })

  test('does NOT use generic catch-all routes ("/api/*", "/*", "*")', async () => {
    for (const generic of ['/api/*', '/*', '*']) {
      lastSpan = null
      const ctx = makeCtx({ path: '/api/x', routePath: generic })
      await tracingMiddleware(ctx, async () => {})
      expect(lastSpan!.updateName).not.toHaveBeenCalled()
    }
  })

  test('does not update name when routePath is missing', async () => {
    const ctx = makeCtx({ path: '/api/x' })
    await tracingMiddleware(ctx, async () => {})
    expect(lastSpan!.updateName).not.toHaveBeenCalled()
  })

  test('always ends the span (success, 4xx, 5xx, thrown)', async () => {
    const cases: Array<() => Promise<unknown>> = [
      async () => tracingMiddleware(makeCtx({ path: '/a', status: 200 }), async () => {}),
      async () => tracingMiddleware(makeCtx({ path: '/b', status: 404 }), async () => {}),
      async () => tracingMiddleware(makeCtx({ path: '/c', status: 500 }), async () => {}),
      async () => {
        try {
          await tracingMiddleware(makeCtx({ path: '/d' }), async () => {
            throw new Error('e')
          })
        } catch {}
      },
    ]
    for (const run of cases) {
      lastSpan = null
      await run()
      expect(lastSpan!.end).toHaveBeenCalledTimes(1)
    }
  })
})
