// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The dead-reply sweep on its own 60 s cadence.
 *
 * It used to ride inside `runChatQueueDrain`, which ticks every 15 s on every
 * pod with no lock at all — four full scans of `conversation_messages` per pod
 * per minute (SHO-347 / PERF-20). Nothing about the sweep needs that cadence:
 * a run is not declared dead until it has missed heartbeats for
 * `DEFAULT_STALE_AFTER_MS` (5 min), so noticing it a minute late is free.
 *
 * The claim is what makes the cadence honest. `withGlobalJobLock` alone only
 * serialises pods within a region (each pod's timer fires at its own boot
 * offset, so pod B runs the same sweep seconds after pod A released the lock),
 * so the per-region-period claim is what actually reduces it to one run.
 *
 * Region safety: the sweep is already `homeRegionWorkspaceWhere()`-scoped, so
 * each region inspects only its own conversations and the claims never overlap.
 */

import { claimRegionPeriod } from '../lib/region-period-claim'
import { withGlobalJobLock } from '../lib/global-job-lock'
import { sweepDeadAgentReplies } from '../services/conversation-agent-dispatcher'

export const SWEEP_INTERVAL_MS = 60_000
const SWEEP_JOB = 'chat-dead-reply-sweep'

/** Settles replies whose run died. Returns how many it settled. */
export async function runDeadAgentReplySweep(): Promise<number> {
  const lock = await withGlobalJobLock(SWEEP_JOB, async () => {
    if (!(await claimRegionPeriod(SWEEP_JOB, SWEEP_INTERVAL_MS))) return 0
    return sweepDeadAgentReplies()
  })
  if (!lock.acquired) return 0
  return lock.result
}

let sweepTimer: ReturnType<typeof setInterval> | null = null

export function startChatSweepWorker(): () => void {
  if (sweepTimer) return stopChatSweepWorker
  const tick = () => {
    void runDeadAgentReplySweep().catch((error) => {
      console.error('[ChatQueue] Dead-reply sweep failed:', error)
    })
  }
  tick()
  sweepTimer = setInterval(tick, SWEEP_INTERVAL_MS)
  ;(sweepTimer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.()
  return stopChatSweepWorker
}

export function stopChatSweepWorker(): void {
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = null
}
