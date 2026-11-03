// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * How a delta of saved rows is merged into the transcript on screen (SHO-287).
 *
 * The old merge put both arrays in one map and sorted the result by
 * `createdAt || 0`. Every message the AI SDK builds locally — the streamed
 * assistant bubble, the resume snapshot, anything a route painted before the
 * server wrote its row — carries **no** `createdAt`, so it sorted to index 0:
 * the reply jumped above the first prompt, and because its id never matches a
 * server row the next delta never replaced it. On a chat that is reloaded
 * mid-turn the screen then read `[reply, prompt, prompt, reply…]` and stayed
 * that way until the turn ended.
 *
 * Two rules replace the sort:
 *
 *  - A saved row keeps the position its row id already has on screen. Nothing
 *    that is already painted moves because a timestamp says it should.
 *  - A message with no server id is *local-only*, and it never moves: it stays
 *    exactly where the turn it belongs to is. A saved row for the same turn
 *    (`messageTurnKey`) replaces it in place instead of being added beside it.
 *
 * New rows are placed by `createdAt` among the rows that have one, so a delta
 * that arrives out of order still lands in the right turn.
 */
import { messageTurnKey } from "./resume-replay-transport"

export interface TranscriptMessage {
  id?: string | null
  role?: string | null
  createdAt?: unknown
  parts?: unknown
}

/** A message's send time in ms, or null when it has none (built locally). */
export function messageTime(message: TranscriptMessage | undefined): number | null {
  const raw = message?.createdAt
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null
  if (raw instanceof Date) {
    const at = raw.getTime()
    return Number.isFinite(at) ? at : null
  }
  if (typeof raw === "string") {
    const at = new Date(raw).getTime()
    return Number.isFinite(at) ? at : null
  }
  return null
}

function idOf(message: TranscriptMessage | undefined): string | null {
  const id = message?.id
  return id == null || id === "" ? null : String(id)
}

type TurnKeyOf<T> = (message: T | undefined) => string | null

const defaultTurnKey: TurnKeyOf<TranscriptMessage> = (message) =>
  messageTurnKey(message as never)

/**
 * Merge saved rows into the transcript on screen.
 *
 * `current` is what the person is looking at (server rows plus anything the
 * SDK built here); `rows` is what the delta returned, oldest or not. The
 * result keeps `current`'s order for everything already on screen.
 */
export function mergeTranscriptRows<T extends TranscriptMessage>(
  current: readonly T[],
  rows: readonly T[],
  turnKeyOf: TurnKeyOf<T> = defaultTurnKey as unknown as TurnKeyOf<T>,
): T[] {
  if (rows.length === 0) return current as T[]
  const next = current.slice()
  const indexById = new Map<string, number>()
  const rebuildIndex = () => {
    indexById.clear()
    next.forEach((message, index) => {
      const id = idOf(message)
      if (id) indexById.set(id, index)
    })
  }
  rebuildIndex()

  for (const row of rows) {
    const id = idOf(row)
    if (!id) continue

    // Already on screen: take the newer copy, in the position it holds.
    const existing = indexById.get(id)
    if (existing !== undefined) {
      next[existing] = row
      continue
    }

    // A local-only copy of this turn (the streamed bubble, a resume snapshot,
    // an optimistic echo): the saved row *is* that message, now that the
    // server has written it. Swap it in place so the reply stays under its
    // prompt.
    const key = turnKeyOf(row)
    if (key) {
      let replaced = false
      for (let index = next.length - 1; index >= 0; index--) {
        if (turnKeyOf(next[index]) !== key) continue
        if (messageTime(next[index]) !== null) continue
        next[index] = row
        replaced = true
        break
      }
      if (replaced) {
        rebuildIndex()
        continue
      }
    }

    // A row this screen has never held: place it by time among the rows that
    // carry a timestamp. A row with no timestamp is appended, never prepended.
    const at = messageTime(row)
    let insertAt = next.length
    if (at !== null) {
      insertAt = 0
      for (let index = 0; index < next.length; index++) {
        const other = messageTime(next[index])
        // A local-only message (the live tail) is not a place to insert in
        // front of: a saved row lands after it, never above the reply the
        // person is watching.
        if (other === null) {
          insertAt = index + 1
          continue
        }
        if (other > at) break
        insertAt = index + 1
      }
    }
    next.splice(insertAt, 0, row)
    rebuildIndex()
  }

  return next
}

/**
 * Sort a page of saved rows, oldest first.
 *
 * Only for lists that are server rows only (the first page, a page of older
 * messages): a message with no timestamp is kept, at the end, rather than
 * being sorted to the top where it would take the first prompt's place.
 */
export function sortTranscriptRows<T extends TranscriptMessage>(
  rows: readonly T[],
): T[] {
  const timed: T[] = []
  const untimed: T[] = []
  for (const row of rows) (messageTime(row) === null ? untimed : timed).push(row)
  timed.sort((a, b) => (messageTime(a) as number) - (messageTime(b) as number))
  return [...timed, ...untimed]
}
