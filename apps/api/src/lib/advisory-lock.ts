// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Bounded, NON-BLOCKING PostgreSQL advisory-lock acquisition.
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
 * `pg_try_advisory_lock()` returns immediately. By polling it with capped
 * exponential backoff and *sleeping between attempts*, a waiter holds a
 * pooled connection only for the brief duration of each try — between tries
 * the connection is returned to the pool. A contended wait therefore can
 * never exhaust the pool, no matter how slow the holder is.
 *
 * Callers decide what to do when the budget is exhausted (reuse an existing
 * claim, fall back to a cold start, or run their body un-serialized when it
 * is self-guarding). This module intentionally does NOT block.
 *
 * NOTE ON SESSION SCOPE: advisory locks taken this way are session-scoped and
 * auto-release when the backing connection ends. Acquire and release should
 * be issued through the same client so the release lands on the holding
 * backend; both call sites use Prisma's pool for this, which is acceptable
 * because a leaked lock now only degrades to a graceful fallback (cold start
 * / re-check) rather than an unbounded pool-pinning wait.
 */

export interface AdvisoryPollDeps {
  /** Non-blocking acquire. Resolves true iff the lock was taken. */
  tryLock: (key: number) => Promise<boolean>
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
 * Never issues a blocking lock, so a waiter never pins a pooled connection
 * across the wait.
 */
export async function pollAdvisoryLock(
  key: number,
  deps: AdvisoryPollDeps,
  opts: AdvisoryPollOptions = {},
): Promise<boolean> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = deps.now ?? Date.now
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS
  const initial = opts.initialIntervalMs ?? DEFAULT_INITIAL_INTERVAL_MS
  const max = opts.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS

  // Fast path: one round-trip in the common uncontended case.
  if (await deps.tryLock(key)) return true

  const deadline = now() + budgetMs
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
