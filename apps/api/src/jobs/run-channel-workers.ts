// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Background work for workspace channels.
 *
 * Multi-region: the tables these workers write (conversation_messages,
 * scheduled_messages, chat_reminders, chat_user_settings, embeddings)
 * replicate between regions, and `withGlobalJobLock` is a Postgres advisory
 * lock on THIS region's database - it does not coordinate across regions. So
 * each worker is home-partitioned instead: it only touches workspaces homed
 * in this region (`homeRegionWorkspaceWhere()`), which keeps every region's
 * write set disjoint. The lock stays, but only to serialize pods within one
 * region so they don't repeat the same work (duplicate emails, embeddings).
 */

import { withGlobalJobLock } from '../lib/global-job-lock'
import { claimRegionPeriod } from '../lib/region-period-claim'
import { runDigestPass } from '../services/chat-digest'
import { fireDueReminders, sendDueScheduledMessages } from '../services/chat-items'
import { embeddingProvider, indexPendingMessages, INDEX_FAST_WINDOW_MS, INDEX_WINDOW_MS } from '../services/conversation-semantic'
import { chunkPendingAttachments, embedPendingChunks } from '../services/conversation-file-index'

const DIGEST_INTERVAL_MS = 10 * 60 * 1000
const SCHEDULER_INTERVAL_MS = 15_000
const INDEXER_INTERVAL_MS = 60_000
const INDEXER_MAX_BATCHES = 5
/** The hourly backstop that catches what the fast window cannot see. */
const INDEXER_FULL_PASS_INTERVAL_MS = 60 * 60_000
/**
 * The full pass is a repair pass, not the steady-state one, so it does not need
 * the old per-minute throughput. It is still 5x a minute's worth, which clears a
 * backlog (a fresh deploy, a provider outage) in hours rather than days.
 */
const INDEXER_FULL_PASS_MAX_BATCHES = 25

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

/**
 * The per-region-period claim is what makes this run once a minute rather than
 * once a pod: `withGlobalJobLock` only serialises pods inside a region, and
 * every pod's 60 s timer fires at its own boot offset, so each one ran the
 * whole pass (SHO-347: ~7.8 passes a minute in US, not 1).
 *
 * The message query reads a 30 min `createdAt` window on every tick — the
 * index-backed range — and a full 90-day pass once an hour through a second
 * claim, for the messages the fast window cannot see: an old message whose
 * embedding was deleted by an edit or a file re-extract, and an agent reply
 * that finished more than 30 min after it started.
 */
export async function runChannelIndexer(): Promise<void> {
  await withGlobalJobLock('channels-indexer', async () => {
    if (!(await claimRegionPeriod('channels-indexer', INDEXER_INTERVAL_MS))) return
    // File chunks back reading and keyword search, so they're cut even without an embedding provider.
    for (let i = 0; i < INDEXER_MAX_BATCHES; i++) {
      if (!(await chunkPendingAttachments())) break
    }
    if (!embeddingProvider()) return
    const fullPass = await claimRegionPeriod('channels-indexer-full', INDEXER_FULL_PASS_INTERVAL_MS)
    const windowMs = fullPass ? INDEX_WINDOW_MS : INDEX_FAST_WINDOW_MS
    const maxBatches = fullPass ? INDEXER_FULL_PASS_MAX_BATCHES : INDEXER_MAX_BATCHES
    for (let i = 0; i < maxBatches; i++) {
      if (!(await indexPendingMessages(new Date(), undefined, windowMs))) break
    }
    for (let i = 0; i < INDEXER_MAX_BATCHES; i++) {
      if (!(await embedPendingChunks())) break
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
