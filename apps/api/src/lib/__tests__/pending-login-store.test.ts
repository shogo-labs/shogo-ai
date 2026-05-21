// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `pending-login-store.ts` — the Redis-backed store that
 * holds CLI / desktop device-code login state across the multi-replica
 * API tier.
 *
 * The regression these tests exist to prevent:
 *
 *   v1.7.x cloud sign-in fails immediately after the browser lands on
 *   the bridge page with `404 Unknown or expired state`, because
 *   `POST /api/cli/login/start` landed on api-pod-A (which stored the
 *   record in a per-process `Map`) and `GET /api/cli/login/state` then
 *   landed on api-pod-B (whose Map had no entry).
 *
 * The "cross-pod read" test below exercises exactly that scenario:
 * write through the store (pod A), wipe the in-memory Map (pod B has
 * a fresh process), then read through the store again — the record
 * must come back from Redis.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'

// ─── Fake shared-Redis client ────────────────────────────────────────────────
// Minimal ioredis surface — just the three commands the store uses.
// Backed by a Map so we can verify cross-pod visibility deterministically
// without a real Redis instance.

type FakeEntry = { value: string; expiresAtMs: number | null }
const redisKv = new Map<string, FakeEntry>()

const fakeRedis = {
  get: mock(async (key: string): Promise<string | null> => {
    const entry = redisKv.get(key)
    if (!entry) return null
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
      redisKv.delete(key)
      return null
    }
    return entry.value
  }),
  set: mock(async (key: string, value: string, _ex: 'EX', ttlSec: number): Promise<'OK'> => {
    redisKv.set(key, { value, expiresAtMs: Date.now() + ttlSec * 1000 })
    return 'OK'
  }),
  del: mock(async (key: string): Promise<number> => {
    const had = redisKv.delete(key)
    return had ? 1 : 0
  }),
}

// Default the mock to "Redis available" — individual tests can override
// via `sharedRedisImpl = null` to exercise the local-fallback path.
let sharedRedisImpl: typeof fakeRedis | null = fakeRedis

mock.module('../tunnel-redis', () => ({
  getSharedRedis: () => sharedRedisImpl,
}))

// Force cloud-mode BEFORE the store module imports. Captured into
// `isLocalMode` at module-evaluation time inside the store.
const prevLocalMode = process.env.SHOGO_LOCAL_MODE
process.env.SHOGO_LOCAL_MODE = ''

const {
  setPendingState,
  getPendingState,
  deletePendingState,
  purgeExpiredStates,
  _testing,
} = await import('../pending-login-store')

// ─── Test fixtures ────────────────────────────────────────────────────────────

function fixtureRecord(overrides: Partial<{
  status: 'pending' | 'approved' | 'denied' | 'expired'
  expiresAt: number
  mintedKey: string
}> = {}) {
  return {
    status: overrides.status ?? 'pending',
    deviceId: 'device-123',
    deviceName: 'Test Device',
    client: 'cli' as const,
    expiresAt: overrides.expiresAt ?? Date.now() + 5 * 60 * 1000,
    mintedKey: overrides.mintedKey,
  } as any
}

beforeEach(() => {
  redisKv.clear()
  _testing.pendingStates.clear()
  fakeRedis.get.mockClear()
  fakeRedis.set.mockClear()
  fakeRedis.del.mockClear()
  sharedRedisImpl = fakeRedis
})

// ─── Test cases ───────────────────────────────────────────────────────────────

describe('pending-login-store', () => {
  test('setPendingState writes to Redis with derived TTL when shared client is available', async () => {
    const record = fixtureRecord({ expiresAt: Date.now() + 5 * 60 * 1000 })
    await setPendingState('abc', record)

    expect(fakeRedis.set).toHaveBeenCalledTimes(1)
    const [key, value, ex, ttlSec] = fakeRedis.set.mock.calls[0]!
    expect(key).toBe('cli-login:state:abc')
    expect(JSON.parse(value as string)).toEqual(record)
    expect(ex).toBe('EX')
    // 5 minutes ± rounding (Math.ceil); allow a 2-second margin.
    expect(ttlSec).toBeGreaterThanOrEqual(299)
    expect(ttlSec).toBeLessThanOrEqual(301)
  })

  test('TTL is clamped to ≥1 second even for records that just expired', async () => {
    // Records past expiry shouldn't be written in production, but
    // defensive clamping protects against a clock skew between
    // route-handler `Date.now()` and the store's call site.
    const record = fixtureRecord({ expiresAt: Date.now() - 5_000 })
    await setPendingState('past', record)
    const ttlSec = fakeRedis.set.mock.calls[0]![3] as number
    expect(ttlSec).toBe(1)
  })

  test('cross-pod read: a record written from "pod A" is visible to "pod B"', async () => {
    // Pod A: the start handler writes the pending state.
    const record = fixtureRecord()
    await setPendingState('xpod-state', record)

    // Pod B simulation: its in-process fallback Map is empty (a fresh
    // sibling pod that never handled `/start` for this nonce). This is
    // the v1.7.x regression scenario — without Redis the record cannot
    // be found and the bridge page sees 404 "Unknown or expired state".
    _testing.pendingStates.clear()

    const fetched = await getPendingState('xpod-state')
    expect(fetched).toEqual(record)
    expect(fakeRedis.get).toHaveBeenCalledWith('cli-login:state:xpod-state')
  })

  test('cross-pod mutate: approve on pod A is visible to poll on pod B', async () => {
    // Pod A: start
    const original = fixtureRecord()
    await setPendingState('mutate', original)

    // Pod A: approve mutates the record and writes through.
    const approved = await getPendingState('mutate')
    expect(approved).toBeDefined()
    approved!.status = 'approved'
    approved!.mintedKey = 'shogo_sk_TESTKEY'
    await setPendingState('mutate', approved!)

    // Pod B: fresh process — local Map empty.
    _testing.pendingStates.clear()

    // Pod B: poll reads the approved record straight out of Redis.
    const fetched = await getPendingState('mutate')
    expect(fetched?.status).toBe('approved')
    expect(fetched?.mintedKey).toBe('shogo_sk_TESTKEY')
  })

  test('getPendingState returns undefined for unknown state', async () => {
    expect(await getPendingState('nope')).toBeUndefined()
  })

  test('deletePendingState clears both the Redis key and any local fallback entry', async () => {
    const record = fixtureRecord()
    await setPendingState('todel', record)
    // Belt-and-suspenders: also poke the local Map directly, since prod
    // can have entries left over from a transient Redis outage.
    _testing.pendingStates.set('todel', record)

    await deletePendingState('todel')

    expect(fakeRedis.del).toHaveBeenCalledWith('cli-login:state:todel')
    expect(_testing.pendingStates.has('todel')).toBe(false)
    expect(await getPendingState('todel')).toBeUndefined()
  })

  test('Redis GET throwing falls back to the local Map', async () => {
    // Seed only the local Map; Redis would normally not have it, but
    // simulate the case where a prior Redis outage caused a fallback
    // write to land only there.
    const record = fixtureRecord()
    _testing.pendingStates.set('fallback-get', record)

    fakeRedis.get.mockImplementationOnce(async () => { throw new Error('ECONNREFUSED') })

    const fetched = await getPendingState('fallback-get')
    expect(fetched).toEqual(record)
  })

  test('Redis SET throwing falls back to writing the local Map', async () => {
    const record = fixtureRecord()
    fakeRedis.set.mockImplementationOnce(async () => { throw new Error('ECONNREFUSED') })

    await setPendingState('fallback-set', record)

    // The fallback Map now has the record, so a subsequent get (which
    // also tries Redis first) returns it from the fallback path.
    fakeRedis.get.mockImplementationOnce(async () => { throw new Error('ECONNREFUSED') })
    const fetched = await getPendingState('fallback-set')
    expect(fetched).toEqual(record)
  })

  test('when shared Redis is unavailable, every op routes to the local Map', async () => {
    sharedRedisImpl = null
    const record = fixtureRecord()
    await setPendingState('nored', record)
    // Redis SET was NOT called — we never hit the shared client because
    // it was null up front.
    expect(fakeRedis.set).not.toHaveBeenCalled()
    expect(_testing.pendingStates.get('nored')).toEqual(record)

    const fetched = await getPendingState('nored')
    expect(fetched).toEqual(record)

    await deletePendingState('nored')
    expect(_testing.pendingStates.has('nored')).toBe(false)
  })

  test('purgeExpiredStates sweeps only past-due records in the local Map', () => {
    const now = Date.now()
    _testing.pendingStates.set('alive', fixtureRecord({ expiresAt: now + 60_000 }))
    _testing.pendingStates.set('dead-1', fixtureRecord({ expiresAt: now - 1 }))
    _testing.pendingStates.set('dead-2', fixtureRecord({ expiresAt: now - 60_000 }))

    purgeExpiredStates()

    expect(_testing.pendingStates.has('alive')).toBe(true)
    expect(_testing.pendingStates.has('dead-1')).toBe(false)
    expect(_testing.pendingStates.has('dead-2')).toBe(false)
    // Redis-side records are TTL'd server-side, so the purge MUST NOT
    // issue any DEL — that's the whole reason we offloaded GC to Redis.
    expect(fakeRedis.del).not.toHaveBeenCalled()
  })
})

// Restore env for sibling test files in the same `bun test` process.
if (prevLocalMode === undefined) delete process.env.SHOGO_LOCAL_MODE
else process.env.SHOGO_LOCAL_MODE = prevLocalMode

describe('pending-login-store — deletePendingState Redis error path', () => {
  test('logs and continues when Redis DEL throws, still clearing the local fallback (closes L152-156 catch arm)', async () => {
    const origWarn = console.warn
    const warns: any[][] = []
    console.warn = (...args: any[]) => {
      warns.push(args)
    }
    try {
      const record = fixtureRecord()
      _testing.pendingStates.set('boom-key', record)
      // Make Redis DEL reject for this one call.
      fakeRedis.del.mockImplementationOnce(async () => {
        throw new Error('redis offline')
      })

      await expect(deletePendingState('boom-key')).resolves.toBeUndefined()

      // Despite the redis throw, the local fallback was still purged.
      expect(_testing.pendingStates.has('boom-key')).toBe(false)
      const matching = warns.filter((a) =>
        String(a[0]).includes('[pending-login-store] Redis DEL failed'),
      )
      expect(matching.length).toBeGreaterThanOrEqual(1)
    } finally {
      console.warn = origWarn
    }
  })
})
