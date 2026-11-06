// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import {
  dispatchPendingSessions,
  resetStuckDispatching,
} from '../services/chat-queue-dispatcher.service'
import { reconcileStuckTasks, sweepUnnotifiedWakes } from '../services/background-tasks.service'
import { sweepPendingAgentWakes } from '../services/conversation-agent-dispatcher'

const CHAT_QUEUE_DISPATCH_INTERVAL_MS = 15_000

/**
 * Runs in every region without a global lock: the dispatcher only touches
 * queue rows whose session's workspace is homed in this region, so each
 * region drains a disjoint slice. A global lock would leave the peer's
 * sessions undrained because the lock holder skips non-home sessions.
 *
 * The wake sweeps are what make a wake durable: a finished task whose coalesce
 * timer died with its process (or whose notify never arrived) is re-queued
 * here, so a restarted API heals itself on its first tick.
 *
 * The dead-reply sweep used to ride this 15 s loop too. It has its own 60 s
 * timer in `jobs/run-chat-sweep.ts` since SHO-347: a 5-minute staleness window
 * does not need a 15 s poll, and every extra tick was a scan of
 * `conversation_messages` per pod.
 */
export async function runChatQueueDrain(): Promise<void> {
  await reconcileStuckTasks()
  await sweepUnnotifiedWakes()
  await sweepPendingAgentWakes()
  await resetStuckDispatching()
  await dispatchPendingSessions()
}

let chatQueueTimer: ReturnType<typeof setInterval> | null = null

export function startChatQueueWorker(): () => void {
  if (chatQueueTimer) return stopChatQueueWorker
  const tick = () => {
    void runChatQueueDrain().catch((error) => {
      console.error('[ChatQueue] Dispatcher tick failed:', error)
    })
  }
  tick()
  chatQueueTimer = setInterval(tick, CHAT_QUEUE_DISPATCH_INTERVAL_MS)
  ;(chatQueueTimer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.()
  return stopChatQueueWorker
}

export function stopChatQueueWorker(): void {
  if (chatQueueTimer) clearInterval(chatQueueTimer)
  chatQueueTimer = null
}
