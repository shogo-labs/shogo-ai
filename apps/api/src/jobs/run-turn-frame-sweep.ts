// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The `chat_turn_frames` retention sweep, on its own timer (SHO-482).
 *
 * It used to be a fire-and-forget `deleteMany` fired from the desktop composer
 * during boot. A backlog of 8.6M frames made that one statement block the event
 * loop for ~71s, the 30s health window killed the API mid-delete, the
 * transaction rolled back, and every relaunch repeated it — an app that could
 * never open again.
 *
 * Two things make that impossible now: the sweep is batched and yields between
 * batches (see `sweepTurnFrames`), and it no longer runs until a minute after
 * boot, once `Bun.serve` is bound and the health check has passed. Cloud never
 * swept old frames at all, which the parity rule does not allow, so the worker
 * lives in the shared list both composers start.
 *
 * The claim is a per-region period, like the other shared workers: every pod
 * boots the same interval at its own offset, so `withGlobalJobLock` alone would
 * only serialise them, not stop pod B running the same sweep seconds later.
 */

import { claimRegionPeriod } from '../lib/region-period-claim'
import { withGlobalJobLock } from '../lib/global-job-lock'
import { sweepTurnFrames, trimTurnFramesToCap } from '../services/chat-turn-journal'

export const TURN_FRAME_SWEEP_INTERVAL_MS = 10 * 60_000

/**
 * First tick delay. Long enough that a cold boot — migrate, bind, runtime
 * restore, health check — is done before the first delete competes with it.
 */
export const TURN_FRAME_SWEEP_FIRST_DELAY_MS = 60_000

/** One tick: age pass, then cap. Returns how many frames it removed. */
export async function runTurnFrameSweep(): Promise<number> {
  // The job name is a literal on purpose: `scripts/check-multiregion-cron-locks.ts`
  // resolves it statically and requires the `KNOWN_JOB_IDS` entry to match.
  const lock = await withGlobalJobLock('turn-frame-sweep', async () => {
    if (!(await claimRegionPeriod('turn-frame-sweep', TURN_FRAME_SWEEP_INTERVAL_MS))) return 0
    const expired = await sweepTurnFrames()
    const trimmed = await trimTurnFramesToCap()
    return expired + trimmed
  })
  if (!lock.acquired) return 0
  return lock.result
}

let firstTimer: ReturnType<typeof setTimeout> | null = null
let intervalTimer: ReturnType<typeof setInterval> | null = null

const unref = (timer: unknown) =>
  (timer as { unref?: () => void } | null)?.unref?.()

export function startTurnFrameSweepWorker(): () => void {
  if (firstTimer || intervalTimer) return stopTurnFrameSweepWorker
  const tick = () => {
    void runTurnFrameSweep().catch((error) => {
      console.error('[ChatTurnJournal] Turn-frame sweep failed:', error?.message ?? error)
    })
  }
  firstTimer = setTimeout(() => {
    firstTimer = null
    tick()
    intervalTimer = setInterval(tick, TURN_FRAME_SWEEP_INTERVAL_MS)
    unref(intervalTimer)
  }, TURN_FRAME_SWEEP_FIRST_DELAY_MS)
  unref(firstTimer)
  return stopTurnFrameSweepWorker
}

export function stopTurnFrameSweepWorker(): void {
  if (firstTimer) clearTimeout(firstTimer)
  if (intervalTimer) clearInterval(intervalTimer)
  firstTimer = null
  intervalTimer = null
}
