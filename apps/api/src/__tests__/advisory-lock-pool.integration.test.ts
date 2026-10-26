// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `withAdvisoryLock` against a real Postgres, with the production lock-pool
 * size (4).
 *
 * 2026-10-17 us-ashburn-1: the metal rewarm held spawn leases through slow
 * boots while user opens queued behind them. Every waiter kept a dedicated
 * lock connection for its whole poll, so the 4-slot pool filled and every
 * other key on that replica failed with "timeout exceeded when trying to
 * connect" and ran without its lease. These tests pin the fixed behavior:
 * waiters hold no connection while they wait, unrelated keys still lock
 * promptly, and a pool saturated by real holders fails within the caller's
 * budget instead of the pool's connect timeout.
 *
 *   ADVISORY_LOCK_TEST_PG_URL=postgres://... bun test src/__tests__/advisory-lock-pool.integration.test.ts
 *
 * Skipped when no Postgres is reachable (CI runs it in the rbac-postgres job).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Socket } from 'node:net'
import { Client } from 'pg'

const PG_URL =
  process.env.ADVISORY_LOCK_TEST_PG_URL ??
  process.env.CHANNELS_TEST_PG_URL ??
  'postgres://shogo:shogo@127.0.0.1:5432/shogo'
const POOL_SIZE = 4
const APP_NAME = `advisory-lock-it-${process.pid}`

async function reachable(url: string): Promise<boolean> {
  try {
    const u = new URL(url)
    return await new Promise<boolean>((resolve) => {
      const sock = new Socket()
      const done = (ok: boolean) => {
        sock.destroy()
        resolve(ok)
      }
      sock.setTimeout(500)
      sock.once('connect', () => done(true))
      sock.once('error', () => done(false))
      sock.once('timeout', () => done(false))
      sock.connect(parseInt(u.port || '5432', 10), u.hostname)
    })
  } catch {
    return false
  }
}

const pgUp = await reachable(PG_URL)
if (process.env.REQUIRE_PG_INTEGRATION === '1' && !pgUp) {
  throw new Error(`REQUIRE_PG_INTEGRATION=1 but Postgres is unreachable at ${PG_URL}`)
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe.skipIf(!pgUp)('withAdvisoryLock on a real Postgres (pool size 4)', () => {
  let lock: typeof import('../lib/advisory-lock')
  let observer: Client
  const saved = { direct: process.env.DATABASE_DIRECT_URL, size: process.env.ADVISORY_LOCK_POOL_SIZE }

  /** Backends the lock pool has open, leased or idle (tagged via application_name). */
  async function backendCount(): Promise<number> {
    const r = await observer.query(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1',
      [APP_NAME],
    )
    return r.rows[0].n
  }

  beforeAll(async () => {
    const u = new URL(PG_URL)
    u.searchParams.set('application_name', APP_NAME)
    process.env.DATABASE_DIRECT_URL = u.toString()
    process.env.ADVISORY_LOCK_POOL_SIZE = String(POOL_SIZE)
    lock = await import('../lib/advisory-lock')
    observer = new Client({ connectionString: PG_URL })
    await observer.connect()
  })

  afterAll(async () => {
    await observer?.end()
    process.env.DATABASE_DIRECT_URL = saved.direct
    process.env.ADVISORY_LOCK_POOL_SIZE = saved.size
  })

  test('waiters on a busy key keep no connection, so an unrelated key still locks promptly', async () => {
    const busy = lock.fnv1a64(`it:busy:${Date.now()}`)
    const other = lock.fnv1a64(`it:other:${Date.now()}`)

    let inside = 0
    let maxInside = 0
    const body = (holdMs: number) => async () => {
      inside++
      maxInside = Math.max(maxInside, inside)
      await sleep(holdMs)
      inside--
      return true
    }

    // One slow holder plus six waiters on the same key: under the old code
    // the holder and three waiters took all four slots for the whole wait.
    const holder = lock.withAdvisoryLock(busy, body(2500), { budgetMs: 30_000 })
    await sleep(150)
    const waiters = Array.from({ length: 6 }, () =>
      lock.withAdvisoryLock(busy, body(150), { budgetMs: 30_000, maxIntervalMs: 200 }),
    )
    // Only the holder keeps a connection; waiters lease one per attempt and
    // return it before sleeping. Retries can briefly overlap, but between
    // them only the holder's lease remains — pinned waiters would keep the
    // pool at POOL_SIZE throughout.
    await sleep(200)
    let minLeased = Infinity
    for (let i = 0; i < 40; i++) {
      minLeased = Math.min(minLeased, lock.getAdvisoryLockPoolUsage().leased)
      await sleep(25)
    }
    expect(minLeased).toBeLessThanOrEqual(1)

    const started = Date.now()
    const unrelated = await lock.withAdvisoryLock(other, async () => 'ran', { budgetMs: 3000 })
    expect(unrelated).toEqual({ held: true, result: 'ran' })
    expect(Date.now() - started).toBeLessThan(1500)

    const results = await Promise.all([holder, ...waiters])
    expect(results.every((r) => r.held && r.result === true)).toBe(true)
    // Real mutual exclusion across sessions: never two bodies at once.
    expect(maxInside).toBe(1)
    expect(await backendCount()).toBeLessThanOrEqual(POOL_SIZE)
    expect(lock.getAdvisoryLockPoolUsage().leased).toBe(0)
  }, 30_000)

  test('a pool saturated by holders fails within the caller budget, reason=unavailable', async () => {
    const holders = Array.from({ length: POOL_SIZE }, (_, i) =>
      lock.withAdvisoryLock(lock.fnv1a64(`it:hold:${i}:${Date.now()}`), async () => {
        await sleep(6000)
        return i
      }),
    )
    await sleep(300)
    expect(lock.getAdvisoryLockPoolUsage().leased).toBe(POOL_SIZE)

    const started = Date.now()
    const starved = await lock.withAdvisoryLock(lock.fnv1a64(`it:starved:${Date.now()}`), async () => 'no', {
      budgetMs: 1000,
    })
    const waited = Date.now() - started
    expect(starved).toEqual({ held: false, reason: 'unavailable' })
    // Bounded by the budget plus at most one 2s connect attempt — not the
    // old 15s connect timeout on top of the budget.
    expect(waited).toBeLessThan(3500)

    await Promise.all(holders)
  }, 30_000)

  test('a caller that cannot connect at first gets the lock once a holder finishes', async () => {
    const holders = Array.from({ length: POOL_SIZE }, (_, i) =>
      lock.withAdvisoryLock(lock.fnv1a64(`it:brief:${i}:${Date.now()}`), async () => {
        await sleep(800)
        return i
      }),
    )
    await sleep(200)
    const late = await lock.withAdvisoryLock(lock.fnv1a64(`it:late:${Date.now()}`), async () => 'ran', {
      budgetMs: 10_000,
    })
    expect(late).toEqual({ held: true, result: 'ran' })
    await Promise.all(holders)
  }, 30_000)

  test('contended reason when another session holds the key for the whole budget', async () => {
    const key = lock.fnv1a64(`it:contended:${Date.now()}`)
    const outside = new Client({ connectionString: PG_URL })
    await outside.connect()
    try {
      await outside.query('SELECT pg_advisory_lock($1::bigint)', [key.toString()])
      const out = await lock.withAdvisoryLock(key, async () => 'no', { budgetMs: 600 })
      expect(out).toEqual({ held: false, reason: 'contended' })
    } finally {
      await outside.end()
    }
  }, 30_000)
})
