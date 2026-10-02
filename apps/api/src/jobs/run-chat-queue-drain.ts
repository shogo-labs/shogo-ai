// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import {
  dispatchPendingSessions,
  resetStuckDispatching,
} from '../services/chat-queue-dispatcher.service'

const CHAT_QUEUE_DISPATCH_INTERVAL_MS = 15_000

/**
 * Runs in every region without a global lock: the dispatcher only touches
 * queue rows whose session's workspace is homed in this region, so each
 * region drains a disjoint slice. A global lock would leave the peer's
 * sessions undrained because the lock holder skips non-home sessions.
 */
export async function runChatQueueDrain(): Promise<void> {
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
