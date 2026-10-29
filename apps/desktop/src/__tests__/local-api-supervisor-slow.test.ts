// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A slow API is not a hung one: probes that answer late keep the API alive,
 * and only probes with no answer at all count toward a restart.
 */
import { describe, expect, it } from 'bun:test'
import { DEFAULT_HEALTH_WATCHDOG, LocalApiSupervisor } from '../local-api-supervisor'

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

function rig(
  probe: () => Promise<boolean>,
  extra: { lastOutputAt?: () => number | null; maxBusyMs?: number } = {},
) {
  const state = { kills: 0, slow: [] as number[], failures: 0, busy: [] as number[] }
  const supervisor = new LocalApiSupervisor({
    lastOutputAt: extra.lastOutputAt,
    onBusyHealth: ({ unansweredMs }) => state.busy.push(unansweredMs),
    start: async () => 101,
    fetchHealth: probe,
    kill: async () => {
      state.kills += 1
    },
    onSlowHealth: ({ elapsedMs }) => state.slow.push(elapsedMs),
    onHealthFailure: () => {
      state.failures += 1
    },
    sleep: async () => {},
    log: () => {},
    watchdog: {
      intervalMs: 1,
      slowMs: 20,
      timeoutMs: 200,
      failureThreshold: 3,
      ...(extra.maxBusyMs !== undefined ? { maxBusyMs: extra.maxBusyMs } : {}),
    },
  })
  return { supervisor, state }
}

describe('LocalApiSupervisor with a slow API', () => {
  it('never restarts an API whose probes answer late', async () => {
    const { supervisor, state } = rig(async () => {
      await pause(40)
      return true
    })
    await supervisor.start()
    await pause(400)
    supervisor.stop()

    expect(state.kills).toBe(0)
    expect(state.failures).toBe(0)
    expect(state.slow.length).toBeGreaterThanOrEqual(3)
    expect(Math.min(...state.slow)).toBeGreaterThan(20)
  })

  it('restarts an API that does not answer at all', async () => {
    const { supervisor, state } = rig(() => new Promise<boolean>(() => {}))
    await supervisor.start()
    const deadline = Date.now() + 3_000
    while (state.kills === 0 && Date.now() < deadline) await pause(10)
    supervisor.stop()

    expect(state.kills).toBe(1)
    expect(state.failures).toBe(3)
  })

  it('never restarts an API that misses probes but keeps writing output', async () => {
    // lacvapps/shogo-ai#5: under a burst of agent turns /health went
    // unanswered while the API was still logging work, and the kill took every
    // live run with it. Output since the last probe means the loop is running.
    const { supervisor, state } = rig(() => new Promise<boolean>(() => {}), {
      lastOutputAt: () => Date.now(),
    })
    await supervisor.start()
    await pause(1_000)
    supervisor.stop()

    expect(state.kills).toBe(0)
    expect(state.failures).toBe(0)
    expect(state.busy.length).toBeGreaterThanOrEqual(3)
  })

  it('restarts once output stops, even after a busy stretch', async () => {
    let talking = true
    let lastOutput = Date.now()
    const { supervisor, state } = rig(() => new Promise<boolean>(() => {}), {
      lastOutputAt: () => (talking ? (lastOutput = Date.now()) : lastOutput),
    })
    await supervisor.start()
    await pause(500)
    expect(state.kills).toBe(0)

    talking = false
    const deadline = Date.now() + 3_000
    while (state.kills === 0 && Date.now() < deadline) await pause(10)
    supervisor.stop()

    expect(state.busy.length).toBeGreaterThanOrEqual(1)
    expect(state.kills).toBe(1)
    // The busy misses broke the streak: three *silent* misses in a row tripped it.
    expect(state.failures).toBe(3)
  })

  it('restarts a talking API that has answered nothing for maxBusyMs', async () => {
    const { supervisor, state } = rig(() => new Promise<boolean>(() => {}), {
      lastOutputAt: () => Date.now(),
      maxBusyMs: 500,
    })
    await supervisor.start()
    const deadline = Date.now() + 3_000
    while (state.kills === 0 && Date.now() < deadline) await pause(10)
    supervisor.stop()

    expect(state.busy.length).toBeGreaterThanOrEqual(1)
    expect(state.kills).toBe(1)
  })

  it('output from before the last probe does not count as progress', async () => {
    // Written once at boot, then silence: that is the wedged API, not a busy one.
    const bootLine = Date.now() - 1
    const { supervisor, state } = rig(() => new Promise<boolean>(() => {}), {
      lastOutputAt: () => bootLine,
    })
    await supervisor.start()
    const deadline = Date.now() + 3_000
    while (state.kills === 0 && Date.now() < deadline) await pause(10)
    supervisor.stop()

    expect(state.busy).toEqual([])
    expect(state.kills).toBe(1)
  })

  it('leaves a busy API alone for minutes, not seconds', () => {
    expect(DEFAULT_HEALTH_WATCHDOG.maxBusyMs).toBeGreaterThanOrEqual(5 * 60_000)
  })

  it('gives a probe far longer than a slow moment before counting it', () => {
    expect(DEFAULT_HEALTH_WATCHDOG.timeoutMs).toBeGreaterThanOrEqual(10 * DEFAULT_HEALTH_WATCHDOG.slowMs)
  })
})
