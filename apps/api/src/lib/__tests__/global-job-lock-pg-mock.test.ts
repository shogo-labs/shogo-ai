// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `withGlobalJobLock` exercising the full Postgres path via a
 * mocked `pg` Client. Complements the real-pg tests in
 * `global-job-lock.test.ts` (which skip when Postgres is unavailable).
 *
 * Covers: lines 126, 128, 132-135, 140-142, 144, 148-156, 158-161,
 *         163-166, 169-177, 180-182 of global-job-lock.ts.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'

// ─── pg mock ────────────────────────────────────────────────────────────────

let pgQuery: (sql: string, params?: any[]) => Promise<{ rows: any[] }>
let pgEndFn: () => Promise<void>

mock.module('pg', () => ({
  Client: class MockClient {
    connect() { return Promise.resolve() }
    query(sql: string, params?: any[]) { return pgQuery(sql, params) }
    end() { return pgEndFn() }
  },
}))

const { withGlobalJobLock } = await import('../global-job-lock')

const FAKE_PG_URL = 'postgres://fake:fake@localhost:9999/fake'

beforeEach(() => {
  delete process.env.SHOGO_LOCAL_MODE
  pgQuery = async (sql: string) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] }
    return { rows: [] }
  }
  pgEndFn = async () => {}
})

describe('withGlobalJobLock — pg path (mocked pg.Client)', () => {
  test('acquires lock, runs body, releases, closes connection', async () => {
    const sqls: string[] = []
    pgQuery = async (sql) => {
      sqls.push(sql)
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] }
      return { rows: [] }
    }
    let bodyRan = false
    const res = await withGlobalJobLock('grant-monthly-refill', async () => {
      bodyRan = true
      return 42
    }, { connectionString: FAKE_PG_URL })

    expect(res.acquired).toBe(true)
    if (res.acquired) expect(res.result).toBe(42)
    expect(bodyRan).toBe(true)
    expect(sqls.some((q) => q.includes('pg_try_advisory_lock'))).toBe(true)
    expect(sqls.some((q) => q.includes('pg_advisory_unlock'))).toBe(true)
  })

  test('returns lock_not_acquired + default log when locked=false', async () => {
    pgQuery = async (sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: false }] }
      return { rows: [] }
    }
    const logs: string[] = []
    const origLog = console.log
    console.log = (...a: any[]) => logs.push(a.join(' '))
    let bodyRan = false
    const res = await withGlobalJobLock('storage-recalculate-all', async () => { bodyRan = true }, { connectionString: FAKE_PG_URL })
    console.log = origLog

    expect(res.acquired).toBe(false)
    if (!res.acquired) expect(res.reason).toBe('lock_not_acquired')
    expect(bodyRan).toBe(false)
    expect(logs.some((l) => l.includes('GlobalJobLock'))).toBe(true)
  })

  test('custom onSkipped is called instead of default log', async () => {
    pgQuery = async (sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: false }] }
      return { rows: [] }
    }
    let skipped: string | null = null
    const res = await withGlobalJobLock('voice-monthly-rebill', async () => {}, {
      connectionString: FAKE_PG_URL,
      onSkipped: (n) => { skipped = n },
    })
    expect(res.acquired).toBe(false)
    expect(skipped).toBe('voice-monthly-rebill')
  })

  test('unknown job name falls back to jobNameToLockId', async () => {
    const sqls: string[] = []
    pgQuery = async (sql, params) => {
      sqls.push(sql)
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] }
      return { rows: [] }
    }
    const res = await withGlobalJobLock('brand-new-job', async () => 'ok', { connectionString: FAKE_PG_URL })
    expect(res.acquired).toBe(true)
    expect(sqls.some((q) => q.includes('pg_try_advisory_lock'))).toBe(true)
  })

  test('SET LOCAL fails → catch falls back to session SET', async () => {
    let setLocalSeen = false
    pgQuery = async (sql) => {
      if (sql.includes('SET LOCAL')) { setLocalSeen = true; throw new Error('SET LOCAL disallowed') }
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] }
      return { rows: [] }
    }
    const res = await withGlobalJobLock('storage-recalculate-all', async () => 'fallback', { connectionString: FAKE_PG_URL })
    expect(setLocalSeen).toBe(true)
    expect(res.acquired).toBe(true)
    if (res.acquired) expect(res.result).toBe('fallback')
  })

  test('pg_advisory_unlock fails → error logged, body result still returned', async () => {
    pgQuery = async (sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] }
      if (sql.includes('pg_advisory_unlock')) throw new Error('unlock failed')
      return { rows: [] }
    }
    const errs: any[] = []
    const origErr = console.error
    console.error = (...a: any[]) => errs.push(a)
    const res = await withGlobalJobLock('grant-monthly-refill', async () => 'still ok', { connectionString: FAKE_PG_URL })
    console.error = origErr
    expect(res.acquired).toBe(true)
    if (res.acquired) expect(res.result).toBe('still ok')
    expect(errs.some((e) => e[0].includes('pg_advisory_unlock'))).toBe(true)
  })

  test('body throws → unlock is attempted, error propagates', async () => {
    const sqls: string[] = []
    pgQuery = async (sql) => {
      sqls.push(sql)
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] }
      return { rows: [] }
    }
    await expect(
      withGlobalJobLock('storage-recalculate-all', async () => { throw new Error('body boom') }, { connectionString: FAKE_PG_URL })
    ).rejects.toThrow('body boom')
    expect(sqls.some((q) => q.includes('pg_advisory_unlock'))).toBe(true)
  })

  test('client.end() throws → error is swallowed', async () => {
    pgEndFn = async () => { throw new Error('end blown') }
    const res = await withGlobalJobLock('grant-monthly-refill', async () => 'end-safe', { connectionString: FAKE_PG_URL })
    expect(res.acquired).toBe(true)
    if (res.acquired) expect(res.result).toBe('end-safe')
  })
})
