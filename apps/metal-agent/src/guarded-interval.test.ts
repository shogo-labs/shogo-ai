// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * `guardedInterval` — periodic sweeps must never overlap themselves.
 *
 * Regression: the idle reaper ran on a bare `setInterval(…, 15s)` while a pass
 * over a ~130-VM host took far longer (each suspend does two S3 backups, a guest
 * quiesce and a Firecracker snapshot). Stacked passes each built their own stale
 * list from the same map and collided on the same projects, so production logged
 * ~880 `project … not assigned` errors per host in 45 minutes and burned
 * duplicate S3 uploads, while no pass lived long enough to log its result.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { guardedInterval } from './guarded-interval'

/** Collects log output so the assertions can read it instead of the console. */
function fakeLog() {
  const warns: string[] = []
  const errors: string[] = []
  return {
    warns,
    errors,
    warn: (msg: string) => warns.push(msg),
    error: (msg: string, detail?: unknown) => errors.push(`${msg} ${detail ?? ''}`.trim()),
  }
}

/** Deferred promise so a test can hold a pass open for as long as it likes. */
function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const TICK_MS = 5
/** Long enough for `n` timer ticks to have fired. */
const ticks = (n: number) => new Promise((r) => setTimeout(r, TICK_MS * n + TICK_MS * 2))

describe('guardedInterval', () => {
  let stop: (() => void) | null = null
  beforeEach(() => {
    stop = null
  })
  afterEach(() => stop?.())

  test('drops ticks that land while a pass is still running', async () => {
    const log = fakeLog()
    const gate = deferred()
    let started = 0

    const g = guardedInterval('test sweep', TICK_MS, () => {
      started++
      return gate.promise
    }, log)
    stop = g.stop

    // Several intervals elapse while the first pass is deliberately stuck.
    await ticks(4)

    expect(started).toBe(1)
    expect(g.running).toBe(true)
    expect(g.skipped).toBeGreaterThan(0)
    expect(log.warns[0]).toContain('test sweep still running from the previous tick')

    // Once it finishes, the timer is free to run again.
    gate.resolve()
    await ticks(2)
    expect(started).toBeGreaterThan(1)
    expect(g.running).toBe(false)
  })

  test('runs consecutive passes when each finishes inside the interval', async () => {
    const log = fakeLog()
    let started = 0
    const g = guardedInterval('fast sweep', TICK_MS, async () => {
      started++
    }, log)
    stop = g.stop

    await ticks(3)

    expect(started).toBeGreaterThan(1)
    expect(g.skipped).toBe(0)
    expect(log.warns).toEqual([])
  })

  test('a rejected pass is logged and does not wedge the sweep', async () => {
    const log = fakeLog()
    let started = 0
    const g = guardedInterval('flaky sweep', TICK_MS, async () => {
      started++
      throw new Error('boom')
    }, log)
    stop = g.stop

    await ticks(3)

    // The flag was cleared despite the rejection, so later ticks still fire.
    expect(started).toBeGreaterThan(1)
    expect(g.running).toBe(false)
    expect(log.errors.some((e) => e.includes('flaky sweep error') && e.includes('boom'))).toBe(true)
  })

  test('a synchronously-throwing task does not wedge the sweep either', async () => {
    const log = fakeLog()
    let started = 0
    const g = guardedInterval('throwing sweep', TICK_MS, () => {
      started++
      throw new Error('sync boom')
    }, log)
    stop = g.stop

    await ticks(3)

    expect(started).toBeGreaterThan(1)
    expect(g.running).toBe(false)
    expect(log.errors.some((e) => e.includes('sync boom'))).toBe(true)
  })

  test('stop() halts further passes', async () => {
    const log = fakeLog()
    let started = 0
    const g = guardedInterval('stopped sweep', TICK_MS, async () => {
      started++
    }, log)
    stop = g.stop

    await ticks(2)
    const afterFirstWait = started
    expect(afterFirstWait).toBeGreaterThan(0)

    g.stop()
    await ticks(3)
    expect(started).toBe(afterFirstWait)
  })
})
