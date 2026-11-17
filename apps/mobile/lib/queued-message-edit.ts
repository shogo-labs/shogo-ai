// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The queue decisions `ChatPanel` makes for the window's own queue — the one it
 * drains itself when the chat runs against a local agent (`localAgentUrl`).
 *
 * The server queue has the same behaviour through `collection.update` /
 * the `failed` + EDITING hold; a local row is held by `editingQueuedId` alone,
 * so these are the two places that has to be honoured: the drain must not take
 * the row being edited, and a send while editing must change that row in place
 * rather than append a copy (SHO-356).
 */

export type QueuedEditPatch<T> = Partial<T>

/**
 * Write an edit back into the row it came from: same index, same id, nothing
 * appended. A row that is no longer in the queue (deleted, or already drained
 * on a turn that started before the click) is left alone — the caller's own
 * fallback decides what to do with the text.
 */
export function replaceQueuedMessage<T extends { id: string }>(
  queue: T[],
  id: string | null,
  patch: QueuedEditPatch<T>,
): T[] {
  if (!id) return queue
  if (!queue.some((message) => message.id === id)) return queue
  return queue.map((message) =>
    message.id === id ? { ...message, ...patch } : message,
  )
}

/**
 * The row the drain may send now. The row the composer is editing is not ready
 * (the person is still changing it), so the drain takes the next one; with
 * nothing else queued it sends nothing and the edit keeps its place.
 */
export function nextDrainableMessage<T extends { id: string }>(
  queue: T[],
  editingId: string | null,
): T | undefined {
  return queue.find((message) => message.id !== editingId)
}

/**
 * Whether cancelling an edit has a server hold to release. Only a row the server
 * queue owns has one: a local `queue-…` row is held by this window alone, and
 * releasing it would PATCH an id the server store does not hold — which comes
 * back `Item not found` and paints a red error on a message that is still
 * queued perfectly well.
 */
export function shouldReleaseServerEdit(
  id: string | null,
  isServerQueued: (id: string) => boolean,
): id is string {
  return !!id && isServerQueued(id)
}
