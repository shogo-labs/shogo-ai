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
        _lock: async () => {
          order.push('lock(blocking)')
        },
        _unlock: async () => {
          order.push('unlock')
        },
      },
    )
    expect(result).toBe(42)
    expect(order).toEqual(['tryLock', 'fn', 'unlock'])
  })

  it('blocks on the lock when the non-blocking try is contended', async () => {
    const order: string[] = []
    await withWorkspaceSpawnLease('ws-1', async () => { order.push('fn') }, {
      _tryLock: async () => {
        order.push('tryLock(false)')
        return false
      },
      _lock: async () => {
        order.push('lock(blocking)')
      },
      _unlock: async () => {
        order.push('unlock')
      },
    })
    expect(order).toEqual(['tryLock(false)', 'lock(blocking)', 'fn', 'unlock'])
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

  it('does not unlock if the lock was never acquired (lock throws)', async () => {
    let unlockCalls = 0
    await expect(
      withWorkspaceSpawnLease('ws-1', async () => 'never', {
        _tryLock: async () => false,
        _lock: async () => {
          throw new Error('db down')
        },
        _unlock: async () => {
          unlockCalls++
        },
      }),
    ).rejects.toThrow('db down')
    expect(unlockCalls).toBe(0)
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
    // succeeds only when free; lock() waits for release.
    let locked = false
    const waiters: Array<() => void> = []
    const seams = {
      _tryLock: async (_k: number) => {
        if (locked) return false
        locked = true
        return true
      },
      _lock: async (_k: number) => {
        if (!locked) {
          locked = true
          return
        }
        await new Promise<void>((resolve) => waiters.push(resolve))
        locked = true
      },
      _unlock: async (_k: number) => {
        locked = false
        const next = waiters.shift()
        if (next) next()
      },
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
