// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the cloud `WorkspaceKeepWarm` controller — the MRU + top-N keep-
 * warm sweep that mirrors the host's "keep the last 3 previews warm" by
 * pinging the most-recently-opened workspace runtimes' /health endpoints
 * (refreshing Knative scale-to-zero retention). Pins MRU ordering, the top-N
 * selection, and that only the top-N are pinged.
 *
 * Run: bun test apps/api/src/lib/__tests__/workspace-keep-warm.test.ts
 */

import { describe, expect, it } from 'bun:test'
import { WorkspaceKeepWarm } from '../workspace-keep-warm'

function fixedClock() {
  let t = 1_000
  return () => (t += 1000)
}

describe('WorkspaceKeepWarm', () => {
  it('recordOpened moves a key to the front and dedupes', () => {
    const kw = new WorkspaceKeepWarm({ max: 3, now: fixedClock(), fetchFn: async () => ({ ok: true, status: 200 }) })
    kw.recordOpened('a', 'http://a')
    kw.recordOpened('b', 'http://b')
    kw.recordOpened('a', 'http://a2') // re-open → moves to front, updates url
    const keys = kw.topN().map((e) => e.key)
    expect(keys).toEqual(['a', 'b'])
    expect(kw.topN()[0].url).toBe('http://a2')
  })

  it('topN returns at most `max` most-recent entries', () => {
    const kw = new WorkspaceKeepWarm({ max: 3, now: fixedClock(), fetchFn: async () => ({ ok: true, status: 200 }) })
    for (const k of ['a', 'b', 'c', 'd']) kw.recordOpened(k, `http://${k}`)
    // d most-recent … a oldest. Top-3 = d, c, b.
    expect(kw.topN().map((e) => e.key)).toEqual(['d', 'c', 'b'])
  })

  it('pingTopN pings only the top-N /health endpoints', async () => {
    const pinged: string[] = []
    const kw = new WorkspaceKeepWarm({
      max: 3,
      now: fixedClock(),
      fetchFn: async (url) => {
        pinged.push(url)
        return { ok: true, status: 200 }
      },
    })
    for (const k of ['a', 'b', 'c', 'd']) kw.recordOpened(k, `http://${k}`)

    const res = await kw.pingTopN()

    expect(pinged.sort()).toEqual(['http://b/health', 'http://c/health', 'http://d/health'])
    expect(res.pinged.sort()).toEqual(['b', 'c', 'd'])
    // 'a' (oldest, beyond cap) is NOT pinged → scales to zero.
    expect(pinged).not.toContain('http://a/health')
  })

  it('pingTopN records failures without throwing', async () => {
    const kw = new WorkspaceKeepWarm({
      max: 3,
      now: fixedClock(),
      log: () => {},
      fetchFn: async (url) => {
        if (url.includes('//b')) throw new Error('cold-start timeout')
        if (url.includes('//c')) return { ok: false, status: 503 }
        return { ok: true, status: 200 }
      },
    })
    for (const k of ['a', 'b', 'c']) kw.recordOpened(k, `http://${k}`)

    const res = await kw.pingTopN()
    expect(res.pinged).toEqual(['a'])
    expect(res.failed.sort()).toEqual(['b', 'c'])
  })

  it('recordOpened ignores empty key/url', () => {
    const kw = new WorkspaceKeepWarm({ max: 3 })
    kw.recordOpened('', 'http://x')
    kw.recordOpened('x', '')
    expect(kw.topN()).toEqual([])
  })
})

/**
 * SHO-606: the cloud keep-warm controller used to parse
 * `WORKSPACE_PREVIEW_MAX || '3'` itself, so a desktop whose cap moved with the
 * host tier could keep a different number warm than the manager kept alive.
 * Both read `resolveWorkspacePreviewMax()` now.
 */
describe('WorkspaceKeepWarm — default cap is the shared warm-preview cap', () => {
  function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
    const prev = new Map<string, string | undefined>()
    for (const key of Object.keys(vars)) prev.set(key, process.env[key])
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    try {
      return fn()
    } finally {
      for (const [key, value] of prev) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }

  function keepOf(kw: WorkspaceKeepWarm): number {
    for (const k of ['a', 'b', 'c', 'd', 'e']) kw.recordOpened(k, `http://${k}`)
    return kw.topN().length
  }

  it('keeps the top 4 when WORKSPACE_PREVIEW_MAX=4', () => {
    const kept = withEnv(
      { WORKSPACE_PREVIEW_MAX: '4', SHOGO_HOST_TIER: undefined },
      () => keepOf(new WorkspaceKeepWarm({ now: fixedClock() })),
    )
    expect(kept).toBe(4)
  })

  it('keeps 3 with no env and no host tier (cloud, metal, docker)', () => {
    const kept = withEnv(
      { WORKSPACE_PREVIEW_MAX: undefined, SHOGO_HOST_TIER: undefined },
      () => keepOf(new WorkspaceKeepWarm({ now: fixedClock() })),
    )
    expect(kept).toBe(3)
  })

  it('follows the host tier when one is set', () => {
    const kept = withEnv(
      { WORKSPACE_PREVIEW_MAX: undefined, SHOGO_HOST_TIER: 'high' },
      () => keepOf(new WorkspaceKeepWarm({ now: fixedClock() })),
    )
    expect(kept).toBe(5) // only five entries were recorded, so all five are kept
  })

  it('an explicit `max` still wins', () => {
    const kept = withEnv(
      { WORKSPACE_PREVIEW_MAX: '4' },
      () => keepOf(new WorkspaceKeepWarm({ max: 2, now: fixedClock() })),
    )
    expect(kept).toBe(2)
  })
})
