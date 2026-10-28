// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-185 — the local API's event-loop lag monitor.
 *
 * Its only job is to make a blocked loop visible: without it, the incident showed
 * up solely as a tunnel dropping with 1006 and a supervisor killing a "dead" API
 * that was in fact busy. A real (not mocked) stall keeps this honest: if the
 * monitor ever stops noticing blocked time, this fails.
 */

import { describe, expect, test } from 'bun:test'
import { startEventLoopLagMonitor } from '../event-loop-lag'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('startEventLoopLagMonitor', () => {
  test('reports a real stall, once, with its duration', async () => {
    const seen: number[] = []
    const monitor = startEventLoopLagMonitor({
      intervalMs: 20,
      thresholdMs: 50,
      minReportGapMs: 10_000,
      onLag: (sample) => seen.push(sample.lagMs),
    })

    try {
      await sleep(60)
      expect(seen).toEqual([]) // a quiet loop reports nothing

      // Block the loop for ~120ms the way a shelled-out `lsof` did.
      const until = Date.now() + 120
      while (Date.now() < until) { /* spin */ }
      await sleep(80)

      expect(seen.length).toBe(1)
      expect(seen[0]).toBeGreaterThanOrEqual(50)
    } finally {
      monitor.stop()
    }
  })

  test('logs a warning the next time a stall is seen', async () => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: any[]) => { warnings.push(args.join(' ')) }
    const monitor = startEventLoopLagMonitor({ intervalMs: 20, thresholdMs: 40, minReportGapMs: 0 })
    try {
      const until = Date.now() + 100
      while (Date.now() < until) { /* spin */ }
      await sleep(60)
    } finally {
      monitor.stop()
      console.warn = originalWarn
    }
    expect(warnings.some((w) => w.includes('[LocalApi] event loop blocked for'))).toBe(true)
  })

  test('stop() ends the monitoring and keeps the process free to exit', async () => {
    const monitor = startEventLoopLagMonitor({ intervalMs: 10, thresholdMs: 1_000 })
    monitor.stop()
    monitor.stop() // idempotent
    const until = Date.now() + 60
    while (Date.now() < until) { /* spin */ }
    await sleep(30)
    expect(monitor.samples).toEqual([])
  })
})
