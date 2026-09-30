// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Background work for workspace channels. Each body runs under its own
 * global job lock so only one region does it per tick.
 */

import { withGlobalJobLock } from '../lib/global-job-lock'
import { runDigestPass } from '../services/chat-digest'
import { fireDueReminders, sendDueScheduledMessages } from '../services/chat-items'
import { embeddingProvider, indexPendingMessages } from '../services/conversation-semantic'

const DIGEST_INTERVAL_MS = 10 * 60 * 1000
const SCHEDULER_INTERVAL_MS = 15_000
const INDEXER_INTERVAL_MS = 60_000
const INDEXER_MAX_BATCHES = 5

export async function runChannelEmailDigest(): Promise<void> {
  await withGlobalJobLock('channels-email-digest', async () => {
    await runDigestPass()
  })
}

export async function runChannelScheduler(): Promise<void> {
  await withGlobalJobLock('channels-scheduler', async () => {
    await sendDueScheduledMessages()
    await fireDueReminders()
  })
}

export async function runChannelIndexer(): Promise<void> {
  if (!embeddingProvider()) return
  await withGlobalJobLock('channels-indexer', async () => {
    for (let i = 0; i < INDEXER_MAX_BATCHES; i++) {
      if (!(await indexPendingMessages())) break
    }
  })
}

const timers: ReturnType<typeof setInterval>[] = []

function every(ms: number, label: string, fn: () => Promise<void>) {
  const tick = () => {
    void fn().catch((error) => console.error(`[Channels] ${label} tick failed:`, error))
  }
  const timer = setInterval(tick, ms)
  ;(timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.()
  timers.push(timer)
}

export function startChannelWorkers(): () => void {
  if (timers.length) return stopChannelWorkers
  every(DIGEST_INTERVAL_MS, 'Email digest', runChannelEmailDigest)
  every(SCHEDULER_INTERVAL_MS, 'Scheduler', runChannelScheduler)
  every(INDEXER_INTERVAL_MS, 'Search indexer', runChannelIndexer)
  return stopChannelWorkers
}

export function stopChannelWorkers(): void {
  while (timers.length) clearInterval(timers.pop()!)
}
