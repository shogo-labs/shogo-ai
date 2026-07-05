// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { Semaphore, Singleflight } from './concurrency'

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

describe('Singleflight', () => {
  test('collapses concurrent calls for the same key into one run', async () => {
    const sf = new Singleflight<number>()
    let runs = 0
    const fn = async () => {
      runs++
      await tick()
      return 42
    }
    const [a, b, c] = await Promise.all([sf.run('k', fn), sf.run('k', fn), sf.run('k', fn)])
    expect(runs).toBe(1)
    expect([a, b, c]).toEqual([42, 42, 42])
    expect(sf.has('k')).toBe(false) // cleared after completion
  })

  test('different keys run independently', async () => {
    const sf = new Singleflight<string>()
    let runs = 0
    const fn = (v: string) => async () => {
      runs++
      await tick()
      return v
    }
    const [a, b] = await Promise.all([sf.run('a', fn('a')), sf.run('b', fn('b'))])
    expect(runs).toBe(2)
    expect([a, b]).toEqual(['a', 'b'])
  })

  test('clears the key even when the op throws', async () => {
    const sf = new Singleflight<void>()
    await expect(sf.run('k', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(sf.has('k')).toBe(false)
  })
})

describe('Semaphore', () => {
  test('never exceeds the configured concurrency', async () => {
    const sem = new Semaphore(2)
    let active = 0
    let peak = 0
    const job = async () => {
      await sem.run(async () => {
        active++
        peak = Math.max(peak, active)
        await tick(10)
        active--
      })
    }
    await Promise.all(Array.from({ length: 8 }, job))
    expect(peak).toBeLessThanOrEqual(2)
  })

  test('releases a permit even when the job throws', async () => {
    const sem = new Semaphore(1)
    await expect(sem.run(async () => { throw new Error('x') })).rejects.toThrow('x')
    // If the permit leaked this would deadlock; a resolved value proves release.
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok')
  })
})
