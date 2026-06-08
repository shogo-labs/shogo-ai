// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Postgres advisory-lock wrapper for globally-aggregating in-process crons.
 *
 * Background
 * ----------
 * Shogo runs three OCI regions (US/EU/India) against a single logical-
 * replicated Postgres database (CNPG, PG 18, `INSERT_EXISTS_ACTION =
 * last_update_wins`). `last_update_wins` only resolves PRIMARY-KEY
 * collisions on apply; a conflict on any other UNIQUE INDEX halts the
 * apply worker until a human deletes the loser row. The 2026-05-21
 * `analytics_digests` incident was the first symptom — and the audit
 * trail in this repo identified `storage_usage` and `usage_wallets` as
 * latent versions of the same class.
 *
 * Every API replica in every region boots the same `setInterval`-based
 * cron schedulers (see `apps/api/src/server.ts` lines 6975-7157). For a
 * cron whose unique-key columns don't already include a writer-identity
 * column (`region`, `instanceId`, `writerId`, …), two regions hitting
 * the same tick produce two row inserts with different PKs but the same
 * secondary unique key. They both INSERT locally, replicate to the peer,
 * and poison the apply worker on conflict.
 *
 * Fix shape
 * ---------
 * Wrap the body of every "globally-aggregating" cron in
 * `withGlobalJobLock(jobName, body)`. Exactly one region wins
 * `pg_try_advisory_lock(<jobId>)` per tick; the others return
 * `{ skipped: true }`. If the holder's API pod dies mid-body the TCP
 * connection drops and Postgres releases the session-level lock, so
 * the next tick in any region can pick the job back up — failover is
 * automatic, no environment variable or external coordinator needed.
 *
 * `analytics_digests` is INTENTIONALLY NOT wrapped — it's the one cron
 * we want to evolve into a genuine per-region aggregation (separate
 * funnel numbers for US/EU/India). The CI guard at
 * `scripts/check-multiregion-cron-locks.ts` knows about this exemption
 * via an explicit `INTENTIONALLY_REGIONAL` allowlist entry.
 *
 * Implementation notes
 * --------------------
 * - The lock is held on a DEDICATED `pg.Client` connection (not on the
 *   shared Prisma pool). This way the body can issue its own
 *   `prisma.*` calls against the pool in parallel without re-entering
 *   the lock connection, and the body's duration doesn't tie up a pool
 *   slot or hold an XID open. (`pg_try_advisory_xact_lock` inside a
 *   `prisma.$transaction` was the original sketch — rejected because
 *   `recalculateAllStorageUsage` iterates every workspace, calls S3 per
 *   project, and can run for minutes; that's too long to hold an
 *   open transaction.)
 * - Lock keys are SHA-256(jobName) truncated to 64 bits and interpreted
 *   as a signed `BIGINT` (pg's `pg_try_advisory_lock(bigint)`
 *   signature). Stable across language/process restarts; the
 *   `KNOWN_JOB_IDS` map below is the CI guard's source of truth for
 *   "which crons must be wrapped".
 * - Local-mode (SQLite, `SHOGO_LOCAL_MODE === 'true'`) bypasses the
 *   lock and runs the body directly — there's only one writer in local
 *   mode by definition.
 */

import { createHash } from 'node:crypto'

/**
 * Registry of every cron currently wrapped in `withGlobalJobLock`.
 * The CI guard (`scripts/check-multiregion-cron-locks.ts`) reads this
 * map as the source of truth for which jobs are expected to use the
 * wrapper. Adding a new entry here without also wrapping the cron, or
 * vice versa, fails CI.
 *
 * `jobName` is the string passed to `withGlobalJobLock(jobName, ...)`.
 * The `bigint` is the SHA-256-derived lock key, exposed so operators
 * can correlate `pg_locks` rows back to job names if they ever need to
 * debug a stuck lock.
 */
export const KNOWN_JOB_IDS: Record<string, bigint> = Object.freeze({
  'storage-recalculate-all': jobNameToLockId('storage-recalculate-all'),
  'grant-monthly-refill': jobNameToLockId('grant-monthly-refill'),
  'voice-monthly-rebill': jobNameToLockId('voice-monthly-rebill'),
  'approve-commissions': jobNameToLockId('approve-commissions'),
  'affiliate-payouts': jobNameToLockId('affiliate-payouts'),
  'affiliate-invoice-reconciliation': jobNameToLockId('affiliate-invoice-reconciliation'),
  'poll-affiliate-content': jobNameToLockId('poll-affiliate-content'),
}) as Record<string, bigint>

export type GlobalJobLockResult<T> =
  | { acquired: true; result: T }
  | { acquired: false; skipped: true; reason: 'lock_not_acquired' }
  | { acquired: false; skipped: true; reason: 'local_mode' }

export interface WithGlobalJobLockOptions {
  /**
   * Optional override of the Postgres connection string. Defaults to
   * `process.env.DATABASE_URL`. Exposed for tests.
   */
  connectionString?: string
  /**
   * Called when the lock could not be acquired and the body was skipped.
   * Defaults to a `console.log` with the job name.
   */
  onSkipped?: (jobName: string) => void
}

/**
 * Acquire `pg_advisory_lock(<jobId>)` on a dedicated connection, run
 * `body`, then release. Returns `{ skipped: true }` (does not throw)
 * when the lock is already held in another region — callers should log
 * and move on, NOT retry inside the same tick.
 *
 * Exceptions thrown by `body` propagate to the caller AFTER the lock is
 * released; the connection is always closed in `finally`.
 */
export async function withGlobalJobLock<T>(
  jobName: string,
  body: () => Promise<T>,
  opts: WithGlobalJobLockOptions = {},
): Promise<GlobalJobLockResult<T>> {
  const connectionString = opts.connectionString ?? process.env.DATABASE_URL

  // Local SQLite mode and missing DB — no replication, no peers to
  // race against; run the body unconditionally so dev/test paths still
  // exercise the cron logic.
  if (
    process.env.SHOGO_LOCAL_MODE === 'true' ||
    !connectionString ||
    !connectionString.startsWith('postgres')
  ) {
    const result = await body()
    return { acquired: true, result }
  }

  const key = KNOWN_JOB_IDS[jobName] ?? jobNameToLockId(jobName)

  // Import `pg` lazily so the lock helper can be imported in SQLite-
  // only test contexts without pulling the driver eagerly.
  const { Client } = await import('pg')
  const client = new Client({ connectionString })
  await client.connect()
  try {
    // Disable statement_timeout for the lock session — the body can run
    // for many minutes (S3 listing, per-workspace recalculation). Some
    // deployments set a global default that would otherwise cancel the
    // session mid-body and release the lock prematurely.
    await client.query('SET LOCAL statement_timeout = 0').catch(() => {
      // `SET LOCAL` requires an active transaction; fall back to
      // session-scoped SET, which is what we actually want here.
      return client.query('SET statement_timeout = 0')
    })

    // `pg` parameterises bigint as a string; pg-side it's cast back to
    // `bigint` by the function signature `pg_try_advisory_lock(bigint)`.
    const acquired = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS locked',
      [key.toString()],
    )
    if (!acquired.rows[0]?.locked) {
      const onSkipped =
        opts.onSkipped ??
        ((name: string) =>
          console.log(
            `[GlobalJobLock] ${name} skipped — lock held by another region (key=${key})`,
          ))
      onSkipped(jobName)
      return { acquired: false, skipped: true, reason: 'lock_not_acquired' }
    }

    try {
      const result = await body()
      return { acquired: true, result }
    } finally {
      // Best-effort release; the session-end below will release anyway
      // if this somehow fails.
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [
          key.toString(),
        ])
      } catch (err) {
        console.error(
          `[GlobalJobLock] ${jobName}: pg_advisory_unlock failed (non-fatal — session-end will release):`,
          err,
        )
      }
    }
  } finally {
    try {
      await client.end()
    } catch {
      // Connection might already be closed (pod shutdown race); ignore.
    }
  }
}

/**
 * Map a job name to a stable 64-bit signed integer suitable for
 * `pg_try_advisory_lock(bigint)`. Deterministic across deploys and
 * processes; SHA-256 ensures collision resistance even as we add more
 * cron names.
 *
 * Postgres `bigint` is signed (range -2^63 .. 2^63 - 1). We take the
 * first 8 bytes of the digest and interpret them as a signed BE
 * integer; `BigInt.asIntN(64, x)` masks to that range.
 */
export function jobNameToLockId(jobName: string): bigint {
  const digest = createHash('sha256').update(jobName, 'utf-8').digest()
  // Read big-endian 64-bit unsigned, then reinterpret as signed.
  const unsigned = digest.readBigUInt64BE(0)
  return BigInt.asIntN(64, unsigned)
}
