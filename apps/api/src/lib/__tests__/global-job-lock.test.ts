// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `withGlobalJobLock` is the single-writer-region wrapper for
 * globally-aggregating in-process crons (see
 * `apps/api/src/lib/global-job-lock.ts` for the contract). This test
 * exercises the three properties the wrapper exists to guarantee:
 *
 *   1. Concurrency: when two callers race the same `jobName`, exactly
 *      one runs the body and the other returns `{ skipped: true,
 *      reason: 'lock_not_acquired' }`. This is the structural fix for
 *      the 2026-05-21 analytics_digests poison-pill class — without
 *      the lock both regions would INSERT rows with conflicting
 *      secondary unique keys.
 *
 *   2. Failure release: a body that throws still releases the lock,
 *      so the next tick (whether in the same region or another) is
 *      not permanently locked out.
 *
 *   3. SHA-256 → bigint job-id derivation is deterministic across
 *      process restarts. This is what makes the lock work across pods
 *      in different K8s clusters; if the key derivation drifted, US's
 *      lock-id wouldn't match EU's and both would succeed.
 *
 * The concurrency / release halves talk to a real Postgres advisory
 * lock — there's no in-memory shim that meaningfully exercises
 * `pg_try_advisory_lock` race semantics. We follow the same
 * pg-reachability gate that `heartbeat-scheduler.test.ts` uses so devs
 * without a local pg can still run the unit suite.
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { Socket } from 'node:net'

const TEST_DB_URL =
  process.env.DATABASE_URL || 'postgres://shogo:shogo_dev@127.0.0.1:5432/shogo'

async function isPostgresReady(): Promise<boolean> {
  try {
    const url = new URL(TEST_DB_URL)
    const host = url.hostname
    const port = parseInt(url.port || '5432', 10)
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
      sock.connect(port, host)
    })
  } catch {
    return false
  }
}

const POSTGRES_READY = await isPostgresReady()

// Pure helper — no network. Safe to import unconditionally.
const { jobNameToLockId, withGlobalJobLock } = await import(
  '../global-job-lock'
)

describe('jobNameToLockId', () => {
  test('is deterministic for the same input', () => {
    expect(jobNameToLockId('storage-recalculate-all')).toBe(
      jobNameToLockId('storage-recalculate-all'),
    )
  })

  test('differs between distinct job names', () => {
    // Different job names must produce different lock keys; otherwise
    // two unrelated crons would serialise on the same advisory lock.
    expect(jobNameToLockId('storage-recalculate-all')).not.toBe(
      jobNameToLockId('grant-monthly-refill'),
    )
    expect(jobNameToLockId('grant-monthly-refill')).not.toBe(
      jobNameToLockId('voice-monthly-rebill'),
    )
  })

  test('result fits in a signed 64-bit integer (postgres bigint range)', () => {
    const key = jobNameToLockId('storage-recalculate-all')
    const TWO_63 = 1n << 63n
    expect(typeof key).toBe('bigint')
    expect(key >= -TWO_63).toBe(true)
    expect(key < TWO_63).toBe(true)
  })
})

describe('withGlobalJobLock — local-mode shortcut', () => {
  test('SHOGO_LOCAL_MODE=true runs the body unconditionally without touching pg', async () => {
    const prev = process.env.SHOGO_LOCAL_MODE
    process.env.SHOGO_LOCAL_MODE = 'true'
    try {
      let bodyRan = 0
      const res = await withGlobalJobLock(
        'local-mode-test',
        async () => {
          bodyRan++
          return 'ok'
        },
        // Deliberately bogus connection string to prove the helper
        // never tries to use it in local mode.
        { connectionString: 'postgres://unreachable.invalid:9999/x' },
      )
      expect(bodyRan).toBe(1)
      expect(res.acquired).toBe(true)
      if (res.acquired) {
        expect(res.result).toBe('ok')
      }
    } finally {
      if (prev === undefined) delete process.env.SHOGO_LOCAL_MODE
      else process.env.SHOGO_LOCAL_MODE = prev
    }
  })

  test('missing/non-pg DATABASE_URL also runs the body unconditionally', async () => {
    let bodyRan = 0
    const res = await withGlobalJobLock(
      'sqlite-mode-test',
      async () => {
        bodyRan++
      },
      { connectionString: 'file:./shogo.db' },
    )
    expect(bodyRan).toBe(1)
    expect(res.acquired).toBe(true)
  })
})

// Use a unique job name per test run so reruns can't collide with a
// stale lock if a previous run was killed mid-body. The lock helper
// already names them stably for production crons, but this test wants
// fresh keys.
function uniqueJobName(label: string): string {
  return `__test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

describe.skipIf(!POSTGRES_READY)(
  'withGlobalJobLock — pg-backed concurrency',
  () => {
    let connectionString: string

    beforeAll(() => {
      connectionString = TEST_DB_URL
      // Make sure local-mode shortcut isn't enabled when we explicitly
      // want the pg path.
      delete process.env.SHOGO_LOCAL_MODE
    })

    test('two concurrent callers: exactly one runs the body, the other reports lock_not_acquired', async () => {
      const job = uniqueJobName('concurrency')

      let bodyEntries = 0
      let bodyExits = 0
      let releaseBody!: () => void
      const bodyGate = new Promise<void>((resolve) => {
        releaseBody = resolve
      })

      // Caller A: enters the body, waits on bodyGate before returning.
      // While it's inside, caller B will race for the same lock.
      const pA = withGlobalJobLock(
        job,
        async () => {
          bodyEntries++
          await bodyGate
          bodyExits++
          return 'A'
        },
        { connectionString },
      )

      // Wait until A is definitely inside the body (its lock query has
      // returned `locked: true`) before kicking off B. A few ms is
      // enough; the body's await blocks until we resolve `bodyGate`.
      await new Promise((r) => setTimeout(r, 75))
      expect(bodyEntries).toBe(1)
      expect(bodyExits).toBe(0)

      const pB = withGlobalJobLock(
        job,
        async () => {
          bodyEntries++ // must not fire
          return 'B'
        },
        { connectionString },
      )

      const resB = await pB
      expect(resB.acquired).toBe(false)
      if (!resB.acquired) {
        expect(resB.skipped).toBe(true)
        expect(resB.reason).toBe('lock_not_acquired')
      }
      // A is still holding the lock — its body hasn't returned yet.
      expect(bodyEntries).toBe(1)
      expect(bodyExits).toBe(0)

      releaseBody()
      const resA = await pA
      expect(resA.acquired).toBe(true)
      if (resA.acquired) {
        expect(resA.result).toBe('A')
      }
      expect(bodyExits).toBe(1)

      // After A releases, a third call must succeed cleanly — proving
      // the lock was returned, not leaked.
      let cRan = 0
      const resC = await withGlobalJobLock(
        job,
        async () => {
          cRan++
        },
        { connectionString },
      )
      expect(cRan).toBe(1)
      expect(resC.acquired).toBe(true)
    }, 30_000)

    test('body throws → lock is released (next call succeeds)', async () => {
      const job = uniqueJobName('release-on-throw')

      await expect(
        withGlobalJobLock(
          job,
          async () => {
            throw new Error('boom')
          },
          { connectionString },
        ),
      ).rejects.toThrow('boom')

      let nextRan = 0
      const next = await withGlobalJobLock(
        job,
        async () => {
          nextRan++
          return 'recovered'
        },
        { connectionString },
      )
      expect(nextRan).toBe(1)
      expect(next.acquired).toBe(true)
      if (next.acquired) {
        expect(next.result).toBe('recovered')
      }
    }, 15_000)

    test('different job names do not serialise against each other', async () => {
      const jobA = uniqueJobName('isolation-a')
      const jobB = uniqueJobName('isolation-b')

      let releaseA!: () => void
      const gateA = new Promise<void>((r) => {
        releaseA = r
      })

      const pA = withGlobalJobLock(
        jobA,
        async () => {
          await gateA
          return 'A'
        },
        { connectionString },
      )

      // Even with A's body still pending, B with a different jobName
      // must acquire and run immediately.
      const resB = await withGlobalJobLock(
        jobB,
        async () => 'B',
        { connectionString },
      )
      expect(resB.acquired).toBe(true)

      releaseA()
      const resA = await pA
      expect(resA.acquired).toBe(true)
    }, 15_000)

    test('onSkipped callback is invoked instead of the default log when provided', async () => {
      const job = uniqueJobName('on-skipped')

      let releaseHolder!: () => void
      const gate = new Promise<void>((r) => {
        releaseHolder = r
      })

      const pHolder = withGlobalJobLock(
        job,
        async () => {
          await gate
          return 'held'
        },
        { connectionString },
      )

      await new Promise((r) => setTimeout(r, 50))

      let skippedJob: string | null = null
      const resSkipped = await withGlobalJobLock(
        job,
        async () => 'never',
        {
          connectionString,
          onSkipped: (name) => {
            skippedJob = name
          },
        },
      )
      expect(resSkipped.acquired).toBe(false)
      expect(skippedJob).toBe(job)

      releaseHolder()
      await pHolder
    }, 15_000)
  },
)
