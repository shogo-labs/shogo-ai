// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * GET /ai/upstream-health
 *
 * The connectivity probe the agent loop's park tier polls when its fast
 * inference-retry budget is exhausted on a still-retryable failure (see
 * `packages/agent/src/connectivity.ts`). Covers:
 *   - reachability semantics (any HTTP response, even an error status,
 *     counts as reachable; only a network-level failure is `false`)
 *   - target resolution (direct / cloud / local-llm) from env
 *   - the short-lived cache that keeps a parked loop's repeated polling
 *     from hammering the real upstream
 *
 * Run: bun test apps/api/src/routes/__tests__/ai-upstream-health.test.ts
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { aiProxyRoutes } from '../ai-proxy'

const ENV_KEYS = ['AI_MODE', 'LOCAL_LLM_BASE_URL', 'SHOGO_LOCAL_MODE', 'SHOGO_API_KEY'] as const
let savedEnv: Record<string, string | undefined> = {}
let savedFetch: typeof fetch

beforeEach(() => {
  savedEnv = {}
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  savedFetch = globalThis.fetch
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  globalThis.fetch = savedFetch
})

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const fn = mock(impl) as unknown as typeof fetch
  globalThis.fetch = fn
  return fn
}

describe('GET /ai/upstream-health', () => {
  test('reachable: true when the probe gets any HTTP response, including an error status', async () => {
    mockFetch(async () => new Response('service unavailable', { status: 503 }))
    const router = aiProxyRoutes()

    const res = await router.request('/ai/upstream-health')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.reachable).toBe(true)
    expect(body.target).toBe('direct')
    expect(body.cached).toBe(false)
  })

  test('reachable: false when the probe fetch itself fails (no network path)', async () => {
    mockFetch(async () => { throw new TypeError('fetch failed') })
    const router = aiProxyRoutes()

    const res = await router.request('/ai/upstream-health')
    const body = await res.json()
    expect(body.reachable).toBe(false)
    expect(body.target).toBe('direct')
  })

  test('resolves target: local-llm when AI_MODE=local-llm and LOCAL_LLM_BASE_URL is set', async () => {
    process.env.AI_MODE = 'local-llm'
    process.env.LOCAL_LLM_BASE_URL = 'http://localhost:11434/'
    let probedUrl: string | undefined
    mockFetch(async (url: string) => {
      probedUrl = url
      return new Response('ok')
    })
    const router = aiProxyRoutes()

    const res = await router.request('/ai/upstream-health')
    const body = await res.json()
    expect(body.target).toBe('local-llm')
    // Trailing slash stripped before probing.
    expect(probedUrl).toBe('http://localhost:11434')
  })

  test('resolves target: cloud when Shogo Cloud forwarding is active', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    process.env.SHOGO_API_KEY = 'sk-test-key'
    mockFetch(async () => new Response('ok'))
    const router = aiProxyRoutes()

    const res = await router.request('/ai/upstream-health')
    const body = await res.json()
    expect(body.target).toBe('cloud')
  })

  test('resolves target: direct when neither local-llm nor cloud forwarding apply', async () => {
    mockFetch(async () => new Response('ok'))
    const router = aiProxyRoutes()

    const res = await router.request('/ai/upstream-health')
    const body = await res.json()
    expect(body.target).toBe('direct')
  })

  test('caches the result for repeated polls within the cache window', async () => {
    const fetchFn = mockFetch(async () => new Response('ok'))
    const router = aiProxyRoutes()

    const first = await (await router.request('/ai/upstream-health')).json()
    const second = await (await router.request('/ai/upstream-health')).json()

    expect(first.cached).toBe(false)
    expect(second.cached).toBe(true)
    expect(second.reachable).toBe(first.reachable)
    // The whole point of the cache: a parked loop polling every few seconds
    // doesn't hammer the real upstream on every single tick.
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  test('cache is scoped per router instance (a fresh probe resets it)', async () => {
    const fetchFn = mockFetch(async () => new Response('ok'))
    await (await aiProxyRoutes().request('/ai/upstream-health')).json()
    await (await aiProxyRoutes().request('/ai/upstream-health')).json()
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
})
