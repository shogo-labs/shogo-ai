// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

// Mock the dynamic-imported warm-pool controller BEFORE importing the module.
const evictProjectMock = mock(async (_id: string, _opts: any) => undefined)
mock.module('../lib/warm-pool-controller', () => ({
  getWarmPoolController: () => ({ evictProject: evictProjectMock }),
}))

const {
  evictIfPodMissingAuth,
  evictOnSingleMissingAuth,
  RUNTIME_AUTH_MISSING_SENTINEL,
} = await import('../lib/warm-pool-self-heal')

let errorSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  evictProjectMock.mockReset()
  evictProjectMock.mockImplementation(async () => undefined)
  errorSpy = spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  errorSpy.mockRestore()
})

describe('RUNTIME_AUTH_MISSING_SENTINEL', () => {
  test('is the exact public sentinel string the runtime emits', () => {
    expect(RUNTIME_AUTH_MISSING_SENTINEL).toBe('RUNTIME_AUTH_SECRET not configured')
  })

  test('changing this string is a breaking change (pin for regression catch)', () => {
    // If this assertion fails, every consumer that searches for the
    // sentinel (chat handler, voice, heartbeat) is suddenly broken.
    expect(typeof RUNTIME_AUTH_MISSING_SENTINEL).toBe('string')
    expect(RUNTIME_AUTH_MISSING_SENTINEL.length).toBeGreaterThan(0)
  })
})

describe('evictIfPodMissingAuth — status gate', () => {
  test('returns false (no eviction) when status is not 401', async () => {
    for (const status of [200, 204, 400, 403, 404, 500, 502, 503]) {
      evictProjectMock.mockClear()
      const result = await evictIfPodMissingAuth(
        'proj_x',
        status,
        'RUNTIME_AUTH_SECRET not configured',
        10
      )
      expect(result).toBe(false)
      expect(evictProjectMock).not.toHaveBeenCalled()
    }
  })

  test('returns false (no eviction) for 401 with a DIFFERENT body', async () => {
    const result = await evictIfPodMissingAuth(
      'proj_x',
      401,
      'Authentication failed',
      10
    )
    expect(result).toBe(false)
    expect(evictProjectMock).not.toHaveBeenCalled()
  })
})

describe('evictIfPodMissingAuth — sentinel matching', () => {
  test('matches a body that exactly equals the sentinel', async () => {
    const result = await evictIfPodMissingAuth(
      'proj_y',
      401,
      'RUNTIME_AUTH_SECRET not configured',
      1
    )
    expect(result).toBe(true)
    expect(evictProjectMock).toHaveBeenCalledTimes(1)
  })

  test('matches a body that CONTAINS the sentinel (e.g. JSON-wrapped)', async () => {
    const result = await evictIfPodMissingAuth(
      'proj_y',
      401,
      '{"error":"RUNTIME_AUTH_SECRET not configured","code":"auth"}',
      1
    )
    expect(result).toBe(true)
  })

  test('coerces non-string bodies via String()', async () => {
    // Some HTTP libs return objects/buffers; the helper must not crash.
    const result = await evictIfPodMissingAuth(
      'proj_y',
      401,
      { toString: () => 'RUNTIME_AUTH_SECRET not configured' },
      1
    )
    expect(result).toBe(true)
  })

  test('handles null/undefined bodies safely (returns false, no crash)', async () => {
    expect(await evictIfPodMissingAuth('p', 401, null, 1)).toBe(false)
    expect(await evictIfPodMissingAuth('p', 401, undefined, 1)).toBe(false)
    expect(evictProjectMock).not.toHaveBeenCalled()
  })

  test('is case-sensitive (matches the wire-format exactly)', async () => {
    expect(
      await evictIfPodMissingAuth('p', 401, 'runtime_auth_secret not configured', 1)
    ).toBe(false)
    expect(
      await evictIfPodMissingAuth('p', 401, 'RUNTIME_AUTH_SECRET NOT CONFIGURED', 1)
    ).toBe(false)
  })
})

describe('evictIfPodMissingAuth — attempt threshold', () => {
  test('returns false when attempts < threshold', async () => {
    for (let attempts = 1; attempts <= 7; attempts++) {
      evictProjectMock.mockClear()
      const result = await evictIfPodMissingAuth(
        'proj_chat',
        401,
        'RUNTIME_AUTH_SECRET not configured',
        attempts,
        8 // chat-handler threshold
      )
      expect(result).toBe(false)
      expect(evictProjectMock).not.toHaveBeenCalled()
    }
  })

  test('returns true when attempts === threshold', async () => {
    const result = await evictIfPodMissingAuth(
      'proj_chat',
      401,
      'RUNTIME_AUTH_SECRET not configured',
      8,
      8
    )
    expect(result).toBe(true)
    expect(evictProjectMock).toHaveBeenCalledTimes(1)
  })

  test('returns true when attempts > threshold', async () => {
    const result = await evictIfPodMissingAuth(
      'proj_chat',
      401,
      'RUNTIME_AUTH_SECRET not configured',
      15,
      8
    )
    expect(result).toBe(true)
  })

  test('defaults threshold to 1 when omitted (background-caller default)', async () => {
    const result = await evictIfPodMissingAuth(
      'proj_bg',
      401,
      'RUNTIME_AUTH_SECRET not configured',
      1
      // threshold omitted
    )
    expect(result).toBe(true)
    expect(evictProjectMock).toHaveBeenCalledTimes(1)
  })

  test('threshold of 0 still requires attempts >= 0 (any matching 401 evicts)', async () => {
    const result = await evictIfPodMissingAuth(
      'proj_bg',
      401,
      'RUNTIME_AUTH_SECRET not configured',
      0,
      0
    )
    expect(result).toBe(true)
  })
})

describe('evictIfPodMissingAuth — eviction call shape', () => {
  test('invokes evictProject with deleteService: true (service must be torn down too)', async () => {
    await evictIfPodMissingAuth(
      'proj_args',
      401,
      'RUNTIME_AUTH_SECRET not configured',
      1
    )
    expect(evictProjectMock).toHaveBeenCalledWith('proj_args', { deleteService: true })
  })

  test('logs the projectId, attempts, and threshold on eviction (operator debugging)', async () => {
    await evictIfPodMissingAuth(
      'proj_logging',
      401,
      'RUNTIME_AUTH_SECRET not configured',
      5,
      3
    )
    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join(' ')
    expect(logged).toContain('proj_logging')
    expect(logged).toContain('5')
    expect(logged).toContain('threshold=3')
    expect(logged).toContain('[WarmPoolSelfHeal]')
  })
})

describe('evictIfPodMissingAuth — eviction failure handling', () => {
  test('still returns true when evictProject throws (avoid infinite retry on a perma-broken pod)', async () => {
    evictProjectMock.mockImplementation(async () => {
      throw new Error('warm pool controller down')
    })
    const result = await evictIfPodMissingAuth(
      'proj_fail',
      401,
      'RUNTIME_AUTH_SECRET not configured',
      1
    )
    expect(result).toBe(true)
  })

  test('logs the eviction failure message', async () => {
    evictProjectMock.mockImplementation(async () => {
      throw new Error('k8s api timeout')
    })
    await evictIfPodMissingAuth(
      'proj_fail',
      401,
      'RUNTIME_AUTH_SECRET not configured',
      1
    )
    // Two log lines: one announcing the eviction, one for the failure.
    expect(errorSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join(' ')
    expect(logged).toContain('k8s api timeout')
    expect(logged).toContain('proj_fail')
  })

  test('handles non-Error throws (string, undefined) without crashing', async () => {
    evictProjectMock.mockImplementation(async () => {
      throw 'string error' as unknown as Error
    })
    const result = await evictIfPodMissingAuth(
      'p',
      401,
      'RUNTIME_AUTH_SECRET not configured',
      1
    )
    expect(result).toBe(true)
  })
})

describe('evictOnSingleMissingAuth', () => {
  test('triggers eviction on a single 401 with sentinel (threshold=1 implicit)', async () => {
    const result = await evictOnSingleMissingAuth(
      'proj_single',
      401,
      'RUNTIME_AUTH_SECRET not configured'
    )
    expect(result).toBe(true)
    expect(evictProjectMock).toHaveBeenCalledWith('proj_single', { deleteService: true })
  })

  test('does not evict on a non-401', async () => {
    expect(
      await evictOnSingleMissingAuth('p', 200, 'RUNTIME_AUTH_SECRET not configured')
    ).toBe(false)
    expect(evictProjectMock).not.toHaveBeenCalled()
  })

  test('does not evict on a 401 without the sentinel', async () => {
    expect(await evictOnSingleMissingAuth('p', 401, 'something else')).toBe(false)
    expect(evictProjectMock).not.toHaveBeenCalled()
  })

  test('returns a Promise (async API contract)', () => {
    const ret = evictOnSingleMissingAuth('p', 200, 'x')
    expect(ret).toBeInstanceOf(Promise)
    return ret
  })
})
