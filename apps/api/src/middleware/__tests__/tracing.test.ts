// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

interface SpanLog {
  name: string
  attributes: Record<string, any>
  status: { code: any; message?: string } | null
  exceptions: any[]
  ended: boolean
  renamedTo: string | null
}

const spans: SpanLog[] = []

class FakeSpan {
  log: SpanLog
  constructor(name: string, opts: any) {
    this.log = {
      name,
      attributes: { ...(opts?.attributes ?? {}) },
      status: null,
      exceptions: [],
      ended: false,
      renamedTo: null,
    }
    spans.push(this.log)
  }
  setAttribute(k: string, v: any) {
    this.log.attributes[k] = v
  }
  setStatus(s: any) {
    this.log.status = s
  }
  recordException(err: any) {
    this.log.exceptions.push(err)
  }
  updateName(name: string) {
    this.log.renamedTo = name
  }
  end() {
    this.log.ended = true
  }
}

const FakeSpanKind = { SERVER: 'SERVER' }
const FakeSpanStatusCode = { ERROR: 'ERROR', UNSET: 'UNSET' }

mock.module('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => ({
      startActiveSpan: async (name: string, opts: any, cb: (s: FakeSpan) => Promise<void>) => {
        const span = new FakeSpan(name, opts)
        return cb(span)
      },
    }),
  },
  SpanKind: FakeSpanKind,
  SpanStatusCode: FakeSpanStatusCode,
  context: {},
}))

const { tracingMiddleware } = await import('../tracing')

function makeContext(opts: {
  path: string
  method?: string
  url?: string
  userAgent?: string
  routePath?: string
  resStatus?: number
}) {
  const c: any = {
    req: {
      path: opts.path,
      method: opts.method ?? 'GET',
      url: opts.url ?? `http://x${opts.path}`,
      routePath: opts.routePath,
      header: (h: string) => (h.toLowerCase() === 'user-agent' ? opts.userAgent ?? '' : undefined),
    },
    res: { status: opts.resStatus ?? 200 },
  }
  return c
}

beforeEach(() => {
  spans.length = 0
})

afterEach(() => {
  // nothing
})

describe('tracingMiddleware — ignored paths', () => {
  it('skips span creation for /api/health', async () => {
    const c = makeContext({ path: '/api/health' })
    let nextCalled = false
    await tracingMiddleware(c as any, async () => {
      nextCalled = true
    })
    expect(nextCalled).toBe(true)
    expect(spans).toHaveLength(0)
  })

  it('skips span creation for /healthz', async () => {
    const c = makeContext({ path: '/healthz' })
    await tracingMiddleware(c as any, async () => {})
    expect(spans).toHaveLength(0)
  })

  it('skips span creation for /ready', async () => {
    const c = makeContext({ path: '/ready' })
    await tracingMiddleware(c as any, async () => {})
    expect(spans).toHaveLength(0)
  })
})

describe('tracingMiddleware — span lifecycle', () => {
  it('creates a span with method + normalized path as name', async () => {
    const c = makeContext({ path: '/api/widgets', method: 'POST' })
    await tracingMiddleware(c as any, async () => {})
    expect(spans).toHaveLength(1)
    expect(spans[0].name).toBe('POST /api/widgets')
    expect(spans[0].ended).toBe(true)
  })

  it('attaches http.method, http.target, http.url, http.route, http.user_agent', async () => {
    const c = makeContext({
      path: '/api/widgets',
      method: 'GET',
      url: 'http://api/widgets?x=1',
      userAgent: 'Mozilla/5.0',
    })
    await tracingMiddleware(c as any, async () => {})
    const a = spans[0].attributes
    expect(a['http.method']).toBe('GET')
    expect(a['http.target']).toBe('/api/widgets')
    expect(a['http.url']).toBe('http://api/widgets?x=1')
    expect(a['http.route']).toBe('/api/widgets')
    expect(a['http.user_agent']).toBe('Mozilla/5.0')
  })

  it('falls back to empty string when user-agent header is absent', async () => {
    const c = makeContext({ path: '/api/widgets' })
    await tracingMiddleware(c as any, async () => {})
    expect(spans[0].attributes['http.user_agent']).toBe('')
  })

  it('records http.status_code after next()', async () => {
    const c = makeContext({ path: '/api/widgets', resStatus: 204 })
    await tracingMiddleware(c as any, async () => {})
    expect(spans[0].attributes['http.status_code']).toBe(204)
  })
})

describe('tracingMiddleware — path normalization', () => {
  it('replaces UUIDs with :id (case-insensitive)', async () => {
    const c = makeContext({ path: '/api/users/550E8400-E29B-41D4-A716-446655440000/posts' })
    await tracingMiddleware(c as any, async () => {})
    expect(spans[0].name).toBe('GET /api/users/:id/posts')
  })

  it('replaces lowercase UUIDs with :id', async () => {
    const c = makeContext({ path: '/api/users/550e8400-e29b-41d4-a716-446655440000' })
    await tracingMiddleware(c as any, async () => {})
    expect(spans[0].name).toBe('GET /api/users/:id')
  })

  it('replaces cuid-style segments (20-30 lowercase alphanumeric) with :id', async () => {
    const c = makeContext({ path: '/api/projects/clxk1z9q70000jx08abc123de' })
    await tracingMiddleware(c as any, async () => {})
    expect(spans[0].name).toBe('GET /api/projects/:id')
  })

  it('replaces cuid segments mid-path too', async () => {
    const c = makeContext({ path: '/api/projects/clxk1z9q70000jx08abc123de/files' })
    await tracingMiddleware(c as any, async () => {})
    expect(spans[0].name).toBe('GET /api/projects/:id/files')
  })

  it('leaves short ids (< 20 chars) untouched', async () => {
    const c = makeContext({ path: '/api/x/abc123' })
    await tracingMiddleware(c as any, async () => {})
    expect(spans[0].name).toBe('GET /api/x/abc123')
  })
})

describe('tracingMiddleware — status code branches', () => {
  it('sets ERROR status for 5xx', async () => {
    const c = makeContext({ path: '/api/x', resStatus: 503 })
    await tracingMiddleware(c as any, async () => {})
    expect(spans[0].status?.code).toBe(FakeSpanStatusCode.ERROR)
    expect(spans[0].status?.message).toBe('HTTP 503')
  })

  it('sets UNSET status and http.error_type for 4xx', async () => {
    const c = makeContext({ path: '/api/x', resStatus: 404 })
    await tracingMiddleware(c as any, async () => {})
    expect(spans[0].status?.code).toBe(FakeSpanStatusCode.UNSET)
    expect(spans[0].attributes['http.error_type']).toBe('404')
  })

  it('leaves status untouched for 2xx', async () => {
    const c = makeContext({ path: '/api/x', resStatus: 200 })
    await tracingMiddleware(c as any, async () => {})
    expect(spans[0].status).toBeNull()
    expect(spans[0].attributes['http.error_type']).toBeUndefined()
  })

  it('leaves status untouched for 3xx', async () => {
    const c = makeContext({ path: '/api/x', resStatus: 301 })
    await tracingMiddleware(c as any, async () => {})
    expect(spans[0].status).toBeNull()
  })
})

describe('tracingMiddleware — error path', () => {
  it('records exception, sets ERROR status, and rethrows', async () => {
    const c = makeContext({ path: '/api/x' })
    const boom = new Error('boom')
    await expect(
      tracingMiddleware(c as any, async () => {
        throw boom
      }),
    ).rejects.toBe(boom)
    expect(spans).toHaveLength(1)
    expect(spans[0].status?.code).toBe(FakeSpanStatusCode.ERROR)
    expect(spans[0].status?.message).toBe('boom')
    expect(spans[0].exceptions).toContain(boom)
    expect(spans[0].ended).toBe(true)
  })
})

describe('tracingMiddleware — routePath enrichment', () => {
  it('renames span and overrides http.route when Hono routePath is concrete', async () => {
    const c = makeContext({
      path: '/api/users/550e8400-e29b-41d4-a716-446655440000',
      routePath: '/api/users/:userId',
    })
    await tracingMiddleware(c as any, async () => {})
    expect(spans[0].attributes['http.route']).toBe('/api/users/:userId')
    expect(spans[0].renamedTo).toBe('GET /api/users/:userId')
  })

  it('does NOT rename when routePath is /api/*', async () => {
    const c = makeContext({ path: '/api/x', routePath: '/api/*' })
    await tracingMiddleware(c as any, async () => {})
    expect(spans[0].renamedTo).toBeNull()
    expect(spans[0].attributes['http.route']).toBe('/api/x')
  })

  it('does NOT rename when routePath is /*', async () => {
    const c = makeContext({ path: '/api/x', routePath: '/*' })
    await tracingMiddleware(c as any, async () => {})
    expect(spans[0].renamedTo).toBeNull()
  })

  it('does NOT rename when routePath is *', async () => {
    const c = makeContext({ path: '/api/x', routePath: '*' })
    await tracingMiddleware(c as any, async () => {})
    expect(spans[0].renamedTo).toBeNull()
  })

  it('does NOT rename when routePath is undefined', async () => {
    const c = makeContext({ path: '/api/x' })
    await tracingMiddleware(c as any, async () => {})
    expect(spans[0].renamedTo).toBeNull()
  })

  it('still enriches routePath even on error path', async () => {
    const c = makeContext({ path: '/api/x', routePath: '/api/widgets/:id' })
    await expect(
      tracingMiddleware(c as any, async () => {
        throw new Error('x')
      }),
    ).rejects.toThrow()
    expect(spans[0].attributes['http.route']).toBe('/api/widgets/:id')
    expect(spans[0].renamedTo).toBe('GET /api/widgets/:id')
    expect(spans[0].ended).toBe(true)
  })
})
