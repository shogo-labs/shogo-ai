// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cross-replica spawn authority for WORKSPACE runtimes.
 *
 * In cloud (Kubernetes / VM) deployments several API replicas can each
 * receive a chat request for the same workspace at the same time. Without a
 * shared lease they would race to spawn the workspace runtime — creating
 * duplicate Knative services / VM assignments and double-charging S3 restore
 * + cold-start cost. The single-project path already guards this with a
 * PostgreSQL advisory lock keyed on the project id (see
 * `knative-project-manager.ts:tryClaimWarmPod`); this is the workspace-keyed
 * sibling.
 *
 * Design mirrors the project path deliberately so the two stay in lockstep:
 *   - `pg_try_advisory_lock` first (non-blocking) so the common uncontended
 *     case is one round-trip.
 *   - On contention, fall back to a blocking `pg_advisory_lock` so the loser
 *     waits for the winner to finish spawning, then runs `fn()` itself —
 *     `fn` is expected to short-circuit when it observes the runtime is
 *     already up (the resolver re-checks service existence after acquiring).
 *   - Always release in `finally`.
 *
 * Advisory locks are session-scoped (not transaction-scoped), so we don't
 * hold a transaction open across the long spawn. This matches the existing
 * project claim path; the same Prisma-pooled-connection caveat applies and
 * is accepted repo-wide.
 *
 * HOST / desktop mode is single-process and SQLite-backed (no
 * `pg_advisory_lock`), so the resolver does NOT take this lease there — the
 * in-process `startingPromises` dedup in `RuntimeManager.startWorkspace` is
 * sufficient. This module is only invoked on the cloud (k8s/vm) branches.
 *
 * All Postgres calls are behind injection seams so the orchestration is
 * unit-testable without a database.
 */

/**
 * Namespace prefix folded into the hash so workspace lock keys never collide
 * with the project lock keyspace (`hashProjectIdToLockKey` hashes the raw
 * project id). A workspace and a project could in principle share a UUID
 * across tables; prefixing guarantees disjoint advisory-lock keys.
 */
const WORKSPACE_LOCK_NAMESPACE = 'shogo:ws-spawn:'

/**
 * Deterministic 32-bit FNV-1a hash of `ws-spawn:<workspaceId>` for use as a
 * PostgreSQL advisory-lock key. Same FNV constants as the project path so the
 * algorithm is consistent across the codebase.
 */
export function hashWorkspaceIdToLockKey(workspaceId: string): number {
  const input = WORKSPACE_LOCK_NAMESPACE + workspaceId
  let hash = 0x811c9dc5 // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = (hash * 0x01000193) | 0 // FNV prime, force 32-bit
  }
  return hash
}

export interface WorkspaceSpawnLeaseSeams {
  /** Non-blocking acquire. Resolves true if the lock was taken. */
  _tryLock?: (key: number) => Promise<boolean>
  /** Blocking acquire. Resolves once the lock is held. */
  _lock?: (key: number) => Promise<void>
  /** Release a held lock. */
  _unlock?: (key: number) => Promise<void>
  /** Override the key derivation (tests). */
  _hashKey?: (workspaceId: string) => number
  /** Log tag. */
  logTag?: string
}

async function defaultTryLock(key: number): Promise<boolean> {
  const { prisma } = await import('../prisma')
  // pg_try_advisory_lock returns a scalar boolean — use $queryRawUnsafe.
  const rows = await prisma.$queryRawUnsafe<{ acquired: boolean }[]>(
    `SELECT pg_try_advisory_lock($1) AS acquired`,
    key,
  )
  return rows[0]?.acquired === true
}

async function defaultLock(key: number): Promise<void> {
  const { prisma } = await import('../prisma')
  // pg_advisory_lock returns void — must use $executeRawUnsafe (Prisma can't
  // deserialize a void column via $queryRawUnsafe).
  await prisma.$executeRawUnsafe(`SELECT pg_advisory_lock($1)`, key)
}

async function defaultUnlock(key: number): Promise<void> {
  const { prisma } = await import('../prisma')
  await prisma.$executeRawUnsafe(`SELECT pg_advisory_unlock($1)`, key)
}

/**
 * Run `fn` while holding the workspace spawn lease. Serializes concurrent
 * spawns of the same workspace across API replicas. `fn` should itself be
 * idempotent / short-circuit when the runtime is already up — the lease
 * guarantees ordering, not that work is skipped.
 */
export async function withWorkspaceSpawnLease<T>(
  workspaceId: string,
  fn: () => Promise<T>,
  seams: WorkspaceSpawnLeaseSeams = {},
): Promise<T> {
  if (!workspaceId) {
    throw new Error('[WorkspaceSpawnLease] workspaceId is required')
  }
  const tag = seams.logTag ?? 'WorkspaceSpawnLease'
  const hashKey = seams._hashKey ?? hashWorkspaceIdToLockKey
  const tryLock = seams._tryLock ?? defaultTryLock
  const lock = seams._lock ?? defaultLock
  const unlock = seams._unlock ?? defaultUnlock

  const key = hashKey(workspaceId)

  let held = false
  const acquired = await tryLock(key)
  if (acquired) {
    held = true
  } else {
    // Another replica is spawning this workspace. Block until it releases,
    // then proceed — fn() short-circuits if the runtime came up meanwhile.
    console.log(`[${tag}] spawn lease contended for ${workspaceId} — waiting for the active replica`)
    await lock(key)
    held = true
  }

  try {
    return await fn()
  } finally {
    if (held) {
      try {
        await unlock(key)
      } catch (err: any) {
        // A failed unlock is non-fatal: advisory locks auto-release when the
        // session ends. Log and move on rather than masking fn()'s result.
        console.warn(`[${tag}] failed to release spawn lease for ${workspaceId}: ${err?.message ?? err}`)
      }
    }
  }
}
