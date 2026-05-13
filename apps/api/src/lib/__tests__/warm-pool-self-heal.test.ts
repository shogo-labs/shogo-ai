// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `evictIfPodMissingAuth` / `evictOnSingleMissingAuth`.
 *
 * These cover the central detection rules so every callsite (project-chat,
 * heartbeat-scheduler, voice-context, …) inherits the same behaviour:
 *
 *   - Only HTTP 401 with the `RUNTIME_AUTH_SECRET not configured` sentinel
 *     in the body triggers eviction. Any other status / body is a no-op.
 *   - The `attempts < threshold` branch returns false without touching the
 *     warm-pool controller — so chat's threshold=8 and heartbeat's
 *     threshold=1 are both satisfied by the same helper.
 *   - When eviction is triggered, `WarmPoolController.evictProject` is
 *     called with `{ deleteService: true }` (full teardown so the next
 *     request claims a fresh ksvc).
 *   - An eviction failure does NOT propagate — the helper still returns
 *     true so callers stop retrying a permanently-broken pod.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'

const evictProject = mock((_projectId: string, _opts?: any) => Promise.resolve({ evicted: true }))

mock.module('../warm-pool-controller', () => ({
  getWarmPoolController: () => ({ evictProject }),
}))

describe('evictIfPodMissingAuth', () => {
  beforeEach(() => {
    evictProject.mockClear()
  })

  afterEach(() => {
    evictProject.mockClear()
  })

  test('evicts on 401 with the sentinel after the threshold is reached', async () => {
    const { evictIfPodMissingAuth } = await import('../warm-pool-self-heal')

    const result = await evictIfPodMissingAuth(
      'project-1',
      401,
      'something something RUNTIME_AUTH_SECRET not configured trailing',
      8,
      8,
    )

    expect(result).toBe(true)
    expect(evictProject).toHaveBeenCalledTimes(1)
    expect(evictProject).toHaveBeenCalledWith('project-1', { deleteService: true })
  })

  test('does NOT evict before threshold (chat-handler 8-attempts grace)', async () => {
    const { evictIfPodMissingAuth } = await import('../warm-pool-self-heal')

    for (let i = 1; i < 8; i++) {
      const result = await evictIfPodMissingAuth(
        'project-2',
        401,
        'RUNTIME_AUTH_SECRET not configured',
        i,
        8,
      )
      expect(result).toBe(false)
    }
    expect(evictProject).not.toHaveBeenCalled()
  })

  test('does NOT evict on 401 without the sentinel', async () => {
    const { evictIfPodMissingAuth } = await import('../warm-pool-self-heal')

    const result = await evictIfPodMissingAuth(
      'project-3',
      401,
      'Unauthorized',
      99,
      1,
    )
    expect(result).toBe(false)
    expect(evictProject).not.toHaveBeenCalled()
  })

  test('does NOT evict on non-401 status codes', async () => {
    const { evictIfPodMissingAuth } = await import('../warm-pool-self-heal')

    for (const status of [200, 400, 403, 404, 500, 502]) {
      const result = await evictIfPodMissingAuth(
        'project-4',
        status,
        'RUNTIME_AUTH_SECRET not configured',
        99,
        1,
      )
      expect(result).toBe(false)
    }
    expect(evictProject).not.toHaveBeenCalled()
  })

  test('coerces non-string bodies before scanning for the sentinel', async () => {
    const { evictIfPodMissingAuth } = await import('../warm-pool-self-heal')

    const result = await evictIfPodMissingAuth(
      'project-5',
      401,
      { error: 'Unauthorized — RUNTIME_AUTH_SECRET not configured' } as any,
      1,
      1,
    )
    // Non-string bodies are stringified via String(), which yields
    // [object Object] — the sentinel will not match. Verify we DON'T
    // false-positive on objects.
    expect(result).toBe(false)
    expect(evictProject).not.toHaveBeenCalled()
  })

  test('returns true even if eviction itself throws', async () => {
    evictProject.mockImplementationOnce(() => Promise.reject(new Error('k8s api unavailable')))

    const { evictIfPodMissingAuth } = await import('../warm-pool-self-heal')

    const result = await evictIfPodMissingAuth(
      'project-6',
      401,
      'RUNTIME_AUTH_SECRET not configured',
      1,
      1,
    )

    expect(result).toBe(true)
    expect(evictProject).toHaveBeenCalledTimes(1)
  })

  test('evictOnSingleMissingAuth uses threshold=1', async () => {
    const { evictOnSingleMissingAuth } = await import('../warm-pool-self-heal')

    const result = await evictOnSingleMissingAuth(
      'project-7',
      401,
      'something RUNTIME_AUTH_SECRET not configured',
    )

    expect(result).toBe(true)
    expect(evictProject).toHaveBeenCalledTimes(1)
    expect(evictProject).toHaveBeenCalledWith('project-7', { deleteService: true })
  })
})
