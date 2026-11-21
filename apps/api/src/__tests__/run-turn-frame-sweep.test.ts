// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-482: the turn-journal sweep is a background worker, not a boot step.
 *
 * On the desktop it used to run as a fire-and-forget `deleteMany` while the API
 * was still starting. With 8.6M expired rows that one statement blocked the
 * event loop past the 30 s health window, the supervisor killed the API mid
 * delete, the transaction rolled back, and every relaunch did it again. Cloud
 * never swept at all.
 *
 * These tests pin the parts that made that possible to regress: it does not run
 * at start (it waits out the boot), it repeats on a timer, and both composers
 * start it.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { setupChannelsTestDb } from './helpers/channels-test-db'

setupChannelsTestDb()

const runs: number[] = []
// Spread the real module: a partial replacement leaks to any other suite that
// shares this process (the repo's runner isolates files, a bare `bun test` does
// not) and breaks its expectation of the journal's exports.
const realJournal = await import('../services/chat-turn-journal')
mock.module('../services/chat-turn-journal', () => ({
  ...realJournal,
  sweepTurnFrames: async () => {
    runs.push(Date.now())
    return 3
  },
  trimTurnFramesToCap: async () => 4,
}))

const {
  TURN_FRAME_SWEEP_FIRST_DELAY_MS,
  TURN_FRAME_SWEEP_INTERVAL_MS,
  runTurnFrameSweep,
  startTurnFrameSweepWorker,
  stopTurnFrameSweepWorker,
} = await import('../jobs/run-turn-frame-sweep')

beforeEach(() => {
  runs.length = 0
})

afterEach(() => {
  stopTurnFrameSweepWorker()
})

describe('the turn-frame sweep worker (SHO-482)', () => {
  test('waits out the boot before its first tick', () => {
    expect(TURN_FRAME_SWEEP_FIRST_DELAY_MS).toBeGreaterThanOrEqual(60_000)
    // Longer than the desktop's whole health window (30 s), so the API is up
    // and answering before the sweep touches the journal.
    expect(TURN_FRAME_SWEEP_FIRST_DELAY_MS).toBeGreaterThan(30_000)
    expect(TURN_FRAME_SWEEP_INTERVAL_MS).toBe(10 * 60_000)
    startTurnFrameSweepWorker()
    // Nothing has run yet: the first tick is a minute away, not now.
    expect(runs).toHaveLength(0)
  })

  test('one tick sweeps expired frames and then trims to the cap', async () => {
    expect(await runTurnFrameSweep()).toBe(7)
    expect(runs).toHaveLength(1)
  })

  test('starting twice leaves one timer, and stopping is idempotent', () => {
    const stopAgain = startTurnFrameSweepWorker()
    startTurnFrameSweepWorker()
    stopAgain()
    stopTurnFrameSweepWorker()
    expect(runs).toHaveLength(0)
  })
})

describe('both composers start it', () => {
  const read = (file: string) => readFileSync(join(import.meta.dir, '..', file), 'utf8')

  test('the shared worker list starts and stops it for the desktop', () => {
    const source = read('lib/local-background-workers.ts')
    expect(source).toContain('startTurnFrameSweepWorker()')
    expect(source).toContain('stopTurnFrameSweepWorker()')
  })

  // The premise of the card was "both composers use the shared list". They do
  // not: the cloud composer starts each worker itself. Without this line cloud
  // never sweeps old frames, which is the parity rule the channel doc states.
  test('the cloud composer starts and stops it too', () => {
    const source = read('server.ts')
    expect(source).toContain('startTurnFrameSweepWorker()')
    expect(source).toContain('stopTurnFrameSweepWorker()')
  })
})
