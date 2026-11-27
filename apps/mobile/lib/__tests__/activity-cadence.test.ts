// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-602 — the three cadences, and which one a screen gets.
 *
 * A poll wakes the phone radio, so 5 s is only for the thing the person is
 * looking at. Everything else is a safety net behind the realtime turn edges.
 */
import { describe, expect, test } from 'bun:test'
import {
  ACTIVITY_IDLE_POLL_MS,
  ACTIVITY_OFFSCREEN_RUN_POLL_MS,
  ACTIVITY_WATCHING_POLL_MS,
  activityPollMs,
} from '../activity-cadence'

describe('activityPollMs', () => {
  test('the run on screen keeps the 5 s live cadence', () => {
    expect(activityPollMs({ watchingRunning: true, anyRunning: true })).toBe(
      ACTIVITY_WATCHING_POLL_MS,
    )
    expect(ACTIVITY_WATCHING_POLL_MS).toBe(5_000)
  })

  test('a run elsewhere is a 60 s safety net, not a 5 s poll', () => {
    expect(activityPollMs({ watchingRunning: false, anyRunning: true })).toBe(
      ACTIVITY_OFFSCREEN_RUN_POLL_MS,
    )
    expect(ACTIVITY_OFFSCREEN_RUN_POLL_MS).toBe(60_000)
  })

  test('an idle screen asks every 30 s — no faster than 15 s', () => {
    expect(activityPollMs({ watchingRunning: false, anyRunning: false })).toBe(
      ACTIVITY_IDLE_POLL_MS,
    )
    expect(ACTIVITY_IDLE_POLL_MS).toBeGreaterThanOrEqual(15_000)
  })

  test('5 min on any screen stays inside the card’s request budgets', () => {
    const window = 5 * 60_000
    const idle = Math.floor(window / ACTIVITY_IDLE_POLL_MS)
    const offscreen = Math.floor(window / ACTIVITY_OFFSCREEN_RUN_POLL_MS)
    // AC3: nothing running — <= 20 requests across the workspace endpoints.
    expect(idle * 2).toBeLessThanOrEqual(20)
    // AC1: a turn running elsewhere — <= 6 per endpoint.
    expect(offscreen).toBeLessThanOrEqual(6)
  })
})
