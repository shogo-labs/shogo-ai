// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the cross-replica workspace spawn lease. Driven entirely
 * through injection seams — no Postgres required.
 *
 *   bun test apps/api/src/lib/runtime/__tests__/workspace-spawn-lease.test.ts
 */

import { describe, expect, it } from 'bun:test'
import {
  hashWorkspaceIdToLockKey,
  withWorkspaceSpawnLease,
} from '../workspace-spawn-lease'

describe('hashWorkspaceIdToLockKey', () => {
  it('is deterministic', () => {
    expect(hashWorkspaceIdToLockKey('ws-1')).toBe(hashWorkspaceIdToLockKey('ws-1'))
  })

  it('differs for different workspace ids', () => {
    expect(hashWorkspaceIdToLockKey('ws-1')).not.toBe(hashWorkspaceIdToLockKey('ws-2'))
  })

  it('returns a 32-bit signed integer', () => {
    const k = hashWorkspaceIdToLockKey('00000000-0000-0000-0000-000000000000')
    expect(Number.isInteger(k)).toBe(true)
    expect(k).toBeGreaterThanOrEqual(-(2 ** 31))
    expect(k).toBeLessThan(2 ** 31)
  })

  it('is namespaced away from the raw-id keyspace (project locks hash the raw id)', () => {
    // The project path hashes the raw id; ours folds in a namespace prefix,
    // so the same id must map to a different key than a raw FNV-1a hash.
    function rawFnv(input: string): number {
      let hash = 0x811c9dc5
      for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i)
        hash = (hash * 0x01000193) | 0
      }
      return hash
    }
    const id = 'shared-uuid'
    expect(hashWorkspaceIdToLockKey(id)).not.toBe(rawFnv(id))
  })
})

/** Deterministic fake clock so poll tests never touch real timers. */
function fakeClock(startedAt = 0) {
  let t = startedAt
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
  }
}

describe('withWorkspaceSpawnLease', () => {
  it('runs fn while holding the lock and releases after (uncontended path)', async () => {
    const order: string[] = []
    const result = await withWorkspaceSpawnLease(
      'ws-1',
      async () => {
        order.push('fn')
        return 42
      },
      {
        _tryLock: async () => {
          order.push('tryLock')
          return true
        },
        _unlock: async () => {
          order.push('unlock')
        },
      },
    )
    expect(result).toBe(42)
    expect(order).toEqual(['tryLock', 'fn', 'unlock'])
  })

  it('polls (non-blocking) when contended and runs fn once the lease frees', async () => {
    const clock = fakeClock()
    let tries = 0
    const order: string[] = []
    await withWorkspaceSpawnLease('ws-1', async () => { order.push('fn') }, {
      // Free on the 3rd attempt.
      _tryLock: async () => {
        tries++
        order.push(`try(${tries >= 3})`)
        return tries >= 3
      },
      _unlock: async () => {
        order.push('unlock')
      },
      _sleep: clock.sleep,
      _now: clock.now,
      _budgetMs: 10_000,
    })
    // First try (orchestration) false, poll tries again false, then true.
    expect(order).toEqual(['try(false)', 'try(false)', 'try(true)', 'fn', 'unlock'])
  })

  it('proceeds WITHOUT the lease when the poll budget is exhausted (fn self-guards)', async () => {
    const clock = fakeClock()
    let ran = false
    let unlockCalls = 0
    const result = await withWorkspaceSpawnLease('ws-1', async () => {
      ran = true
      return 'ran-unserialized'
    }, {
      _tryLock: async () => false, // never free
      _unlock: async () => {
        unlockCalls++
      },
      _sleep: clock.sleep,
      _now: clock.now,
      _budgetMs: 1_000,
    })
    expect(ran).toBe(true)
    expect(result).toBe('ran-unserialized')
    // Never held the lease → must not release it.
    expect(unlockCalls).toBe(0)
  })

  it('releases the lock even when fn throws', async () => {
    let unlocked = false
    await expect(
      withWorkspaceSpawnLease('ws-1', async () => {
        throw new Error('spawn boom')
      }, {
        _tryLock: async () => true,
        _unlock: async () => {
          unlocked = true
        },
      }),
    ).rejects.toThrow('spawn boom')
    expect(unlocked).toBe(true)
  })

  it('swallows a failed unlock (advisory locks auto-release on session end)', async () => {
    const result = await withWorkspaceSpawnLease('ws-1', async () => 'ok', {
      _tryLock: async () => true,
      _unlock: async () => {
        throw new Error('unlock failed')
      },
    })
    expect(result).toBe('ok')
  })

  it('serializes two overlapping leases on the same workspace', async () => {
    // Model a single advisory lock with a tiny in-memory mutex: tryLock
    // succeeds only when free. The loser polls (real short timers) until the
    // winner releases.
    let locked = false
    const seams = {
      _tryLock: async (_k: number) => {
        if (locked) return false
        locked = true
        return true
      },
      _unlock: async (_k: number) => {
        locked = false
      },
      _budgetMs: 2_000,
    }

    const events: string[] = []
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
})
