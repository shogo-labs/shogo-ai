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
 * Design mirrors the project path deliberately so the two stay in lockstep
 * (see `knative-project-manager.ts:tryClaimWarmPod` and `advisory-lock.ts`):
 *   - The lease is a per-workspace advisory lock taken on a DEDICATED
 *     connection (bypasses PgBouncer / the Prisma pool) with a bounded,
 *     NON-BLOCKING wait (poll `pg_try_advisory_lock` with capped backoff).
 *   - `fn` runs inside the lock body so acquire+release land on the same
 *     backend session — required for session-scoped locks under transaction
 *     pooling. `fn` is expected to short-circuit when it observes the runtime
 *     is already up (the resolver re-checks service existence).
 *   - If the lock can't be won within the budget we run `fn()` WITHOUT the
 *     lease rather than block: `fn` self-guards, so an un-serialized run is at
 *     worst a redundant no-op.
 *
 * We deliberately NEVER issue a blocking `pg_advisory_lock`: a blocked waiter
 * would hold its connection for the entire wait, and under contention that
 * pinned the pool until ordinary queries could not get a connection (the
 * 2026-07-01 ap-mumbai-1 outage).
 *
 * HOST / desktop mode is single-process and SQLite-backed (no
 * `pg_advisory_lock`), so the resolver does NOT take this lease there — the
 * in-process `startingPromises` dedup in `RuntimeManager.startWorkspace` is
 * sufficient. This module is only invoked on the cloud (k8s/vm) branches.
 *
 * The lock runner is behind an injection seam so the orchestration is
 * unit-testable without a database.
 */

import { fnv1a64, withAdvisoryLock, type WithAdvisoryLockResult } from '../advisory-lock'

/**
 * Namespace prefix folded into the hash so workspace lock keys never collide
 * with the project lock keyspace (`hashProjectIdToLockKey` hashes the raw
 * project id). A workspace and a project could in principle share a UUID
 * across tables; prefixing guarantees disjoint advisory-lock keys.
 */
const WORKSPACE_LOCK_NAMESPACE = 'shogo:ws-spawn:'

/**
 * Deterministic 64-bit FNV-1a hash of `ws-spawn:<workspaceId>` for use as a
 * PostgreSQL advisory-lock key (signed BIGINT). Same helper as the project
 * path so the algorithm is consistent across the codebase.
 */
export function hashWorkspaceIdToLockKey(workspaceId: string): bigint {
  return fnv1a64(WORKSPACE_LOCK_NAMESPACE + workspaceId)
}

/**
 * How long we poll (non-blocking) for the spawn lease before proceeding
 * without it. Generous because a real spawn can take tens of seconds and we
 * want the loser to wait for the winner in the common case — but the wait
 * never pins a pooled connection, so a large budget costs latency, not
 * connections.
 */
const SPAWN_LEASE_WAIT_BUDGET_MS = 60_000

export interface WorkspaceSpawnLeaseSeams {
  /**
   * Override the dedicated-connection lock runner. Defaults to
   * `withAdvisoryLock`. Tests inject an in-memory implementation.
   */
  _withAdvisoryLock?: <T>(
    key: bigint,
    fn: () => Promise<T>,
    opts: { budgetMs?: number },
  ) => Promise<WithAdvisoryLockResult<T>>
  /** Override the key derivation (tests). */
  _hashKey?: (workspaceId: string) => bigint
  /** Total non-blocking poll budget before proceeding without the lease. */
  _budgetMs?: number
  /** Log tag. */
  logTag?: string
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
  const runWithLock = seams._withAdvisoryLock ?? withAdvisoryLock
  const budgetMs = seams._budgetMs ?? SPAWN_LEASE_WAIT_BUDGET_MS

  const key = hashKey(workspaceId)

  // Acquire on a dedicated connection and run fn under the lock. If the lock
  // is contended, withAdvisoryLock polls (non-blocking) up to budgetMs. When
  // held, fn ran exactly once (its errors propagate). When not held, fn did
  // NOT run — proceed without the lease (fn self-guards).
  const outcome = await runWithLock<T>(key, fn, { budgetMs })
  if (outcome.held) {
    return outcome.result as T
  }

  console.warn(`[${tag}] could not acquire spawn lease for ${workspaceId} within ${budgetMs}ms — proceeding without it (fn must self-guard)`)
  return fn()
}
