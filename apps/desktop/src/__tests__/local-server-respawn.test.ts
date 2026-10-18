// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-26: the desktop app's local API used to be spawn-once. A userland
 * SIGKILL left it with no API until the user quit and relaunched, because
 * `local-server.ts` only logged `API server exited: code=null, signal=SIGKILL`
 * and cleared the handle.
 *
 * `LocalApiSupervisor` now owns the respawn decision. It is Electron-free on
 * purpose so these tests can drive it with a fake spawn + fake health check
 * and assert the four invariants that matter:
 *
 *   a. an unexpected exit (SIGKILL, nonzero code, even code 0) restarts once
 *      and rewrites the pid file,
 *   b. a stop request never restarts (quit must stay quit),
 *   c. backoff is capped and the policy gives up after N attempts,
 *   d. a healthy run resets the attempt counter instead of leaving the app
 *      one crash away from giving up forever.
 */
import { describe, it, expect } from 'bun:test'
import { LocalApiSupervisor, type LocalApiSupervisorOptions } from '../local-api-supervisor'

function harness(overrides: Partial<LocalApiSupervisorOptions> = {}) {
  /** Stands in for the api.pid file, in write order. */
  const pidFile: number[] = []
  const starts: number[] = []
  const restarts: Array<{ attempt: number; pid?: number }> = []
  const giveUps: Error[] = []
  const delays: number[] = []

  let nextPid = 100
  const startImpl = overrides.start ?? (async () => {
    const pid = nextPid++
    pidFile.push(pid)
    return pid
  })

  const supervisor = new LocalApiSupervisor({
    ...overrides,
    start: async (context) => {
      starts.push(context.attempt)
      return startImpl(context)
    },
    sleep: async (ms) => { delays.push(ms) },
    log: () => {},
    onRestarted: (info) => { restarts.push(info) },
    onGiveUp: (error) => { giveUps.push(error) },
    // Long enough that the "healthy" reset timer never fires mid-test.
    policy: { resetAfterMs: 60_000, ...(overrides.policy ?? {}) },
  })

  return { supervisor, pidFile, starts, restarts, giveUps, delays }
}

describe('LocalApiSupervisor respawn', () => {
  it('restarts once after a SIGKILL and rewrites the pid file', async () => {
    const h = harness()
    await h.supervisor.start()
    expect(h.pidFile).toEqual([100])

    await h.supervisor.notifyExit(null, 'SIGKILL')

    expect(h.pidFile).toEqual([100, 101])
    expect(h.restarts).toEqual([{ attempt: 1, pid: 101 }])
    expect(h.starts).toEqual([0, 1])
    expect(h.giveUps).toEqual([])
  })

  it('restarts after a nonzero exit code', async () => {
    const h = harness()
    await h.supervisor.start()

    await h.supervisor.notifyExit(1, null)

    expect(h.pidFile).toEqual([100, 101])
  })

  it('restarts after a clean exit code when the app is not quitting', async () => {
    const h = harness()
    await h.supervisor.start()

    await h.supervisor.notifyExit(0, null)

    expect(h.pidFile).toEqual([100, 101])
  })

  it('never restarts after stop() — quit must stay quit', async () => {
    const h = harness()
    await h.supervisor.start()

    h.supervisor.stop()
    await h.supervisor.notifyExit(null, 'SIGTERM')
    await h.supervisor.notifyExit(143, null)

    expect(h.pidFile).toEqual([100])
    expect(h.restarts).toEqual([])
    expect(h.supervisor.isStopped).toBe(true)
  })

  it('does not stack a second restart loop while one is in flight', async () => {
    const h = harness({
      start: async (context) => {
        if (context.attempt === 0) return 100
        // Hold the attempt open so the second notifyExit lands mid-loop.
        await new Promise((r) => setTimeout(r, 20))
        return 200
      },
    })
    await h.supervisor.start()

    // A child that dies during a restart attempt fires its own exit event; it
    // must join the loop in flight instead of starting a second backoff.
    const first = h.supervisor.notifyExit(null, 'SIGKILL')
    const second = h.supervisor.notifyExit(null, 'SIGKILL')
    await Promise.all([first, second])

    expect(h.starts).toEqual([0, 1])
    expect(h.restarts).toHaveLength(1)
  })

  it('ignores an exit that arrives after a stop request', async () => {
    const h = harness()
    await h.supervisor.start()
    h.supervisor.stop()

    expect(h.supervisor.notifyExit(null, 'SIGKILL')).toBeUndefined()
  })
})

describe('LocalApiSupervisor retry policy', () => {
  it('caps the backoff and gives up after maxAttempts', async () => {
    const attempts: number[] = []
    const h = harness({
      start: async (context) => {
        attempts.push(context.attempt)
        if (context.attempt === 0) return 100
        throw new Error('port still taken')
      },
      policy: { backoffMs: [10, 20], maxAttempts: 5, resetAfterMs: 60_000 },
    })

    await h.supervisor.start()
    await h.supervisor.notifyExit(1, null)

    // Five restart attempts, each with the capped delay.
    expect(attempts).toEqual([0, 1, 2, 3, 4, 5])
    expect(h.delays).toEqual([10, 20, 20, 20, 20])
    expect(h.giveUps).toHaveLength(1)
    expect(h.giveUps[0]!.message).toContain('5 restart attempts failed')
    expect(h.supervisor.hasGivenUp).toBe(true)
  })

  it('stops retrying once it has given up', async () => {
    const attempts: number[] = []
    const h = harness({
      start: async (context) => {
        attempts.push(context.attempt)
        if (context.attempt === 0) return 100
        throw new Error('nope')
      },
      policy: { backoffMs: [1], maxAttempts: 2, resetAfterMs: 60_000 },
    })

    await h.supervisor.start()
    await h.supervisor.notifyExit(1, null)
    expect(attempts).toEqual([0, 1, 2])

    await h.supervisor.notifyExit(1, null)
    expect(attempts).toEqual([0, 1, 2])
    expect(h.giveUps).toHaveLength(1)
  })

  it('resets the attempt counter after a healthy run', async () => {
    const attempts: number[] = []
    const timers: Array<() => void> = []
    const h = harness({
      start: async (context) => {
        attempts.push(context.attempt)
        return 100 + attempts.length
      },
      policy: { backoffMs: [1, 2, 4], maxAttempts: 3, resetAfterMs: 60_000 },
      setTimer: (fn) => {
        timers.push(fn)
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {},
    })

    await h.supervisor.start()
    await h.supervisor.notifyExit(1, null)
    expect(h.starts).toEqual([0, 1])

    // Stand in for "60s of healthy uptime elapsed".
    expect(timers.length).toBeGreaterThan(0)
    timers[timers.length - 1]!()

    await h.supervisor.notifyExit(1, null)
    // Back to attempt 1 rather than attempt 2 → the policy did not decay.
    expect(h.starts).toEqual([0, 1, 1])
  })
})
