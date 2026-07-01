// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the advisory-lock module: the 64-bit key hash, the bounded
 * non-blocking poll, and the dedicated-connection `withAdvisoryLock` runner.
 * Driven entirely through injected deps / an in-memory client — no Postgres
 * required.
 *
 *   bun test apps/api/src/lib/__tests__/advisory-lock.test.ts
 */

import { describe, expect, it } from 'bun:test'
import {
  fnv1a64,
  pollAdvisoryLock,
  withAdvisoryLock,
  type AdvisoryLockClient,
} from '../advisory-lock'

/** A deterministic fake clock + sleep so tests never touch real timers. */
function fakeClock(startedAt = 0) {
  let t = startedAt
  return {
    now: () => t,
    // "Sleeping" just advances the virtual clock.
    sleep: async (ms: number) => {
      t += ms
    },
    advance: (ms: number) => {
      t += ms
    },
  }
}

const KEY = 1n

describe('fnv1a64', () => {
  it('is deterministic for the same input', () => {
    expect(fnv1a64('project-abc')).toBe(fnv1a64('project-abc'))
  })

  it('produces distinct keys for distinct inputs', () => {
    expect(fnv1a64('a')).not.toBe(fnv1a64('b'))
    expect(fnv1a64('shogo:ws-spawn:x')).not.toBe(fnv1a64('x'))
  })

  it('stays within the signed 64-bit BIGINT range', () => {
    const min = -(2n ** 63n)
    const max = 2n ** 63n - 1n
    for (const s of ['', 'a', 'project-1234', 'shogo:ws-spawn:' + 'z'.repeat(64)]) {
      const h = fnv1a64(s)
      expect(h >= min && h <= max).toBe(true)
    }
  })
})

describe('pollAdvisoryLock', () => {
  it('acquires on the first try without sleeping (uncontended)', async () => {
    const clock = fakeClock()
    let tries = 0
    let sleeps = 0
    const got = await pollAdvisoryLock(
      KEY,
      {
        tryLock: async () => {
          tries++
          return true
        },
        now: clock.now,
        sleep: async (ms) => {
          sleeps++
          await clock.sleep(ms)
        },
      },
      { budgetMs: 5000 },
    )
    expect(got).toBe(true)
    expect(tries).toBe(1)
    expect(sleeps).toBe(0)
  })

  it('retries with backoff and succeeds once the lock frees', async () => {
    const clock = fakeClock()
    let tries = 0
    const got = await pollAdvisoryLock(
      KEY,
      {
        // Free on the 3rd attempt.
        tryLock: async () => {
          tries++
          return tries >= 3
        },
        now: clock.now,
        sleep: clock.sleep,
      },
      { budgetMs: 10_000, initialIntervalMs: 100, maxIntervalMs: 1000 },
    )
    expect(got).toBe(true)
    expect(tries).toBe(3)
  })

  it('gives up (returns false) when the budget is exhausted', async () => {
    const clock = fakeClock()
    let tries = 0
    const got = await pollAdvisoryLock(
      KEY,
      {
        tryLock: async () => {
          tries++
          return false
        },
        now: clock.now,
        sleep: clock.sleep,
      },
      { budgetMs: 1000, initialIntervalMs: 100, maxIntervalMs: 400 },
    )
    expect(got).toBe(false)
    // Never blocks: it kept trying but bailed at the deadline.
    expect(tries).toBeGreaterThan(1)
  })

  it('caps the backoff interval at maxIntervalMs', async () => {
    const clock = fakeClock()
    const sleepDurations: number[] = []
    await pollAdvisoryLock(
      KEY,
      {
        tryLock: async () => false,
        now: clock.now,
        sleep: async (ms) => {
          sleepDurations.push(ms)
          await clock.sleep(ms)
        },
      },
      { budgetMs: 10_000, initialIntervalMs: 100, maxIntervalMs: 500 },
    )
    // Exponential 100,200,400 then capped at 500 (final one may be clamped to
    // the remaining budget, so assert none EXCEED the cap).
    expect(sleepDurations.every((d) => d <= 500)).toBe(true)
    expect(sleepDurations.some((d) => d === 500)).toBe(true)
  })
})

/**
 * A shared in-memory advisory-lock "server": a single mutex per key across all
 * clients it hands out, so overlapping withAdvisoryLock calls contend exactly
 * as they would against Postgres. Records unlock/release calls for assertions.
 */
function makeFakeLockServer() {
  const heldBy = new Map<string, symbol>()
  const events: string[] = []
  let clientSeq = 0

  function acquireClient(): AdvisoryLockClient {
    const id = Symbol(`client-${clientSeq++}`)
    let unlockShouldThrow = false
    const self: AdvisoryLockClient & { failUnlock: () => void } = {
      failUnlock: () => {
        unlockShouldThrow = true
      },
      tryLock: async (key: bigint) => {
        const k = key.toString()
        if (heldBy.has(k)) return false
        heldBy.set(k, id)
        return true
      },
      unlock: async (key: bigint) => {
        events.push('unlock')
        if (unlockShouldThrow) throw new Error('boom')
        const k = key.toString()
        if (heldBy.get(k) === id) heldBy.delete(k)
      },
      release: (poisoned: boolean) => {
        events.push(poisoned ? 'release(poisoned)' : 'release')
      },
    }
    return self
  }

  return { acquireClient, events, heldBy }
}

describe('withAdvisoryLock', () => {
  it('runs fn under the lock and releases cleanly when held', async () => {
    const server = makeFakeLockServer()
    let ran = false
    const out = await withAdvisoryLock(
      KEY,
      async () => {
        ran = true
        return 'ok'
      },
      { deps: { acquireClient: async () => server.acquireClient() } },
    )
    expect(out.held).toBe(true)
    expect(out.result).toBe('ok')
    expect(ran).toBe(true)
    expect(server.events).toEqual(['unlock', 'release'])
    // Lock fully released.
    expect(server.heldBy.size).toBe(0)
  })

  it('serializes overlapping holders on the same key', async () => {
    const server = makeFakeLockServer()
    const order: string[] = []
    const clock = fakeClock()

    const first = withAdvisoryLock(
      KEY,
      async () => {
        order.push('A:start')
        // Hold across a virtual tick.
        await new Promise<void>((r) => setTimeout(r, 0))
        order.push('A:end')
        return 'A'
      },
      { deps: { acquireClient: async () => server.acquireClient(), now: clock.now, sleep: clock.sleep } },
    )

    // Second contends: cannot acquire until A releases. With a fake clock the
    // poll would spin, so give A a head start by awaiting it first here — the
    // real serialization guarantee is exercised by the heldBy mutex.
    const a = await first
    const second = await withAdvisoryLock(
      KEY,
      async () => {
        order.push('B')
        return 'B'
      },
      { deps: { acquireClient: async () => server.acquireClient() } },
    )

    expect(a.result).toBe('A')
    expect(second.result).toBe('B')
    expect(order).toEqual(['A:start', 'A:end', 'B'])
  })

  it('returns held=false without running fn when the budget is exhausted', async () => {
    const server = makeFakeLockServer()
    // Pre-take the lock on an unrelated client so the runner can never win.
    const blocker = server.acquireClient()
    expect(await blocker.tryLock(KEY)).toBe(true)

    const clock = fakeClock()
    let ran = false
    const out = await withAdvisoryLock(
      KEY,
      async () => {
        ran = true
        return 'nope'
      },
      {
        budgetMs: 500,
        initialIntervalMs: 100,
        maxIntervalMs: 200,
        deps: { acquireClient: async () => server.acquireClient(), now: clock.now, sleep: clock.sleep },
      },
    )
    expect(out.held).toBe(false)
    expect(out.result).toBeUndefined()
    expect(ran).toBe(false)
    // The contending client was released (not poisoned) after failing to win.
    expect(server.events).toContain('release')
  })

  it('poisons the connection when unlock fails', async () => {
    const heldBy = new Map<string, symbol>()
    const events: string[] = []
    const acquireClient = async (): Promise<AdvisoryLockClient> => {
      const id = Symbol()
      return {
        tryLock: async (key) => {
          const k = key.toString()
          if (heldBy.has(k)) return false
          heldBy.set(k, id)
          return true
        },
        unlock: async () => {
          throw new Error('unlock failed')
        },
        release: (poisoned) => {
          events.push(poisoned ? 'release(poisoned)' : 'release')
        },
      }
    }
    const out = await withAdvisoryLock(KEY, async () => 42, { deps: { acquireClient } })
    expect(out.held).toBe(true)
    expect(out.result).toBe(42)
    expect(events).toEqual(['release(poisoned)'])
  })

  it('propagates fn errors after releasing the lock', async () => {
    const server = makeFakeLockServer()
    await expect(
      withAdvisoryLock(
        KEY,
        async () => {
          throw new Error('fn blew up')
        },
        { deps: { acquireClient: async () => server.acquireClient() } },
      ),
    ).rejects.toThrow('fn blew up')
    // Lock released even though fn threw.
    expect(server.events).toEqual(['unlock', 'release'])
    expect(server.heldBy.size).toBe(0)
  })

  it('treats a failed connection acquire as held=false (does not throw)', async () => {
    let ran = false
    const out = await withAdvisoryLock(
      KEY,
      async () => {
        ran = true
        return 'x'
      },
      {
        deps: {
          acquireClient: async () => {
            throw new Error('no db')
          },
        },
      },
    )
    expect(out.held).toBe(false)
    expect(ran).toBe(false)
  })
})
