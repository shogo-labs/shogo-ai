// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the cross-replica workspace spawn lease. Driven entirely
 * through the injectable lock runner — no Postgres required.
 *
 *   bun test apps/api/src/lib/runtime/__tests__/workspace-spawn-lease.test.ts
 */

import { describe, expect, it } from 'bun:test'
import {
  hashWorkspaceIdToLockKey,
  withWorkspaceSpawnLease,
} from '../workspace-spawn-lease'
import { fnv1a64, type WithAdvisoryLockResult } from '../../advisory-lock'

describe('hashWorkspaceIdToLockKey', () => {
  it('is deterministic', () => {
    expect(hashWorkspaceIdToLockKey('ws-1')).toBe(hashWorkspaceIdToLockKey('ws-1'))
  })

  it('differs for different workspace ids', () => {
    expect(hashWorkspaceIdToLockKey('ws-1')).not.toBe(hashWorkspaceIdToLockKey('ws-2'))
  })

  it('returns a signed 64-bit BIGINT', () => {
    const k = hashWorkspaceIdToLockKey('00000000-0000-0000-0000-000000000000')
    expect(typeof k).toBe('bigint')
    expect(k >= -(2n ** 63n) && k <= 2n ** 63n - 1n).toBe(true)
  })

  it('is namespaced away from the raw-id keyspace (project locks hash the raw id)', () => {
    // The project path hashes the raw id; ours folds in a namespace prefix,
    // so the same id must map to a different key than a raw fnv1a64 hash.
    const id = 'shared-uuid'
    expect(hashWorkspaceIdToLockKey(id)).not.toBe(fnv1a64(id))
  })
})

/**
 * A fake `withAdvisoryLock` backed by a single in-memory mutex per key, so
 * overlapping leases contend exactly as they would against a real lock.
 */
function makeFakeLockRunner(opts: { budgetMs?: number } = {}) {
  const heldKeys = new Set<string>()
  const budgetMs = opts.budgetMs ?? 2_000

  async function run<T>(
    key: bigint,
    fn: () => Promise<T>,
    o: { budgetMs?: number } = {},
  ): Promise<WithAdvisoryLockResult<T>> {
    const k = key.toString()
    const deadline = Date.now() + (o.budgetMs ?? budgetMs)
    // Poll (non-blocking) for the mutex.
    while (heldKeys.has(k)) {
      if (Date.now() >= deadline) return { held: false }
      await new Promise((r) => setTimeout(r, 1))
    }
    heldKeys.add(k)
    try {
      const result = await fn()
      return { held: true, result }
    } finally {
      heldKeys.delete(k)
    }
  }

  return { run, heldKeys }
}

describe('withWorkspaceSpawnLease', () => {
  it('runs fn while holding the lock (uncontended path)', async () => {
    const order: string[] = []
    const runner = makeFakeLockRunner()
    const result = await withWorkspaceSpawnLease(
      'ws-1',
      async () => {
        order.push('fn')
        return 42
      },
      {
        _withAdvisoryLock: async (key, fn, o) => {
          order.push('lock')
          return runner.run(key, fn, o)
        },
      },
    )
    expect(result).toBe(42)
    expect(order).toEqual(['lock', 'fn'])
    // Lock released after fn.
    expect(runner.heldKeys.size).toBe(0)
  })

  it('proceeds WITHOUT the lease when the lock cannot be acquired (fn self-guards)', async () => {
    let ran = false
    const result = await withWorkspaceSpawnLease(
      'ws-1',
      async () => {
        ran = true
        return 'ran-unserialized'
      },
      {
        // Simulate budget exhaustion: never held, fn NOT run by the runner.
        _withAdvisoryLock: async () => ({ held: false }),
      },
    )
    expect(ran).toBe(true)
    expect(result).toBe('ran-unserialized')
  })

  it('does not run fn twice when held', async () => {
    let runs = 0
    const runner = makeFakeLockRunner()
    await withWorkspaceSpawnLease(
      'ws-1',
      async () => {
        runs++
      },
      { _withAdvisoryLock: runner.run },
    )
    expect(runs).toBe(1)
  })

  it('propagates fn errors (lock runner released the lock)', async () => {
    const runner = makeFakeLockRunner()
    await expect(
      withWorkspaceSpawnLease(
        'ws-1',
        async () => {
          throw new Error('spawn boom')
        },
        { _withAdvisoryLock: runner.run },
      ),
    ).rejects.toThrow('spawn boom')
    expect(runner.heldKeys.size).toBe(0)
  })

  it('serializes two overlapping leases on the same workspace', async () => {
    const runner = makeFakeLockRunner({ budgetMs: 5_000 })
    const events: string[] = []
    const seams = { _withAdvisoryLock: runner.run }

    const a = withWorkspaceSpawnLease('ws-1', async () => {
      events.push('A:start')
      await new Promise((r) => setTimeout(r, 20))
      events.push('A:end')
    }, seams)
    // Ensure A grabs the lock first.
    await new Promise((r) => setTimeout(r, 5))
    const b = withWorkspaceSpawnLease('ws-1', async () => {
      events.push('B:start')
      events.push('B:end')
    }, seams)

    await Promise.all([a, b])
    // B must not start until A has finished and released.
    expect(events).toEqual(['A:start', 'A:end', 'B:start', 'B:end'])
  })

  it('leases on different workspaces do not block each other', async () => {
    const runner = makeFakeLockRunner()
    const events: string[] = []
    const seams = { _withAdvisoryLock: runner.run }

    const a = withWorkspaceSpawnLease('ws-A', async () => {
      events.push('A:start')
      await new Promise((r) => setTimeout(r, 20))
      events.push('A:end')
    }, seams)
    await new Promise((r) => setTimeout(r, 5))
    const b = withWorkspaceSpawnLease('ws-B', async () => {
      events.push('B:start')
      events.push('B:end')
    }, seams)

    await Promise.all([a, b])
    // Different keys → B runs while A is still holding its own key.
    expect(events).toEqual(['A:start', 'B:start', 'B:end', 'A:end'])
  })
})
