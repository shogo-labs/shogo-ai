// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the rejoin view (SHO-297).
 *
 * Headline regression locked down here (must not come back):
 *
 *   A chat reopened while its turn is still running paints the half-written
 *   reply from when the person left and shows nothing that says the turn is
 *   live, so the chat looks frozen until the resume snapshot lands.
 *
 * Run: bun test apps/mobile/components/chat/__tests__/rejoin-view.test.ts
 */

import { describe, expect, test } from "bun:test"
import type { UIMessage } from "ai"
import { resolveRejoinView } from "../rejoin-view"
import { TURN_INTERRUPTED_PART_TYPE } from "../resume-replay-transport"
import { TURN_STOPPED_PART_TYPE } from "../stopped-turn"

const user = (id: string, text = "prompt"): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as unknown as UIMessage

/** A reply the runtime has not closed: no completion frame, no timing row. */
const unfinished = (id: string, text = "old-words"): UIMessage =>
  ({ id, role: "assistant", parts: [{ type: "text", text }] }) as unknown as UIMessage

const finished = (id: string, text = "done"): UIMessage =>
  ({
    id,
    role: "assistant",
    parts: [
      { type: "text", text },
      { type: "data-turn-complete", data: {} },
    ],
  }) as unknown as UIMessage

const stopped = (id: string, text = "stopped-words"): UIMessage =>
  ({
    id,
    role: "assistant",
    parts: [
      { type: "text", text },
      { type: TURN_STOPPED_PART_TYPE, data: {} },
    ],
  }) as unknown as UIMessage

const interrupted = (id: string, text = "crashed-words"): UIMessage =>
  ({
    id,
    role: "assistant",
    parts: [
      { type: "text", text },
      { type: TURN_INTERRUPTED_PART_TYPE, data: {} },
    ],
  }) as unknown as UIMessage

describe("resolveRejoinView", () => {
  test("hides the stale half-written reply and shows the row", () => {
    const messages = [user("u1"), unfinished("a1")]

    const view = resolveRejoinView({ messages, rejoining: true })

    expect(view.showRejoinRow).toBe(true)
    expect(view.messages).toEqual([user("u1")])
  })

  test("leaves the transcript alone when not rejoining", () => {
    const messages = [user("u1"), unfinished("a1")]

    const view = resolveRejoinView({ messages, rejoining: false })

    expect(view.showRejoinRow).toBe(false)
    expect(view.messages).toBe(messages)
  })

  test("a finished turn is never hidden", () => {
    const messages = [user("u1"), finished("a1")]

    const view = resolveRejoinView({ messages, rejoining: true })

    expect(view.showRejoinRow).toBe(true)
    expect(view.messages).toBe(messages)
  })

  test("a stopped reply is not a rejoining tail", () => {
    const messages = [user("u1"), stopped("a1")]

    const view = resolveRejoinView({ messages, rejoining: true })

    expect(view.showRejoinRow).toBe(true)
    expect(view.messages).toBe(messages)
  })

  test("a turn the server declared dead is not a rejoining tail", () => {
    const messages = [user("u1"), interrupted("a1")]

    const view = resolveRejoinView({ messages, rejoining: true })

    expect(view.showRejoinRow).toBe(true)
    expect(view.messages).toBe(messages)
  })

  test("a transcript that ends on a prompt keeps it", () => {
    const messages = [user("u1"), finished("a1"), user("u2")]

    const view = resolveRejoinView({ messages, rejoining: true })

    expect(view.showRejoinRow).toBe(true)
    expect(view.messages).toBe(messages)
  })

  test("an empty transcript still shows the row", () => {
    const view = resolveRejoinView({ messages: [], rejoining: true })

    expect(view.showRejoinRow).toBe(true)
    expect(view.messages).toEqual([])
  })

  test("only the trailing unfinished reply is dropped", () => {
    const messages = [user("u1"), unfinished("a1"), user("u2"), unfinished("a2")]

    const view = resolveRejoinView({ messages, rejoining: true })

    expect(view.showRejoinRow).toBe(true)
    expect(view.messages).toEqual([user("u1"), unfinished("a1"), user("u2")])
  })

  test("never mutates the array it was given", () => {
    const messages = [user("u1"), unfinished("a1")]

    resolveRejoinView({ messages, rejoining: true })

    expect(messages).toHaveLength(2)
  })
})
