// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tell the watching clients about rows a machine sync just wrote (SHO-486).
 *
 * A hosted workspace is written by both sides: `postMessage` publishes when the
 * cloud writes, and anything the desktop writes arrives as synced rows. Until
 * this existed those rows landed silently, so a channel reply posted (or run) on
 * the desktop only appeared to a cloud client after a refresh — the desktop had
 * the row, Postgres had the row, and nobody told the socket.
 *
 * One collector, used by both directions (cloud `ingest`, desktop `puller`), so
 * the two can never diverge: record what changed while the rows are applied,
 * then announce after the writes have committed.
 */

/**
 * Imported lazily on purpose: `conversation.service` pulls in the whole channel
 * stack, and this module is reached from `ingest`/`puller`, which the runtime
 * loads early — a static import made that a cycle ("Cannot access 'prisma'
 * before initialization" in `chat-mode`).
 */
async function loadAnnouncer() {
  return (await import('../../services/conversation.service')).announceSyncedMessages
}

export interface LiveWrites {
  /** Messages this side had never seen. */
  created: string[]
  /** Messages whose row, reactions or thread counters changed. */
  updated: string[]
}

export function newLiveWrites(): LiveWrites {
  return { created: [], updated: [] }
}

/**
 * Note one applied row. Only the conversation graph is announced: a message row
 * (its serialized form already carries its reactions, attachments, pin and
 * thread counters), and a reaction, which changes a message the batch may not
 * have touched.
 */
export function recordLiveWrite(
  writes: LiveWrites,
  model: string,
  outcome: 'created' | 'updated',
  recordId: string,
  row: Record<string, unknown>,
): void {
  if (model === 'ConversationMessage') {
    writes[outcome].push(recordId)
    return
  }
  if (model === 'ConversationReaction') {
    const messageId = row.messageId
    if (typeof messageId === 'string' && messageId) writes.updated.push(messageId)
  }
}

/**
 * Publish what `recordLiveWrite` collected. Deliberately never throws: the rows
 * are already committed, and a realtime miss must not fail a sync batch (the
 * next write republishes the same state).
 */
export async function announceLiveWrites(writes: LiveWrites, log?: (line: string) => void): Promise<number> {
  if (!writes.created.length && !writes.updated.length) return 0
  try {
    const announce = await loadAnnouncer()
    return await announce(writes)
  } catch (err) {
    const line = `[MachineSync] could not announce ${writes.created.length + writes.updated.length} synced row(s): ${
      (err as Error)?.message ?? err
    }`
    if (log) log(line)
    else console.warn(line)
    return 0
  }
}
