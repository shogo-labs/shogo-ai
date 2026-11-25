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
 *
 * What it announces is the set of models a screen follows live — messages and
 * reactions (SHO-486), and cards and channel docs (SHO-494, where a card moved
 * on the computer and a doc saved there were the same silence).
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

/** A card row a sync applied, and the `board.changed` action it stands for. */
export interface LiveItemWrite {
  id: string
  action: 'item.created' | 'item.updated' | 'item.moved'
}

export interface LiveWrites {
  /** Messages this side had never seen. */
  created: string[]
  /** Messages whose row, reactions or thread counters changed. */
  updated: string[]
  /** Cards whose row changed (SHO-494): a board screen reloads on any of these. */
  items: LiveItemWrite[]
  /** Channels whose doc body changed (SHO-494): readers follow `doc.updated`. */
  docs: string[]
}

export function newLiveWrites(): LiveWrites {
  return { created: [], updated: [], items: [], docs: [] }
}

/**
 * Which `board.changed` action an applied card row stands for.
 *
 * A create is a create. A move is only known from the row the cloud already
 * had — the synced row itself carries the destination column, not the action —
 * so `previous` is what tells a move from an edit. Without it the safe answer is
 * `item.updated`: an editor reloads for either.
 */
function itemAction(
  outcome: 'created' | 'updated',
  row: Record<string, unknown>,
  previous?: Record<string, unknown>,
): LiveItemWrite['action'] {
  if (outcome === 'created') return 'item.created'
  if (!previous) return 'item.updated'
  const moved = previous.columnId !== row.columnId || previous.boardId !== row.boardId
  return moved ? 'item.moved' : 'item.updated'
}

/**
 * Note one applied row.
 *
 * Only the models a client follows live are announced: a message row (its
 * serialized form already carries its reactions, attachments, pin and thread
 * counters), a reaction, which changes a message the batch may not have touched,
 * a card, and a channel doc. `previous` is the row this side held before the
 * write, when it held one; it is only used to name a card's action.
 */
export function recordLiveWrite(
  writes: LiveWrites,
  model: string,
  outcome: 'created' | 'updated',
  recordId: string,
  row: Record<string, unknown>,
  previous?: Record<string, unknown>,
): void {
  if (model === 'ConversationMessage') {
    writes[outcome].push(recordId)
    return
  }
  if (model === 'ConversationReaction') {
    const messageId = row.messageId
    if (typeof messageId === 'string' && messageId) writes.updated.push(messageId)
    return
  }
  if (model === 'WorkItem') {
    writes.items.push({ id: recordId, action: itemAction(outcome, row, previous) })
    return
  }
  if (model === 'ConversationDoc') {
    const conversationId = row.conversationId
    if (typeof conversationId === 'string' && conversationId) writes.docs.push(conversationId)
  }
}

/**
 * Publish what `recordLiveWrite` collected. Deliberately never throws: the rows
 * are already committed, and a realtime miss must not fail a sync batch (the
 * next write republishes the same state).
 *
 * Each group has its own announcer, loaded lazily for the reason above, and one
 * group failing does not silence the others.
 */
export async function announceLiveWrites(writes: LiveWrites, log?: (line: string) => void): Promise<number> {
  const groups: Array<{ what: string; count: number; run: () => Promise<number> }> = []
  if (writes.created.length || writes.updated.length) {
    groups.push({
      what: 'message',
      count: writes.created.length + writes.updated.length,
      run: async () => (await loadAnnouncer())(writes),
    })
  }
  if (writes.items.length) {
    groups.push({
      what: 'card',
      count: writes.items.length,
      run: async () => (await import('../../services/work-boards.service')).announceSyncedItems(writes.items),
    })
  }
  if (writes.docs.length) {
    groups.push({
      what: 'doc',
      count: writes.docs.length,
      run: async () => (await import('../../services/conversation-doc.service')).announceSyncedDocs(writes.docs),
    })
  }

  let published = 0
  for (const group of groups) {
    try {
      published += await group.run()
    } catch (err) {
      const line = `[MachineSync] could not announce ${group.count} synced ${group.what} row(s): ${
        (err as Error)?.message ?? err
      }`
      if (log) log(line)
      else console.warn(line)
    }
  }
  return published
}
