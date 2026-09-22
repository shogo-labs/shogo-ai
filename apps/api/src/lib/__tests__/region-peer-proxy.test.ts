// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the cross-region proxy's connect-timeout + retry behavior
 * (docs/prod-e2e-findings-2026-08.md §A3): a hung/dead peer connection must
 * fail fast and, for safe (bodyless) methods, retry once on a fresh
 * connection — instead of riding the fetch out with no bound at all.
 *
 *   bun test apps/api/src/lib/__tests__/region-peer-proxy.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'

// Keep the connect-timeout tiny so tests that exercise it stay fast. Must be
// set before the module under test is imported (it reads the env var once,
// at module load, into a top-level const).
process.env.REGION_PROXY_CONNECT_TIMEOUT_MS = '50'

const PEERS: Record<string, { id: string; label: string; url: string }> = {
  'eu-frankfurt-1': { id: 'eu-frankfurt-1', label: 'EU', url: 'https://79.76.126.115' },
}

mock.module('../region', () => ({
  getPeer: (id: string) => PEERS[id],
  HOST_HEADER_FOR_PEERS: 'studio.shogo.ai',
}))

const { proxyToPeer } = await import('../region-peer-proxy')

function makeCtx(opts: { method?: string; path?: string; body?: string }) {
  const url = `https://studio.shogo.ai${opts.path ?? '/api/admin/warm-pool'}`
  const raw = new Request(url, {
    method: opts.method ?? 'GET',
    headers: { cookie: 'session=abc', 'content-type': 'application/json' },
    ...(opts.body ? { body: opts.body } : {}),
  })
  return {
    req: {
      url,
      method: opts.method ?? 'GET',
      raw,
    },
    json: (body: unknown, status?: number) => ({ __json: body, status: status ?? 200 }),
  } as any
}

/** A fetch stub that respects `init.signal` like a real connection would: if
 * aborted before `delayMs` elapses, it rejects the way `AbortSignal.timeout`
 * firing would; otherwise it resolves with `response()`. */
function abortAwareFetch(delayMs: number, response: () => Response) {
  const calls: Array<{ url: string; init: any }> = []
  const fn = (url: string, init: any) => {
    calls.push({ url, init })
    return new Promise<Response>((resolve, reject) => {
      const t = setTimeout(() => resolve(response()), delayMs)
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(t)
        reject(init.signal.reason ?? new DOMException('aborted', 'AbortError'))
      })
    })
  }
  return { fn, calls }
}

let originalFetch: typeof fetch

beforeEach(() => {
  originalFetch = global.fetch
})

afterEach(() => {
  global.fetch = originalFetch
})

describe('proxyToPeer', () => {
  test('returns 502 immediately for an unknown region (no peer configured)', async () => {
    const c = makeCtx({})
    const res: any = await proxyToPeer(c, 'ap-mumbai-1')
    expect(res.status).toBe(502)
    expect(res.__json.error).toContain('No peer configured')
  })

  test('forwards a healthy GET straight through with response headers preserved', async () => {
    const { fn, calls } = abortAwareFetch(5, () => new Response('ok', { status: 200, headers: { 'x-custom': 'yes' } }))
    global.fetch = fn as any

    const c = makeCtx({ path: '/api/admin/warm-pool' })
    const res: Response = await proxyToPeer(c, 'eu-frankfurt-1')

    expect(res.status).toBe(200)
    expect(res.headers.get('x-custom')).toBe('yes')
    expect(await res.text()).toBe('ok')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://79.76.126.115/api/admin/warm-pool')
    // Host/Origin are spoofed to the shared public hostname for every hop.
    expect(calls[0].init.headers.get('Host')).toBe('studio.shogo.ai')
    expect(calls[0].init.headers.get('x-shogo-home-region-proxy')).toBe('1')
  })

  test('a GET that hangs past the connect-timeout is retried once and succeeds', async () => {
    let n = 0
    const fn = (url: string, init: any) => {
      n++
      const attempt = n
      return new Promise<Response>((resolve, reject) => {
        if (attempt === 1) {
          // Never resolves on its own — only the connect-timeout's abort
          // settles this promise, exactly like a dead/blackholed connection.
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal.reason ?? new DOMException('aborted', 'AbortError')),
          )
        } else {
          resolve(new Response('ok-on-retry', { status: 200 }))
        }
      })
    }
    global.fetch = fn as any

    const c = makeCtx({ path: '/api/admin/warm-pool' })
    const res: Response = await proxyToPeer(c, 'eu-frankfurt-1')

    expect(n).toBe(2) // one hung attempt + one retry
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok-on-retry')
  })

  test('a GET that hangs on both the original attempt and the retry fails fast with 502 (not a 125s hang)', async () => {
    const fn = (_url: string, init: any) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal.reason ?? new DOMException('aborted', 'AbortError')),
        )
      })
    }
    global.fetch = fn as any

    const c = makeCtx({ path: '/api/admin/warm-pool' })
    const start = Date.now()
    const res: any = await proxyToPeer(c, 'eu-frankfurt-1')
    const elapsed = Date.now() - start

    expect(res.status).toBe(502)
    expect(res.__json.error).toContain('failed after retry')
    // Two connect-timeouts (50ms each) plus overhead — nowhere near the old
    // unbounded/~125s Cloudflare-edge-timeout failure mode.
    expect(elapsed).toBeLessThan(2000)
  })

  test('a POST (has a body) is NOT retried on connect-timeout — the body stream cannot be replayed', async () => {
    let n = 0
    const fn = (_url: string, init: any) => {
      n++
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal.reason ?? new DOMException('aborted', 'AbortError')),
        )
      })
    }
    global.fetch = fn as any

    const c = makeCtx({ method: 'POST', path: '/api/projects/p1/chat', body: '{"msg":"hi"}' })
    const res: any = await proxyToPeer(c, 'eu-frankfurt-1')

    expect(n).toBe(1) // no retry for a body-carrying request
    expect(res.status).toBe(502)
    expect(res.__json.error).not.toContain('after retry')
  })

  test('a non-2xx response from the peer is returned as-is (not treated as a transport failure / no retry)', async () => {
    let n = 0
    const fn = () => {
      n++
      return Promise.resolve(new Response('nope', { status: 401 }))
    }
    global.fetch = fn as any

    const c = makeCtx({ path: '/api/admin/warm-pool' })
    const res: Response = await proxyToPeer(c, 'eu-frankfurt-1')

    expect(n).toBe(1) // a real HTTP response is not retried, only transport failures are
    expect(res.status).toBe(401)
  })
})
