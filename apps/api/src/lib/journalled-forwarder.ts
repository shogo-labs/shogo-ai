// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The write-ahead half of the chat relay (SHO-274).
 *
 * The invariant this card is built on is *a frame reaches the client only after
 * it is durable in the database*. The relay therefore does not forward what it
 * reads; it hands chunks to this forwarder, which batches them, waits for the
 * journal insert to commit, and only then runs `forward` for each chunk in that
 * batch. While an insert is in flight the reader keeps reading, so the next
 * batch is exactly the chunks that arrived meanwhile — a slow database grows the
 * batch instead of stalling the stream.
 *
 * Two things keep that from costing a row per frame (SHO-319):
 *
 *   - a chunk that carries nothing but `data-turn-seq` heartbeats is forwarded
 *     but never journalled. It is a transient frame: replay drops it and
 *     re-derives the seq from the frames around it, so storing it buys nothing.
 *     It still goes out in queue order — forwarding it early would let a
 *     reconnect resume at a seq whose content is not durable yet.
 *   - a batch is held for `JOURNAL_BATCH_WINDOW_MS` before it is written, so a
 *     token burst becomes one row instead of one row per delta. `drain()` flushes
 *     immediately, so the end of a stream is never delayed by the window.
 *
 * Both relays (`/projects/:id/chat` and `/workspaces/:id/chat`) use this, so the
 * ordering guarantee has one implementation and one test.
 */
import { TURN_SEQ_EVENT_TYPE } from '@shogo-ai/sdk/stream-buffer'
import type { TurnJournalWriter } from '../services/chat-turn-journal'

/**
 * How long a batch waits for company before it is written.
 *
 * Long enough that the deltas of one token burst land in a single row, short
 * enough that it is invisible next to the round trip the client already pays.
 */
export const JOURNAL_BATCH_WINDOW_MS = 25

export interface JournalledForwarderOptions {
  /** The turn's journal. Null when the turn has no id to journal under. */
  journal: TurnJournalWriter | null
  /**
   * Called once per chunk, in order, after the batch holding it is durable.
   * Everything the relay did synchronously before (tracking queue, latency,
   * client enqueue) belongs here.
   */
  forward: (chunk: Uint8Array) => void
}

export interface JournalledForwarder {
  /** Hand the forwarder a chunk read from upstream. */
  push(chunk: Uint8Array): void
  /**
   * Resolves when every chunk pushed so far has been forwarded. The relay awaits
   * this before it closes the client stream, so the last frames still reach the
   * person after the upstream ends.
   */
  drain(): Promise<void>
  /** Journal batches written, for the stream's closing log line. */
  readonly batches: number
}

const decoder = new TextDecoder()

/**
 * Whether a chunk is nothing but complete `data-turn-seq` events.
 *
 * Deliberately strict: every event in the chunk must be a single-line
 * `data: {json}` whose `type` is the seq heartbeat. A chunk holding a partial
 * SSE frame, a content event, or anything unparseable is journalled as it
 * always was — a split frame has to replay byte-identical, and a chunk that
 * merely *contains* a heartbeat also contains content that must be durable.
 */
export function isTransientOnlyChunk(chunk: Uint8Array): boolean {
  const text = decoder.decode(chunk)
  // Cheap pre-filter: most chunks are content and never mention the heartbeat.
  if (!text.includes(TURN_SEQ_EVENT_TYPE)) return false
  // A trailing partial event means the frame is split across chunks.
  if (!text.endsWith('\n\n')) return false
  const events = text.split('\n\n')
  // `split` leaves an empty tail for the trailing separator.
  events.pop()
  if (events.length === 0) return false
  for (const event of events) {
    if (!event.startsWith('data: ')) return false
    const payload = event.slice(6)
    if (!payload.startsWith('{')) return false
    try {
      const parsed = JSON.parse(payload)
      if (parsed?.type !== TURN_SEQ_EVENT_TYPE) return false
    } catch {
      return false
    }
  }
  return true
}

export function createJournalledForwarder({
  journal,
  forward,
}: JournalledForwarderOptions): JournalledForwarder {
  let pending: Uint8Array[] = []
  /** A chain link is queued to drain `pending`. */
  let flushQueued = false
  /** The batch window is open; `pending` is not being written yet. */
  let windowTimer: ReturnType<typeof setTimeout> | null = null
  let chain: Promise<void> = Promise.resolve()

  const drainOnce = async (): Promise<void> => {
    while (pending.length > 0) {
      const batch = pending
      pending = []
      // The write-ahead step: nothing in `batch` is forwarded until this
      // resolves. `append` never throws and never blocks longer than its retry
      // budget — a database outage must not freeze the person's stream.
      if (journal) {
        const durable = batch.filter((chunk) => !isTransientOnlyChunk(chunk))
        if (durable.length > 0) await journal.append(durable)
      }
      for (const chunk of batch) forward(chunk)
    }
  }

  const queueFlush = () => {
    if (flushQueued) return
    flushQueued = true
    chain = chain.then(() => {
      flushQueued = false
      if (windowTimer) {
        clearTimeout(windowTimer)
        windowTimer = null
      }
      return drainOnce()
    })
  }

  return {
    push(chunk) {
      pending.push(chunk)
      if (flushQueued || windowTimer) return
      // No journal means nothing to wait for: forward on the next microtask,
      // exactly as before, so a turn without a turn id pays no added latency.
      if (!journal) {
        queueFlush()
        return
      }
      windowTimer = setTimeout(() => {
        windowTimer = null
        queueFlush()
      }, JOURNAL_BATCH_WINDOW_MS)
    },
    async drain() {
      // The stream is ending: do not wait out the window.
      if (windowTimer) {
        clearTimeout(windowTimer)
        windowTimer = null
      }
      queueFlush()
      // A push that arrived while the previous drain was finishing scheduled
      // another link; awaiting the chain covers it.
      let seen: Promise<void>
      do {
        seen = chain
        await seen
      } while (seen !== chain)
    },
    get batches() {
      return journal?.written ?? 0
    },
  }
}
