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
import { rejoinProbeVerdict } from "../rejoin-probe"
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
  test("keeps the reply received so far and shows the row (SHO-366)", () => {
    const messages = [user("u1"), unfinished("a1")]

    const view = resolveRejoinView({ messages, rejoining: true })

    expect(view.showRejoinRow).toBe(true)
    expect(view.messages).toBe(messages)
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

  test("an unfinished tail in the middle is never touched", () => {
    const messages = [user("u1"), unfinished("a1"), user("u2"), unfinished("a2")]

    const view = resolveRejoinView({ messages, rejoining: true })

    expect(view.showRejoinRow).toBe(true)
    expect(view.messages).toBe(messages)
  })

  test("never mutates the array it was given", () => {
    const messages = [user("u1"), unfinished("a1")]

    resolveRejoinView({ messages, rejoining: true })

    expect(messages).toHaveLength(2)
  })
})

/**
 * The post-history `/turn` decision (SHO-297).
 *
 * Regression locked down here (QA found it after the first round): the
 * paint-time probe answers with `drivesRejoin: false`, and the history load
 * reuses that answer instead of calling `probeLiveTurn` again — so the
 * leave-the-row condition inside `probeLiveTurn` never runs for it. A chat
 * whose turn was over, or that the runtime never buffered, kept "Rejoining
 * live reply…" up for the full 8 s timeout with the saved reply hidden behind
 * it. "No live turn and nothing expected" must be a give-up, exactly like a
 * fresh probe.
 */
describe("rejoinProbeVerdict", () => {
  test("a live turn is attached to", () => {
    expect(rejoinProbeVerdict({ live: true, stopped: false, expectedLive: false })).toBe(
      "attach",
    )
  })

  test("a live turn is attached to even when one was expected", () => {
    expect(rejoinProbeVerdict({ live: true, stopped: false, expectedLive: true })).toBe(
      "attach",
    )
  })

  test("no live turn and nothing expected stops rejoining", () => {
    // The blocker: this used to do nothing, so the rejoin row outlived the
    // probe by the whole 8 s timeout and hid the saved reply.
    expect(rejoinProbeVerdict({ live: false, stopped: false, expectedLive: false })).toBe(
      "give-up",
    )
  })

  test("no live turn after a stop this window sent stops rejoining", () => {
    expect(rejoinProbeVerdict({ live: false, stopped: true, expectedLive: true })).toBe(
      "give-up",
    )
  })

  test("a turn that was expected but is not there yet reloads once", () => {
    expect(rejoinProbeVerdict({ live: false, stopped: false, expectedLive: true })).toBe(
      "reload",
    )
  })
})
