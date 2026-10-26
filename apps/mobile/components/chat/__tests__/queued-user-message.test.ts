// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import type { UIMessage } from "ai"
import {
  appendQueuedUserMessage,
  appendQueuedUserMessages,
  canAttachQueuedTurn,
  queuedRowToUserMessage,
} from "../queued-user-message"
import { groupMessagesIntoTurns } from "../turns/useTurnGrouping"

const assistant = (id: string, text: string): UIMessage => ({ id, role: "assistant", parts: [{ type: "text", text }] }) as UIMessage
const user = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage

describe("queuedRowToUserMessage", () => {
  test("uses the row id so a reload dedupes against the saved message", () => {
    const msg = queuedRowToUserMessage({ id: "row-1", content: "hello", parts: JSON.stringify([{ type: "text", text: "hello" }]) })
    expect(msg).toEqual({ id: "row-1", role: "user", parts: [{ type: "text", text: "hello" }] })
  })

  test("keeps attachments from the saved parts", () => {
    const parts = [{ type: "text", text: "see" }, { type: "file", mediaType: "image/png", url: "data:image/png;base64,AA" }]
    expect(queuedRowToUserMessage({ id: "r", content: "see", parts: JSON.stringify(parts) }).parts).toEqual(parts as any)
  })

  test("falls back to the content when parts are missing or unreadable", () => {
    const expected = [{ type: "text", text: "plain" }]
    expect(queuedRowToUserMessage({ id: "r", content: "plain" }).parts).toEqual(expected as any)
    expect(queuedRowToUserMessage({ id: "r", content: "plain", parts: "not json" }).parts).toEqual(expected as any)
    expect(queuedRowToUserMessage({ id: "r", content: "plain", parts: "[]" }).parts).toEqual(expected as any)
  })
})

describe("appendQueuedUserMessage", () => {
  test("appends once and is a no-op when the message is already there", () => {
    const base = [user("u1", "lead"), assistant("a1", "reply")]
    const queued = user("q1", "queued")
    const once = appendQueuedUserMessage(base, queued)
    expect(once.map((m) => m.id)).toEqual(["u1", "a1", "q1"])
    expect(appendQueuedUserMessage(once, queued)).toBe(once)
  })
})

describe("appendQueuedUserMessages", () => {
  test("appends the messages the server has not saved yet, in send order", () => {
    const messages = [user("u1", "lead"), assistant("a1", "reply")]
    const pending = [user("q1", "first queued"), user("q2", "second queued")]
    expect(appendQueuedUserMessages(messages, pending).map((m) => m.id)).toEqual([
      "u1",
      "a1",
      "q1",
      "q2",
    ])
  })

  test("keeps the queued bubbles a history reload dropped, and skips ones history saved", () => {
    // The reload replaces the transcript with what the server has: the head of
    // the queue has been saved (q1), the rest have not.
    const reloaded = [user("u1", "lead"), assistant("a1", "reply"), user("q1", "first queued")]
    const rows = [user("q1", "first queued"), user("q2", "second queued")]
    expect(appendQueuedUserMessages(reloaded, rows).map((m) => m.id)).toEqual([
      "u1",
      "a1",
      "q1",
      "q2",
    ])
  })

  test("is a no-op with nothing pending", () => {
    const messages = [user("u1", "lead")]
    expect(appendQueuedUserMessages(messages, [])).toBe(messages)
  })
})

describe("canAttachQueuedTurn", () => {
  test("attaches when the queued message is the last thing on screen", () => {
    const messages = [user("u1", "lead"), assistant("a1", "reply"), user("q1", "queued")]
    expect(canAttachQueuedTurn(messages, user("q1", "queued"))).toBe(true)
  })

  test("reloads when something landed after it", () => {
    const messages = [user("q1", "queued"), assistant("a1", "reply")]
    expect(canAttachQueuedTurn(messages, user("q1", "queued"))).toBe(false)
  })

  test("reloads when it is not on screen at all", () => {
    expect(canAttachQueuedTurn([user("u1", "lead")], user("q1", "queued"))).toBe(false)
  })
})

describe("queued turns on screen", () => {
  test("without the user message, queued replies overwrite each other", () => {
    const messages = [user("u1", "lead"), assistant("a1", "reply 1"), assistant("a2", "reply 2"), assistant("a3", "reply 3")]
    const turns = groupMessagesIntoTurns(messages, false, undefined, undefined)
    expect(turns).toHaveLength(1) // the bug: only "reply 3" survives
  })

  test("with the user messages added, every queued turn shows its own reply", () => {
    let messages: UIMessage[] = [user("u1", "lead"), assistant("a1", "reply 1")]
    for (const n of [2, 3]) {
      messages = appendQueuedUserMessage(messages, queuedRowToUserMessage({ id: `q${n}`, content: `queued ${n}` }))
      messages = [...messages, assistant(`a${n}`, `reply ${n}`)]
    }
    const turns = groupMessagesIntoTurns(messages, false, undefined, undefined)
    expect(turns).toHaveLength(3)
    expect(turns.map((t) => t.assistantMessage?.id)).toEqual(["a1", "a2", "a3"])
    expect(turns.map((t) => t.userMessage?.id)).toEqual(["u1", "q2", "q3"])
  })
})
