// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Bounded, NON-BLOCKING PostgreSQL advisory locks on a DEDICATED connection.
 *
 * WHY THIS EXISTS
 * ---------------
 * The warm-pool claim path and the workspace spawn lease previously issued a
 * *blocking* `pg_advisory_lock()` through the shared Prisma connection pool.
 * A blocked waiter holds its pooled connection for the ENTIRE wait, so when a
 * lock holder was slow (a warm-pool assign / Knative call stalled for
 * minutes), every other request contending for that key stacked up, each
 * pinning a connection. They climbed to ~144 of 200 backends until ordinary
 * queries — e.g. `prisma.invitation.count()` — could no longer obtain a
 * connection at all. That was the 2026-07-01 `ap-mumbai-1` outage: Prisma
 * failing to get a connection, not a bad query.
 *
 * This module fixes that on two axes:
 *
 *  1. NON-BLOCKING WAIT. `withAdvisoryLock` polls `pg_try_advisory_lock`
 *     with capped exponential backoff, leasing a lock connection for each
 *     attempt and returning it before sleeping. Only the winner keeps its
 *     connection. Holding it across the wait let a handful of slow holders
 *     plus their waiters drain the small lock pool, and every other key on
 *     the pod then failed to connect (2026-10-17 us-ashburn-1 rewarm).
 *
 *  2. DEDICATED CONNECTION. `withAdvisoryLock` acquires the lock on its own
 *     `pg.Pool` (on `DATABASE_DIRECT_URL`, bypassing PgBouncer) rather than
 *     the Prisma pool. This is REQUIRED once PgBouncer runs in transaction
 *     mode: session-scoped advisory locks must be acquired and released on
 *     the *same* backend session, which a transaction-pooled connection does
 *     not guarantee. It also keeps lock waits off the pool that serves normal
 *     app queries.
 *
 * Keys are 64-bit (`bigint`) — see `fnv1a64`. Postgres advisory locks share a
 * single `bigint` keyspace; 64 bits makes cross-collision between the
 * project / workspace / cron keyspaces negligible. Because JS numbers cannot
 * represent 64 bits exactly, keys are always passed as strings and cast with
 * `$1::bigint`.
 */

import type { Pool as PgPool } from 'pg'

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

const FNV64_OFFSET_BASIS = 0xcbf29ce484222325n
const FNV64_PRIME = 0x100000001b3n
const U64_MASK = 0xffffffffffffffffn

/**
 * 64-bit FNV-1a hash of `input`, reinterpreted as a signed `bigint` in the
 * Postgres `bigint` range (-2^63 .. 2^63-1) via `BigInt.asIntN(64, ...)`.
 * Deterministic across processes/deploys. Mirrors the SHA-256→signed-bigint
 * shape used by `jobNameToLockId` in global-job-lock.ts.
 */
export function fnv1a64(input: string): bigint {
  let hash = FNV64_OFFSET_BASIS
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i))
    hash = (hash * FNV64_PRIME) & U64_MASK
  }
  return BigInt.asIntN(64, hash)
}

// ---------------------------------------------------------------------------
// Non-blocking bounded poll
// ---------------------------------------------------------------------------

export interface AdvisoryPollDeps {
  /** Non-blocking acquire. Resolves true iff the lock was taken. */
  tryLock: (key: bigint) => Promise<boolean>
  /** Overridable for tests. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>
  /** Overridable for tests. Defaults to Date.now. */
  now?: () => number
}

export interface AdvisoryPollOptions {
  /** Total wall-clock budget to keep polling before giving up. */
  budgetMs?: number
  /** First backoff interval between attempts. */
  initialIntervalMs?: number
  /** Backoff ceiling. */
  maxIntervalMs?: number
}

const DEFAULT_BUDGET_MS = 15_000
const DEFAULT_INITIAL_INTERVAL_MS = 100
const DEFAULT_MAX_INTERVAL_MS = 1_000

/**
 * Poll `tryLock(key)` with capped exponential backoff until it succeeds or
 * `budgetMs` elapses. Resolves `true` if the lock was acquired (caller now
 * holds it and MUST release it), `false` if the budget was exhausted (caller
 * never held it and MUST NOT release it).
 *
 * Never issues a blocking lock, so a waiter never pins a connection across
 * the wait.
 */
export async function pollAdvisoryLock(
  key: bigint,
  deps: AdvisoryPollDeps,
  opts: AdvisoryPollOptions = {},
): Promise<boolean> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = deps.now ?? Date.now
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS
  const initial = opts.initialIntervalMs ?? DEFAULT_INITIAL_INTERVAL_MS
  const max = opts.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS

  // The budget covers the first attempt too: under pool pressure that one
  // can itself take a full connect timeout.
  const deadline = now() + budgetMs
  // Fast path: one round-trip in the common uncontended case.
  if (await deps.tryLock(key)) return true

  let interval = initial
  while (now() < deadline) {
    const remaining = deadline - now()
    if (remaining <= 0) break
    await sleep(Math.min(interval, remaining))
    if (await deps.tryLock(key)) return true
    interval = Math.min(interval * 2, max)
  }
  return false
}

// ---------------------------------------------------------------------------
// Dedicated-connection advisory lock
// ---------------------------------------------------------------------------

/**
 * A leased connection capable of taking/releasing an advisory lock. Acquire
 * and release MUST hit the same backend session, which is why these three
 * operations are bound to a single client.
 */
export interface AdvisoryLockClient {
  tryLock: (key: bigint) => Promise<boolean>
  unlock: (key: bigint) => Promise<void>
  /** Return the connection. `poisoned=true` drops it (do not reuse). */
  release: (poisoned: boolean) => Promise<void> | void
}

export interface WithAdvisoryLockDeps {
  /**
   * Override how a lock connection is obtained. Defaults to the internal
   * dedicated `pg.Pool`. Tests inject an in-memory client.
   */
  acquireClient?: () => Promise<AdvisoryLockClient>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface WithAdvisoryLockOptions extends AdvisoryPollOptions {
  deps?: WithAdvisoryLockDeps
}

export interface WithAdvisoryLockResult<T> {
  /** true iff the lock was acquired within budget and `fn` ran under it. */
  held: boolean
  /** Present iff `held` is true. */
  result?: T
  /**
   * Present iff `held` is false. `contended`: another session held the key
   * for the whole budget. `unavailable`: no lock connection could be obtained
   * (pool exhausted, DB unreachable) on the last attempt.
   */
  reason?: 'contended' | 'unavailable'
}

let lockPool: PgPool | null = null

/**
 * Max dedicated lock connections per process — i.e. the max number of locks
 * this process can HOLD at once. Callers that fan out lock-holding work (the
 * metal rewarm drain) must stay below this so user-facing spawns keep a slot.
 */
export function getAdvisoryLockPoolSize(): number {
  const n = parseInt(process.env.ADVISORY_LOCK_POOL_SIZE || '', 10)
  return Number.isFinite(n) && n > 0 ? n : 6
}

/**
 * Lazily create the dedicated advisory-lock pool. Uses `DATABASE_DIRECT_URL`
 * so it bypasses PgBouncer (session-scoped locks require a stable backend
 * session), falling back to `DATABASE_URL` when no pooler is deployed.
 */
async function getLockPool(): Promise<PgPool> {
  if (lockPool) return lockPool
  const connectionString = process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL
  if (!connectionString || !connectionString.startsWith('postgres')) {
    throw new Error(
      '[advisory-lock] no PostgreSQL DATABASE_DIRECT_URL/DATABASE_URL configured for the dedicated lock pool',
    )
  }
  const { Pool } = await import('pg')
  lockPool = new Pool({
    connectionString,
    // Only lock HOLDERS keep a slot; waiters lease one per attempt. The short
    // connect timeout keeps a saturated pool from eating a waiter's budget in
    // one attempt — withAdvisoryLock retries the connect until the deadline.
    max: getAdvisoryLockPoolSize(),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 2_000,
  })
  return lockPool
}

/** Lock connections currently leased out of the dedicated pool (tests, diagnostics). */
export function getAdvisoryLockPoolUsage(): { leased: number; waiting: number } {
  if (!lockPool) return { leased: 0, waiting: 0 }
  return { leased: lockPool.totalCount - lockPool.idleCount, waiting: lockPool.waitingCount }
}

/**
 * Test seam: overrides how a lock connection is obtained for callers that do
 * NOT pass an explicit `deps.acquireClient` (i.e. production call sites like
 * tryClaimWarmPod). Lets tests exercise those sites without a real Postgres /
 * pg pool. Reset to `null` in test teardown. Explicit `deps.acquireClient`
 * always takes precedence over this.
 */
let acquireClientOverride: (() => Promise<AdvisoryLockClient>) | null = null

export function __setAdvisoryLockAcquireClientForTests(
  fn: (() => Promise<AdvisoryLockClient>) | null,
): void {
  acquireClientOverride = fn
}

async function defaultAcquireClient(): Promise<AdvisoryLockClient> {
  const pool = await getLockPool()
  const client = await pool.connect()
  return {
    tryLock: async (key: bigint) => {
      const res = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
        [key.toString()],
      )
      return res.rows[0]?.acquired === true
    },
    unlock: async (key: bigint) => {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [key.toString()])
    },
    release: (poisoned: boolean) => client.release(poisoned),
  }
}

/**
 * Acquire `key` on a dedicated connection (bounded, non-blocking), run `fn`
 * while holding it, then release on the SAME connection.
 *
 * Contract:
 *   - `{ held: true, result }`  — lock acquired, `fn` ran exactly once. If
 *     `fn` throws, the error propagates (lock is released first).
 *   - `{ held: false, reason }` — lock NOT acquired within budget, either
 *     because another session held it (`contended`) or because no lock
 *     connection could be obtained (`unavailable`). `fn` did NOT run; the
 *     caller decides the fallback (cold start, run un-serialized, etc.).
 *
 * Each attempt leases its own connection and returns it unless it won, so a
 * waiter holds no connection while it sleeps. A failed connect is retried
 * like a contended lock until the budget runs out: a saturated pool frees a
 * slot as soon as any holder finishes.
 *
 * Infra failures are surfaced as `held: false` rather than thrown, so callers
 * can cleanly distinguish "couldn't lock" from "fn threw".
 */
export async function withAdvisoryLock<T>(
  key: bigint,
  fn: () => Promise<T>,
  opts: WithAdvisoryLockOptions = {},
): Promise<WithAdvisoryLockResult<T>> {
  const acquireClient = opts.deps?.acquireClient ?? acquireClientOverride ?? defaultAcquireClient

  let client = null as AdvisoryLockClient | null
  let lastErr: unknown = null
  const attempt = async (k: bigint): Promise<boolean> => {
    let c: AdvisoryLockClient
    try {
      c = await acquireClient()
    } catch (err) {
      lastErr = err
      return false
    }
    try {
      if (await c.tryLock(k)) {
        client = c
        return true
      }
      lastErr = null
      try { await c.release(false) } catch { /* ignore */ }
    } catch (err) {
      lastErr = err
      try { await c.release(true) } catch { /* already gone */ }
    }
    return false
  }

  await pollAdvisoryLock(key, { tryLock: attempt, sleep: opts.deps?.sleep, now: opts.deps?.now }, opts)

  if (!client) {
    if (lastErr) {
      console.error(
        `[advisory-lock] failed to acquire dedicated lock connection for key=${key}; treating as not-held:`,
        lastErr,
      )
      return { held: false, reason: 'unavailable' }
    }
    return { held: false, reason: 'contended' }
  }
  return runHeld(client, key, fn)
}

async function runHeld<T>(
  client: AdvisoryLockClient,
  key: bigint,
  fn: () => Promise<T>,
): Promise<WithAdvisoryLockResult<T>> {

  // We hold the lock. Run fn exactly once; its errors propagate.
  let poisoned = false
  try {
    const result = await fn()
    return { held: true, result }
  } finally {
    try {
      await client.unlock(key)
    } catch (err) {
      // Drop the connection so a failed unlock can't leak a lock into a
      // reused pooled session.
      poisoned = true
      console.error(
        `[advisory-lock] pg_advisory_unlock failed for key=${key} (non-fatal — dropping connection):`,
        err,
      )
    }
    try { await client.release(poisoned) } catch { /* ignore */ }
  }
}
