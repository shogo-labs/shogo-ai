// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A slow API is not a hung one: probes that answer late keep the API alive,
 * and only probes with no answer at all count toward a restart.
 */
import { describe, expect, it } from 'bun:test'
import { DEFAULT_HEALTH_WATCHDOG, LocalApiSupervisor } from '../local-api-supervisor'

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

function rig(probe: () => Promise<boolean>) {
  const state = { kills: 0, slow: [] as number[], failures: 0 }
  const supervisor = new LocalApiSupervisor({
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
    watchdog: { intervalMs: 1, slowMs: 20, timeoutMs: 200, failureThreshold: 3 },
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

  it('gives a probe far longer than a slow moment before counting it', () => {
    expect(DEFAULT_HEALTH_WATCHDOG.timeoutMs).toBeGreaterThanOrEqual(10 * DEFAULT_HEALTH_WATCHDOG.slowMs)
  })
})
