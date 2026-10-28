// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-181 AC3 — the update banner's restart gate.
 *
 * The bug the card fixes: the banner's Restart button called `quitAndInstall()`
 * immediately, so every live agent run died with no warning and no alternative.
 * The gate now has three answers — restart now, restart when idle, cancel — and
 * these cases drive the real loop with a fake activity source, a fake clock and
 * a fake quit, so what is asserted is *when* the restart fires:
 *
 *  - with nothing live it fires on the first poll;
 *  - with work live it does not fire until the counts have been zero for the
 *    quiet window, and never while a run is still going;
 *  - a quiet window that keeps restarting (a chained wake) resets the clock;
 *  - cancel lifts the drain and never restarts.
 */
import { describe, expect, it } from 'bun:test'
import { IdleRestart } from '../restart-when-idle'
import type { LiveActivity } from '../live-activity'

interface Harness {
  restart: IdleRestart
  quits: number[]
  drainCalls: boolean[]
  progress: Array<LiveActivity | null>
  /** Run every scheduled callback once, advancing the fake clock. */
  advance: (ms?: number) => Promise<void>
  /** When the loop is done scheduling. */
  idle: () => boolean
  setActivity: (activity: LiveActivity | null) => void
  now: () => number
}

function harness(initial: LiveActivity | null = { liveTurns: 0, runningTasks: 0, runningAgentReplies: 0 }): Harness {
  let activity = initial
  let clock = 1_000_000
  const quits: number[] = []
  const drainCalls: boolean[] = []
  const progress: Array<LiveActivity | null> = []
  let pending: Array<{ fn: () => void; at: number }> = []

  const restart = new IdleRestart({
    readActivity: async () => activity,
    setDrain: async (on) => {
      drainCalls.push(on)
      return true
    },
    quit: () => {
      quits.push(clock)
    },
    onProgress: (value) => progress.push(value),
    pollIntervalMs: 5_000,
    quietForMs: 10_000,
    now: () => clock,
    schedule: (fn, ms) => {
      const handle = { fn, at: clock + ms }
      pending.push(handle)
      return handle
    },
    cancel: (handle) => {
      pending = pending.filter((entry) => entry !== handle)
    },
    log: () => {},
  })

  return {
    restart,
    quits,
    drainCalls,
    progress,
    async advance(ms = 5_000) {
      clock += ms
      const due = pending.filter((entry) => entry.at <= clock)
      pending = pending.filter((entry) => entry.at > clock)
      for (const entry of due) entry.fn()
      // Settle the promise chain started by the poll.
      for (let i = 0; i < 8; i += 1) await Promise.resolve()
    },
    idle: () => pending.length === 0,
    setActivity: (value) => {
      activity = value
    },
    now: () => clock,
  }
}

const IDLE: LiveActivity = { liveTurns: 0, runningTasks: 0, runningAgentReplies: 0 }
const ONE_TURN: LiveActivity = { liveTurns: 1, runningTasks: 0, runningAgentReplies: 0 }

describe('restart when idle', () => {
  it('turns the drain on and restarts once nothing is running', async () => {
    const h = harness(IDLE)
    const started = await h.restart.start()
    expect(started.ok).toBe(true)
    expect(h.drainCalls).toEqual([true])

    await h.advance(5_000)
    expect(h.quits).toHaveLength(0)

    // The counts have been zero since the first read: 10s of quiet.
    await h.advance(5_000)
    expect(h.quits).toHaveLength(1)
    expect(h.restart.isWaiting).toBe(false)
    expect(h.idle()).toBe(true)
  })

  it('waits while a run is live and never restarts under it', async () => {
    const h = harness(ONE_TURN)
    await h.restart.start()

    for (let i = 0; i < 12; i += 1) await h.advance(5_000)
    expect(h.quits).toHaveLength(0)
    expect(h.restart.isWaiting).toBe(true)
    expect(h.progress.at(-1)).toEqual(ONE_TURN)
  })

  it('restarts only after a full quiet window once the work finishes', async () => {
    const h = harness(ONE_TURN)
    await h.restart.start()

    await h.advance(5_000)
    expect(h.quits).toHaveLength(0)

    // The run finishes between polls.
    h.setActivity(IDLE)
    await h.advance(5_000) // first zero reading starts the window
    await h.advance(5_000)
    expect(h.quits).toHaveLength(0)
    await h.advance(5_000) // 10s of quiet
    expect(h.quits).toHaveLength(1)
  })

  it('a wake that starts a new run inside the quiet window resets it', async () => {
    const h = harness(IDLE)
    await h.restart.start()

    await h.advance(5_000) // zero
    h.setActivity({ liveTurns: 0, runningTasks: 1, runningAgentReplies: 0 })
    await h.advance(5_000) // a task started: window cleared
    h.setActivity(IDLE)
    await h.advance(5_000) // window starts again
    await h.advance(5_000)
    expect(h.quits).toHaveLength(0)
    await h.advance(5_000)
    expect(h.quits).toHaveLength(1)
  })

  it('restarts when the API cannot answer, rather than blocking the update', async () => {
    const h = harness(null)
    await h.restart.start()
    await h.advance(5_000)
    await h.advance(5_000)
    await h.advance(5_000)
    expect(h.quits).toHaveLength(1)
  })

  it('cancel lifts the drain and never restarts', async () => {
    const h = harness(ONE_TURN)
    await h.restart.start()
    await h.advance(5_000)

    await h.restart.cancel()
    expect(h.drainCalls).toEqual([true, false])
    expect(h.restart.isWaiting).toBe(false)

    for (let i = 0; i < 6; i += 1) await h.advance(5_000)
    expect(h.quits).toHaveLength(0)
    // No timer survives the cancel.
    expect(h.idle()).toBe(true)
  })

  it('a second start while waiting does not open a second loop', async () => {
    const h = harness(ONE_TURN)
    await h.restart.start()
    const again = await h.restart.start()
    expect(again.ok).toBe(true)
    expect(h.drainCalls).toEqual([true])

    h.setActivity(IDLE)
    for (let i = 0; i < 4; i += 1) await h.advance(5_000)
    expect(h.quits).toHaveLength(1)
  })

  it('keeps polling when the drain was refused, so a blocked drain cannot strand the user', async () => {
    const quits: number[] = []
    let clock = 0
    let pending: Array<() => void> = []
    const restart = new IdleRestart({
      readActivity: async () => IDLE,
      setDrain: async () => false,
      quit: () => quits.push(clock),
      pollIntervalMs: 5_000,
      quietForMs: 10_000,
      now: () => clock,
      schedule: (fn, ms) => {
        clock += 0
        const handle = () => fn()
        pending.push(handle)
        void ms
        return handle
      },
      cancel: (handle) => {
        pending = pending.filter((entry) => entry !== handle)
      },
      log: () => {},
    })

    const started = await restart.start()
    expect(started).toMatchObject({ ok: true, draining: false })

    for (let i = 0; i < 4; i += 1) {
      clock += 5_000
      const due = [...pending]
      pending = []
      for (const fn of due) fn()
      for (let j = 0; j < 8; j += 1) await Promise.resolve()
    }
    expect(quits).toEqual([10_000])
  })
})
