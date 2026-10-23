// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import type { UIMessage } from "ai"
import {
  appendOptimisticEcho,
  buildOptimisticUserMessage,
  hasMatchingUserMessage,
  OPTIMISTIC_ECHO_ID,
  newestUserId,
  stampSendTime,
  type OptimisticEchoInput,
} from "../optimistic-echo"

const user = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage
const assistant = (id: string, text: string): UIMessage =>
  ({ id, role: "assistant", parts: [{ type: "text", text }] }) as UIMessage

const echo = (content: string, baselineUserId: string | null): OptimisticEchoInput => ({
  sessionId: "s1",
  content,
  baselineUserId,
})

describe("buildOptimisticUserMessage", () => {
  test("is a user message with the trimmed text and the pending id", () => {
    const message = buildOptimisticUserMessage(echo("  hello  ", null))
    expect(message.id).toBe(OPTIMISTIC_ECHO_ID)
    expect(message.role).toBe("user")
    expect(message.parts).toEqual([{ type: "text", text: "hello" }] as any)
  })

  test("carries the send time, so time-windowed reads have an anchor", () => {
    // Chat tags read their delivery state from this bubble's `createdAt`
    // (ChatPanel passes it as `since`); without it a just-sent tag has no
    // window and shows no state at all until the server's row lands.
    const before = Date.now()
    const message = buildOptimisticUserMessage(echo("hello", null)) as any
    expect(typeof message.createdAt).toBe("number")
    expect(message.createdAt).toBeGreaterThanOrEqual(before)
  })

  test("uses the send time it is handed, so a rebuild cannot drift the window", () => {
    const message = buildOptimisticUserMessage({ ...echo("hello", null), sentAt: 1_700_000_000_000 }) as any
    expect(message.createdAt).toBe(1_700_000_000_000)
  })

  test("carries attachments as file parts", () => {
    const message = buildOptimisticUserMessage({
      sessionId: "s1",
      content: "see",
      files: [{ dataUrl: "data:image/png;base64,AA", name: "a.png", type: "image/png" }],
    })
    expect(message.parts).toEqual([
      { type: "text", text: "see" },
      { type: "file", mediaType: "image/png", url: "data:image/png;base64,AA", name: "a.png" },
    ] as any)
  })
})

describe("appendOptimisticEcho", () => {
  test("appends the echo as the last turn, after the history", () => {
    const history = [user("u1", "first"), assistant("a1", "reply")]
    const messages = appendOptimisticEcho(history, echo("second", "u1"))
    expect(messages.map((m) => m.id)).toEqual(["u1", "a1", OPTIMISTIC_ECHO_ID])
    expect(history).toHaveLength(2)
  })

  test("paints an echo into an empty transcript", () => {
    const messages = appendOptimisticEcho<UIMessage>([], echo("hello", null))
    expect(messages.map((m) => m.id)).toEqual([OPTIMISTIC_ECHO_ID])
  })

  test("is a no-op once the real message has replaced the echo", () => {
    const arrived = [user("u1", "first"), assistant("a1", "reply"), user("u2", "second")]
    const messages = appendOptimisticEcho(arrived, echo("second", "u1"))
    expect(messages).toBe(arrived)
  })

  test("is a no-op when the list already carries the echo (re-render)", () => {
    const once = appendOptimisticEcho([user("u1", "first")], echo("second", "u1"))
    expect(appendOptimisticEcho(once, echo("second", "u1"))).toBe(once)
  })

  test("ignores an empty echo", () => {
    const history = [user("u1", "first")]
    expect(appendOptimisticEcho(history, echo("   ", "u1"))).toBe(history)
    expect(appendOptimisticEcho(history, null)).toBe(history)
  })
})

describe("hasMatchingUserMessage", () => {
  test("matches the text of the newest user message", () => {
    const messages = [user("u1", "first"), assistant("a1", "reply"), user("u2", "second")]
    expect(hasMatchingUserMessage(messages, echo("second", "u1"))).toBe(true)
  })

  test("does not match an earlier user message with the same text", () => {
    // Re-sending "continue" while the previous "continue" is still the newest
    // user message on screen must paint a new bubble, not resolve instantly.
    const messages = [user("u1", "continue"), assistant("a1", "reply")]
    expect(hasMatchingUserMessage(messages, echo("continue", "u1"))).toBe(false)
  })

  test("does not match when the newest user message differs", () => {
    const messages = [user("u1", "first"), assistant("a1", "reply"), user("u2", "second")]
    expect(hasMatchingUserMessage(messages, echo("something else", "u1"))).toBe(false)
  })

  test("does not match a transcript that has no user message yet", () => {
    expect(hasMatchingUserMessage([], echo("hello", null))).toBe(false)
    expect(hasMatchingUserMessage([assistant("a1", "hi")], echo("hello", null))).toBe(false)
  })

  test("matches the newest user message when no baseline is known", () => {
    const messages = [user("u1", "continue"), assistant("a1", "reply"), user("u2", "yes")]
    expect(hasMatchingUserMessage(messages, echo("yes", null))).toBe(true)
  })

  test("an attachment-only echo resolves on the next user message", () => {
    const files = [{ dataUrl: "data:image/png;base64,AA", name: "a.png", type: "image/png" }]
    const input: OptimisticEchoInput = { sessionId: "s1", content: "", files, baselineUserId: "u1" }
    expect(hasMatchingUserMessage([user("u1", "first")], input)).toBe(false)
    expect(hasMatchingUserMessage([user("u1", "first"), assistant("a1", "reply")], input)).toBe(false)
    expect(
      hasMatchingUserMessage(
        [user("u1", "first"), assistant("a1", "reply"), user("u2", "")],
        input,
      ),
    ).toBe(true)
  })
})

describe("newestUserId", () => {
  test("is the last user message, ignoring assistant messages after it", () => {
    expect(newestUserId([user("u1", "a"), assistant("a1", "b"), user("u2", "c"), assistant("a2", "d")])).toBe("u2")
    expect(newestUserId([])).toBeNull()
  })
})

describe("stampSendTime", () => {
  const sent = { content: "second", sentAt: 1_700_000_000_000 }

  test("gives the sent bubble the send time when the SDK's row has none", () => {
    // SHO-85 round 3: keeping the live tail keeps this row, and a chat tag read
    // its `since` off it. Undefined there means no delivery state, ever.
    const messages = [user("u1", "first"), assistant("a1", "reply"), user("u2", "second")]
    const stamped = stampSendTime(messages, sent) as any[]
    expect(stamped[2].createdAt).toBe(sent.sentAt)
    expect(stamped[0]).toBe(messages[0])
    expect(messages[2]).not.toHaveProperty("createdAt")
  })

  test("leaves a bubble that already carries a timestamp alone", () => {
    const persisted = { ...(user("u2", "second") as any), createdAt: "2026-10-20T21:16:46.407Z" }
    const messages = [user("u1", "first"), assistant("a1", "reply"), persisted]
    expect(stampSendTime(messages, sent)).toBe(messages)
  })

  test("is a no-op for a different message than the one that was sent", () => {
    const messages = [user("u1", "first"), assistant("a1", "reply"), user("u2", "unrelated")]
    expect(stampSendTime(messages, sent)).toBe(messages)
  })

  test("is a no-op without a recorded send or on an assistant-only transcript", () => {
    const messages = [assistant("a1", "reply")]
    expect(stampSendTime(messages, null)).toBe(messages)
    expect(stampSendTime(messages, { content: "second" })).toBe(messages)
    expect(stampSendTime(messages, sent)).toBe(messages)
  })

  test("stamps the bubble the echo became, not an older repeat of the same text", () => {
    const messages = [user("u1", "second"), assistant("a1", "reply"), user("u2", "second")]
    const stamped = stampSendTime(messages, sent) as any[]
    expect(stamped[2].createdAt).toBe(sent.sentAt)
    expect(stamped[0]).not.toHaveProperty("createdAt")
  })
})
