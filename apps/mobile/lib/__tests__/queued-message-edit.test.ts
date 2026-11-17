// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The local queue's side of SHO-356 (AC5): a chat running against a local agent
 * (`localAgentUrl`) keeps its queue in this window, not in the server's
 * `chat_queued_message` table, so none of the server's PATCH/hold machinery
 * applies. Editing must still change the row in place, the drain must still skip
 * the row being edited, and cancelling must not try to release a hold the server
 * never placed — the round-1 bug that painted "Item not found" on a row that was
 * queued perfectly well.
 */

import { describe, expect, test } from "bun:test"
import {
  nextDrainableMessage,
  replaceQueuedMessage,
  shouldReleaseServerEdit,
} from "../queued-message-edit"

type Row = {
  id: string
  content: string
  files?: { name: string }[]
  selectedModel?: string
}

const queue = (): Row[] => [
  { id: "queue-1", content: "first" },
  { id: "queue-2", content: "second" },
  { id: "queue-3", content: "third" },
]

describe("local queue: editing in place", () => {
  test("an edit changes its own row and appends nothing — three rows in, three rows out", () => {
    const edited = replaceQueuedMessage(queue(), "queue-2", {
      content: "second, corrected",
      selectedModel: "a-model",
    })

    expect(edited).toHaveLength(3)
    expect(edited.map((row) => row.id)).toEqual(["queue-1", "queue-2", "queue-3"])
    expect(edited[1]).toEqual({
      id: "queue-2",
      content: "second, corrected",
      selectedModel: "a-model",
    })
  })

  test("an edit that only carries new text keeps the row's other fields", () => {
    const rows = queue()
    rows[0].files = [{ name: "diagram.png" }]

    const edited = replaceQueuedMessage(rows, "queue-1", { content: "first, corrected" })

    expect(edited[0]).toEqual({
      id: "queue-1",
      content: "first, corrected",
      files: [{ name: "diagram.png" }],
    })
  })

  test("a row the person deleted meanwhile is not resurrected by the edit", () => {
    const remaining = queue().filter((row) => row.id !== "queue-2")

    const edited = replaceQueuedMessage(remaining, "queue-2", { content: "second, corrected" })

    expect(edited).toBe(remaining)
    expect(edited.map((row) => row.id)).toEqual(["queue-1", "queue-3"])
  })
})

describe("local queue: the drain while a row is edited", () => {
  test("the row being edited is skipped and the next one runs", () => {
    expect(nextDrainableMessage(queue(), "queue-2")?.id).toBe("queue-1")
    expect(nextDrainableMessage(queue(), "queue-1")?.id).toBe("queue-2")
  })

  test("with nothing else queued the drain sends nothing, so the edit keeps its place", () => {
    const onlyRow = [{ id: "queue-7", content: "the whole queue" }]
    expect(nextDrainableMessage(onlyRow, "queue-7")).toBeUndefined()
  })

  test("with nothing being edited the drain takes the head of the queue", () => {
    expect(nextDrainableMessage(queue(), null)?.id).toBe("queue-1")
  })

  test("a deleted row is never the one the turn-end drain sends", () => {
    const afterDelete = queue().filter((row) => row.id !== "queue-1")
    const sent: string[] = []
    let pending: Row[] = afterDelete
    for (let row = nextDrainableMessage(pending, null); row; row = nextDrainableMessage(pending, null)) {
      sent.push(row.content)
      pending = pending.filter((candidate) => candidate.id !== row.id)
    }

    expect(sent).toEqual(["second", "third"])
  })
})

describe("cancelling an edit", () => {
  const serverIds = new Set(["8f2c-real-server-row"])
  const isServerQueued = (id: string) => serverIds.has(id)

  test("a local `queue-…` row is not released against the server store", () => {
    for (const id of ["queue-1", "queue-1751912345678-ab12cd34e"]) {
      expect(shouldReleaseServerEdit(id, isServerQueued)).toBe(false)
    }
  })

  test("a row the server owns is released, so its hold comes off", () => {
    expect(shouldReleaseServerEdit("8f2c-real-server-row", isServerQueued)).toBe(true)
  })

  test("no edit in progress means nothing to release", () => {
    expect(shouldReleaseServerEdit(null, isServerQueued)).toBe(false)
  })
})
