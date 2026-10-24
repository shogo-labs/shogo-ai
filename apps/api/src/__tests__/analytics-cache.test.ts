// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-140 acceptance 3/4 — one scan per request, not per open.
 *
 * The cache is what turns "every member who opens the tab" and "every param
 * change on screen" into a single scan. These are the properties that make that
 * safe: scope isolation (a member must never be handed an admin-wide result),
 * in-flight sharing, TTL, and eviction on a new usage event.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import {
  ANALYTICS_CACHE_BUCKET_MS,
  ANALYTICS_CACHE_DEFAULT_TTL_MS,
  analyticsCacheKey,
  clearAnalyticsCache,
  invalidateAnalyticsCache,
  withAnalyticsCache,
} from '../lib/analytics-cache'

const window = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-22T00:00:00Z') }

beforeEach(() => clearAnalyticsCache())

describe('withAnalyticsCache', () => {
  test('shares one run between concurrent callers for the same key', async () => {
    let runs = 0
    const run = () => withAnalyticsCache('k', 60_000, async () => {
      runs += 1
      await new Promise((r) => setTimeout(r, 5))
      return runs
    })
    const [a, b, c] = await Promise.all([run(), run(), run()])
    expect(runs).toBe(1)
    expect([a, b, c]).toEqual([1, 1, 1])
  })

  test('re-runs after the TTL', async () => {
    let runs = 0
    const run = () => withAnalyticsCache('k', 5, async () => { runs += 1 })
    await run()
    await run()
    expect(runs).toBe(1)
    await new Promise((r) => setTimeout(r, 15))
    await run()
    expect(runs).toBe(2)
  })

  test('does not cache a rejection', async () => {
    let runs = 0
    const failing = () => withAnalyticsCache('k', 60_000, async () => {
      runs += 1
      throw new Error('scan failed')
    })
    await expect(failing()).rejects.toThrow('scan failed')
    await expect(failing()).rejects.toThrow('scan failed')
    expect(runs).toBe(2)
  })

  test('a new usage event evicts the workspace and drops nobody else', async () => {
    let runs = 0
    const runFor = (workspaceId: string) => withAnalyticsCache(
      analyticsCacheKey({ workspaceId, ...window, shape: 'usage-groups' }),
      60_000,
      async () => { runs += 1 },
    )
    await runFor('ws-a')
    await runFor('ws-b')
    expect(runs).toBe(2)

    invalidateAnalyticsCache({ workspaceId: 'ws-a' })
    await runFor('ws-a')
    await runFor('ws-b')
    expect(runs).toBe(3)
  })
})

describe('analyticsCacheKey', () => {
  test('never collides between a member, an admin and another member', () => {
    const keys = new Set([
      analyticsCacheKey({ workspaceId: 'ws', ...window, shape: 'usage-groups' }),
      analyticsCacheKey({ workspaceId: 'ws', userId: 'alice', ...window, shape: 'usage-groups' }),
      analyticsCacheKey({ workspaceId: 'ws', userId: 'bob', ...window, shape: 'usage-groups' }),
    ])
    expect(keys.size).toBe(3)
  })

  test('separates workspaces, projects and shapes', () => {
    const keys = new Set([
      analyticsCacheKey({ workspaceId: 'ws', ...window, shape: 'usage-groups' }),
      analyticsCacheKey({ workspaceId: 'ws2', ...window, shape: 'usage-groups' }),
      analyticsCacheKey({ workspaceId: 'ws', projectId: 'p1', ...window, shape: 'usage-groups' }),
      analyticsCacheKey({ workspaceId: 'ws', ...window, shape: 'something-else' }),
    ])
    expect(keys.size).toBe(4)
  })

  test('a rolling window that moved by a second still hits the same key', () => {
    // "Last 30 days" is re-derived on every request; without bucketing the key
    // would differ by a few milliseconds and never hit.
    const a = analyticsCacheKey({ workspaceId: 'ws', ...window, shape: 'usage-groups' })
    const b = analyticsCacheKey({
      workspaceId: 'ws',
      from: new Date(window.from.getTime() + 1_000),
      to: new Date(window.to.getTime() + 1_000),
      shape: 'usage-groups',
    })
    expect(a).toBe(b)

    const later = analyticsCacheKey({
      workspaceId: 'ws',
      from: new Date(window.from.getTime() + ANALYTICS_CACHE_BUCKET_MS * 2),
      to: new Date(window.to.getTime() + ANALYTICS_CACHE_BUCKET_MS * 2),
      shape: 'usage-groups',
    })
    expect(later).not.toBe(a)
  })

  test('a key cannot change while an entry is still being served', () => {
    // QA round 1 (SHO-140): with a 30 s bucket under a 60 s TTL, an open 31 s
    // after the first computed a different key and scanned again, so half the
    // TTL was unreachable. The bucket has to cover the whole TTL.
    expect(ANALYTICS_CACHE_BUCKET_MS).toBeGreaterThanOrEqual(ANALYTICS_CACHE_DEFAULT_TTL_MS)
  })
})
