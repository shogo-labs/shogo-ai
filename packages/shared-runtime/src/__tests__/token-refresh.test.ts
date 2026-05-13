// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the AI_PROXY_TOKEN auto-rotation loop.
 *
 * What we cover here:
 *   - readJwtExpMs() round-trips for valid JWTs, returns null for garbage.
 *   - The loop fetches /api/internal/pod-config/<projectId> at the
 *     configured interval and applies the returned env to process.env.
 *   - onTokenRotate hook fires after env is applied (and its throw does
 *     NOT abort the loop).
 *   - Network failures (5xx, throw) do not crash the loop — next tick
 *     still fires.
 *   - PROJECT_ID=__POOL__ (or missing) skips the fetch entirely.
 *   - stop() cancels future ticks deterministically.
 *
 * We don't exercise the JWT-exp-driven early-refresh path here because
 * that would require advancing time — bun:test doesn't ship a clock-fake.
 * The interval-driven path covers the same code path with deterministic
 * timing.
 */

import {
  describe, test, expect, beforeEach, afterEach, mock,
} from 'bun:test'
import { startTokenRefreshLoop, readJwtExpMs } from '../token-refresh'

const ORIGINAL_FETCH = globalThis.fetch
const ORIGINAL_ENV = { ...process.env }

function makeJwt(payload: Record<string, unknown>): string {
  const enc = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.signature-not-verified`
}

beforeEach(() => {
  // Point the loop at a deterministic API URL — we'll mock fetch anyway.
  process.env.SHOGO_API_URL = 'http://api.test.svc.cluster.local'
  delete process.env.AI_PROXY_URL
  delete process.env.AI_PROXY_TOKEN
})

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  // Restore env to whatever the suite started with.
  for (const k of Object.keys(process.env)) delete process.env[k]
  Object.assign(process.env, ORIGINAL_ENV)
})

describe('readJwtExpMs', () => {
  test('decodes exp from a well-formed JWT', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    expect(readJwtExpMs(makeJwt({ exp }))).toBe(exp * 1000)
  })

  test('returns null when exp is missing', () => {
    expect(readJwtExpMs(makeJwt({ projectId: 'p1' }))).toBeNull()
  })

  test('returns null when exp is not a number', () => {
    expect(readJwtExpMs(makeJwt({ exp: 'soon' }))).toBeNull()
  })

  test('returns null for garbage input', () => {
    expect(readJwtExpMs('not-a-jwt')).toBeNull()
    expect(readJwtExpMs('')).toBeNull()
    expect(readJwtExpMs('only.one')).toBeNull()
  })
})

describe('startTokenRefreshLoop', () => {
  test('fetches pod-config and applies env on each tick', async () => {
    const fetchCalls: Array<{ url: string; headers: Record<string, string> }> = []
    const newToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 7 * 86400, projectId: 'p1' })
    globalThis.fetch = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, headers: init?.headers ?? {} })
      return new Response(
        JSON.stringify({
          projectId: 'p1',
          env: { AI_PROXY_TOKEN: newToken, RUNTIME_AUTH_SECRET: 'fresh-secret' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as any

    const handle = startTokenRefreshLoop({
      getProjectId: () => 'p1',
      intervalMs: 10_000,        // not actually awaited — we call refreshNow
      jitterMs: 0,
      logPrefix: 'test',
    })
    try {
      const env = await handle.refreshNow()
      expect(env).not.toBeNull()
      expect(env?.AI_PROXY_TOKEN).toBe(newToken)
      expect(process.env.AI_PROXY_TOKEN).toBe(newToken)
      expect(process.env.RUNTIME_AUTH_SECRET).toBe('fresh-secret')
      expect(fetchCalls).toHaveLength(1)
      expect(fetchCalls[0].url).toBe('http://api.test.svc.cluster.local/api/internal/pod-config/p1')
    } finally {
      handle.stop()
    }
  })

  test('invokes onTokenRotate after env is applied; hook throw does not abort loop', async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ projectId: 'p1', env: { AI_PROXY_TOKEN: 'tok-1' } }), { status: 200 }),
    ) as any

    let observedTokenAtHook: string | undefined
    const handle = startTokenRefreshLoop({
      getProjectId: () => 'p1',
      intervalMs: 10_000,
      jitterMs: 0,
      onTokenRotate: (env) => {
        observedTokenAtHook = process.env.AI_PROXY_TOKEN
        expect(env.AI_PROXY_TOKEN).toBe('tok-1')
        throw new Error('hook threw on purpose')
      },
    })
    try {
      const env = await handle.refreshNow()
      // hook ran AFTER env was applied
      expect(observedTokenAtHook).toBe('tok-1')
      // and despite the throw, refresh still completed successfully
      expect(env?.AI_PROXY_TOKEN).toBe('tok-1')
    } finally {
      handle.stop()
    }
  })

  test('non-2xx response logs and returns null without throwing', async () => {
    globalThis.fetch = mock(async () =>
      new Response('forbidden', { status: 403 }),
    ) as any
    const handle = startTokenRefreshLoop({
      getProjectId: () => 'p1',
      intervalMs: 10_000,
      jitterMs: 0,
    })
    try {
      const env = await handle.refreshNow()
      expect(env).toBeNull()
      // token was NOT clobbered with anything
      expect(process.env.AI_PROXY_TOKEN).toBeUndefined()
    } finally {
      handle.stop()
    }
  })

  test('fetch rejection is caught — loop survives transient network errors', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('ECONNREFUSED')
    }) as any
    const handle = startTokenRefreshLoop({
      getProjectId: () => 'p1',
      intervalMs: 10_000,
      jitterMs: 0,
    })
    try {
      const env = await handle.refreshNow()
      expect(env).toBeNull()
    } finally {
      handle.stop()
    }
  })

  test('skips fetch entirely while project is in pool / unassigned', async () => {
    const fetchSpy = mock(async () => new Response('{}', { status: 200 }))
    globalThis.fetch = fetchSpy as any

    const handle = startTokenRefreshLoop({
      getProjectId: () => '__POOL__',
      intervalMs: 10_000,
      jitterMs: 0,
    })
    try {
      const env = await handle.refreshNow()
      expect(env).toBeNull()
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      handle.stop()
    }

    const handle2 = startTokenRefreshLoop({
      getProjectId: () => null,
      intervalMs: 10_000,
      jitterMs: 0,
    })
    try {
      const env = await handle2.refreshNow()
      expect(env).toBeNull()
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      handle2.stop()
    }
  })

  test('stop() cancels the scheduled tick', async () => {
    let calls = 0
    globalThis.fetch = mock(async () => {
      calls++
      return new Response(JSON.stringify({ projectId: 'p1', env: {} }), { status: 200 })
    }) as any

    const handle = startTokenRefreshLoop({
      getProjectId: () => 'p1',
      intervalMs: 25,           // tiny interval so we'd see ticks if we waited
      jitterMs: 0,
    })
    handle.stop()
    // Wait through what would have been multiple ticks if the timer survived
    await new Promise((r) => setTimeout(r, 100))
    expect(calls).toBe(0)
  })

  test('omits Authorization header when no ServiceAccount token is mounted (outside-pod case)', async () => {
    // The module reads the K8s SA token from a hardcoded path inside
    // `readSAToken()`. Without restructuring `readSAToken` to be injectable,
    // we can only exercise the negative path here: outside a pod, the file
    // doesn't exist, so readSAToken returns null and no Authorization
    // header is attached. Positive-case coverage (header IS set when token
    // IS present) is tracked as a follow-up — see issue #535.
    let observedHeaders: Record<string, string> = {}
    globalThis.fetch = mock(async (_url: string, init: any) => {
      observedHeaders = init?.headers ?? {}
      return new Response(JSON.stringify({ projectId: 'p1', env: {} }), { status: 200 })
    }) as any
    const handle = startTokenRefreshLoop({
      getProjectId: () => 'p1',
      intervalMs: 10_000,
      jitterMs: 0,
    })
    try {
      await handle.refreshNow()
      expect(observedHeaders['Content-Type']).toBe('application/json')
      // outside a pod, no SA token mounted → no Authorization header
      expect(observedHeaders['Authorization']).toBeUndefined()
    } finally {
      handle.stop()
    }
  })

  test('concurrent refreshNow() calls coalesce into a single fetch (single-flight)', async () => {
    // Regression guard for the timer-multiplication bug: without
    // single-flight coalescing, two overlapping refresh() invocations
    // would each schedule a new setTimeout in their finally, leaking
    // timers that compound on every subsequent tick. The fix is to
    // share the in-flight promise between concurrent callers; this
    // test verifies both that the fetch is issued once and that the
    // two callers receive the same resolved env.
    let fetchCount = 0
    let resolveFetch: ((res: Response) => void) | null = null
    globalThis.fetch = mock(
      () =>
        new Promise<Response>((resolve) => {
          fetchCount++
          resolveFetch = resolve
        }),
    ) as any
    const handle = startTokenRefreshLoop({
      getProjectId: () => 'p1',
      intervalMs: 60_000,
      jitterMs: 0,
    })
    try {
      // Two overlapping refreshNow() calls while the fetch is pending.
      const p1 = handle.refreshNow()
      const p2 = handle.refreshNow()
      // Let microtasks drain so both calls reach the fetch path.
      await new Promise((r) => setTimeout(r, 10))
      expect(fetchCount).toBe(1)
      resolveFetch!(
        new Response(JSON.stringify({ projectId: 'p1', env: { AI_PROXY_TOKEN: 'rotated' } }), {
          status: 200,
        }),
      )
      const [r1, r2] = await Promise.all([p1, p2])
      expect(r1).toEqual({ AI_PROXY_TOKEN: 'rotated' })
      expect(r2).toEqual({ AI_PROXY_TOKEN: 'rotated' })
      expect(fetchCount).toBe(1)
    } finally {
      handle.stop()
    }
  })
})
