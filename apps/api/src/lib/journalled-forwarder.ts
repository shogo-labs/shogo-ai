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
 * Both relays (`/projects/:id/chat` and `/workspaces/:id/chat`) use this, so the
 * ordering guarantee has one implementation and one test.
 */
import type { TurnJournalWriter } from '../services/chat-turn-journal'

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

export function createJournalledForwarder({
  journal,
  forward,
}: JournalledForwarderOptions): JournalledForwarder {
  let pending: Uint8Array[] = []
  let scheduled = false
  let chain: Promise<void> = Promise.resolve()

  const drainOnce = async (): Promise<void> => {
    while (pending.length > 0) {
      const batch = pending
      pending = []
      // The write-ahead step: nothing in `batch` is forwarded until this
      // resolves. `append` never throws and never blocks longer than its retry
      // budget — a database outage must not freeze the person's stream.
      if (journal) await journal.append(batch)
      for (const chunk of batch) forward(chunk)
    }
  }

  return {
    push(chunk) {
      pending.push(chunk)
      if (scheduled) return
      scheduled = true
      chain = chain.then(() => {
        scheduled = false
        return drainOnce()
      })
    },
    async drain() {
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
