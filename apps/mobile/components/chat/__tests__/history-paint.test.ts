// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the paint boundary in the chat transcript (SHO-85).
 *
 * Headline regression locked down here (must not come back):
 *
 *   A reply streams in and finishes, the client revalidates `/chat-messages`
 *   before the API has written the assistant row (it is written after the
 *   stream EOFs + billing close), and the paint replaces the transcript with
 *   rows that end on the user's prompt. The reply vanishes from the screen and
 *   nothing repairs it until the chat is reopened.
 *
 * Run: bun test apps/mobile/components/chat/__tests__/history-paint.test.ts
 */

import { describe, expect, test } from "bun:test"
import { resolveHistoryPaint, type PaintableMessage } from "../history-paint"

const user = (id: string): PaintableMessage => ({ id, role: "user" })
const reply = (id: string): PaintableMessage => ({ id, role: "assistant" })

describe("resolveHistoryPaint", () => {
  test("keeps the reply when history ends on the prompt that produced it", () => {
    const history = [user("u1")]
    const current = [user("u1"), reply("live-reply")]

    const paint = resolveHistoryPaint({ history, current, keepsLiveTail: true })

    expect(paint.keptLiveTail).toBe(true)
    expect(paint.reason).toBe("streamed-turn")
    // The live screen is the answer: same array, so the caller's setMessages
    // can be skipped on reference equality.
    expect(paint.messages).toBe(current as unknown as readonly PaintableMessage[])
  })

  test("paints history once it contains the reply", () => {
    const history = [user("u1"), reply("server-reply")]
    const current = [user("u1"), reply("live-reply")]

    const paint = resolveHistoryPaint({ history, current, keepsLiveTail: true })

    expect(paint.keptLiveTail).toBe(false)
    expect(paint.messages).toBe(history as unknown as readonly PaintableMessage[])
  })

  test("keeps the live reply even with the flag unset when history is behind by a reply", () => {
    // A window that joined the turn: it never ran `onFinish` for its own send,
    // and history still stops on the previous turn's reply — so it is missing
    // both this turn's prompt and reply.
    const history = [user("u1"), reply("a1")]
    const current = [user("u1"), reply("a1"), user("u2"), reply("live-a2")]

    const paint = resolveHistoryPaint({ history, current, keepsLiveTail: false })

    expect(paint.keptLiveTail).toBe(true)
    expect(paint.reason).toBe("history-behind")
  })

  test("no-op when the tails already agree", () => {
    const history = [user("u1"), reply("a1")]
    const current = [user("u1"), reply("a1")]

    const paint = resolveHistoryPaint({ history, current, keepsLiveTail: false })

    expect(paint.keptLiveTail).toBe(false)
    expect(paint.reason).toBe("history-has-reply")
    expect(paint.messages).toBe(history as unknown as readonly PaintableMessage[])
  })

  test("paints a reply written elsewhere over a transcript that ends on the prompt", () => {
    // SHO-31/SHO-53: another window's turn finished. Our screen has no reply,
    // history has one — painting it is the whole point of the reload.
    const history = [user("u1"), reply("a1")]
    const current = [user("u1")]

    const paint = resolveHistoryPaint({ history, current, keepsLiveTail: false })

    expect(paint.keptLiveTail).toBe(false)
    expect(paint.messages).toBe(history as unknown as readonly PaintableMessage[])
  })

  test("paints a newer prompt after the live reply (the screen is not ahead)", () => {
    // The prompt was answered somewhere else and is newer than what we have on
    // screen; the reply for it is picked up by the late-turn probe.
    const history = [user("u1"), reply("a1"), user("u2")]
    const current = [user("u1"), reply("a1")]

    const paint = resolveHistoryPaint({ history, current, keepsLiveTail: false })

    expect(paint.keptLiveTail).toBe(false)
  })

  test("never wipes a live transcript because a load came back empty", () => {
    const current = [user("u1"), reply("live-reply")]

    const paint = resolveHistoryPaint({ history: [], current, keepsLiveTail: false })

    expect(paint.keptLiveTail).toBe(true)
    expect(paint.messages).toBe(current as unknown as readonly PaintableMessage[])
  })

  test("an empty screen and an empty load is a plain no-op", () => {
    const paint = resolveHistoryPaint({ history: [], current: [], keepsLiveTail: true })

    expect(paint.keptLiveTail).toBe(false)
    expect(paint.messages).toEqual([])
  })

  test("a trailing user row on screen is never held back", () => {
    const history = [user("u1")]
    const current = [user("u1")]

    const paint = resolveHistoryPaint({ history, current, keepsLiveTail: true })

    expect(paint.keptLiveTail).toBe(false)
    expect(paint.reason).toBe("tail-not-a-reply")
  })

  test("adopts a regenerated reply instead of holding the old copy", () => {
    // A regenerate in this window: the server row is a different id with the
    // same count, so counting replies must not hold a stale copy forever.
    const history = [user("u1"), reply("a1-regenerated")]
    const current = [user("u1"), reply("a1-original")]

    const paint = resolveHistoryPaint({ history, current, keepsLiveTail: true })

    expect(paint.keptLiveTail).toBe(false)
    expect(paint.messages).toBe(history as unknown as readonly PaintableMessage[])
  })
})
