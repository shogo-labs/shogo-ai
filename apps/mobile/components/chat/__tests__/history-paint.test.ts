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
import { resolveHistoryPaint, resolveLiveTurnAttach, type PaintableMessage } from "../history-paint"
import { groupMessagesIntoTurns } from "../turns/useTurnGrouping"

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

  // SHO-147: a turn that started right after this panel's own — a team-chat
  // tag, a `[Task update]` wake, a queued row — has already written its user
  // row. Refusing this paint (the `streamed-turn` rule) left that prompt off
  // screen while the panel attached to the new stream anyway, and the reply
  // landed in the previous reply's bubble.
  test("paints a prompt newer than the screen instead of holding the live tail", () => {
    const history = [user("u1"), reply("srv-a1"), user("u2")]
    const current = [user("u1"), reply("sdk-a1")]

    const paint = resolveHistoryPaint({ history, current, keepsLiveTail: true })

    expect(paint.keptLiveTail).toBe(false)
    expect(paint.reason).toBe("history-has-newer-prompt")
    expect(paint.carriedLiveReply).toBe(false)
    expect(paint.messages).toEqual(history)
  })

  test("splices a still-unsaved reply in front of the newer prompt", () => {
    // The reply exists only on screen: history stops on the next prompt. Both
    // halves have to survive — the reply must not be lost to the paint, and the
    // prompt must not be lost to the refusal.
    const history = [user("u1"), user("u2")]
    const current = [user("u1"), reply("sdk-a1")]

    const paint = resolveHistoryPaint({ history, current, keepsLiveTail: true })

    expect(paint.keptLiveTail).toBe(false)
    expect(paint.reason).toBe("history-has-newer-prompt")
    expect(paint.carriedLiveReply).toBe(true)
    expect(paint.messages.map((message) => message.id)).toEqual(["u1", "sdk-a1", "u2"])
  })

  test("keeps a live tail the newer prompt does not belong to", () => {
    // Optimistic echo: the saved id of the last prompt differs from the one on
    // screen, so only counting prompts can tell which turn the live reply is.
    const history = [
      user("u1"),
      reply("a1"),
      user("u2-server"),
      user("u3"),
    ]
    const current = [user("u1"), reply("a1"), user("u2-local"), reply("sdk-a2")]

    const paint = resolveHistoryPaint({ history, current, keepsLiveTail: true })

    expect(paint.reason).toBe("history-has-newer-prompt")
    expect(paint.carriedLiveReply).toBe(true)
    expect(paint.messages.map((message) => message.id)).toEqual([
      "u1",
      "a1",
      "u2-server",
      "sdk-a2",
      "u3",
    ])
  })

  test("never splices a reply history already holds", () => {
    const history = [user("u1"), reply("srv-a1"), user("u2")]
    const current = [user("u1"), reply("sdk-a1"), reply("trailing-live")]

    const paint = resolveHistoryPaint({ history, current, keepsLiveTail: true })

    expect(paint.carriedLiveReply).toBe(false)
    expect(paint.messages).toEqual(history)
  })

  test("never splices when the saved reply landed after the newer prompt", () => {
    // Rows are ordered by creation time and a reply is written after its stream
    // ends, so a fast turn can leave the reply after the next prompt. Splitting
    // the answer in two would be worse than showing the saved order.
    const history = [user("u1"), user("u2"), reply("srv-a1")]
    const current = [user("u1"), reply("sdk-a1")]

    const paint = resolveHistoryPaint({ history, current, keepsLiveTail: true })

    expect(paint.carriedLiveReply).toBe(false)
    expect(paint.messages).toEqual(history)
  })

  test("keeps the spliced reply through the next load, before the server writes it", () => {
    // Right after the splice a reload can land while reply 1 is still unsaved:
    // the tail is prompt 2, and painting would drop reply 1 from the screen.
    const history = [user("u1"), user("u2")]
    const current = [user("u1"), reply("sdk-a1"), user("u2")]

    const paint = resolveHistoryPaint({ history, current, keepsLiveTail: true })

    expect(paint.keptLiveTail).toBe(true)
    expect(paint.reason).toBe("history-behind")
    expect(paint.messages).toBe(current as unknown as readonly PaintableMessage[])
  })

  test("hands the spliced reply back to history once it is saved", () => {
    const history = [user("u1"), reply("srv-a1"), user("u2")]
    const current = [user("u1"), reply("sdk-a1"), user("u2")]

    const paint = resolveHistoryPaint({ history, current, keepsLiveTail: true })

    expect(paint.keptLiveTail).toBe(false)
    expect(paint.carriedLiveReply).toBe(false)
    expect(paint.messages).toBe(history as unknown as readonly PaintableMessage[])
  })

  test("still paints a prompt-answered-elsewhere transcript with no live reply", () => {
    const history = [user("u1"), reply("a1")]
    const current = [user("u1")]

    const paint = resolveHistoryPaint({ history, current, keepsLiveTail: true })

    expect(paint.keptLiveTail).toBe(false)
    expect(paint.reason).toBe("tail-not-a-reply")
  })
})

describe("resolveLiveTurnAttach", () => {
  test("refuses to attach while history holds a prompt the screen never showed", () => {
    // The exact SHO-147 window: reply 1 is on screen, prompt 2 is only in
    // history, and the probe just found prompt 2's live turn. Attaching here
    // streams reply 2 straight after reply 1, and the grouping gives reply 2
    // reply 1's bubble.
    const screen = [user("u1"), reply("a1")]
    const history = [user("u1"), reply("a1"), user("u2")]

    const gate = resolveLiveTurnAttach({ screen, history })

    expect(gate.attach).toBe(false)
    expect(gate.reason).toBe("history-has-newer-prompt")
  })

  test("refuses when the reply is not saved yet either", () => {
    const gate = resolveLiveTurnAttach({
      screen: [user("u1"), reply("sdk-a1")],
      history: [user("u1"), user("u2")],
    })

    expect(gate.attach).toBe(false)
    expect(gate.reason).toBe("history-has-newer-prompt")
  })

  test("attaches once the missing prompt is on screen", () => {
    // What the paint in the same window produces: the turn's own user row is
    // the screen's tail, so its reply belongs at the end.
    const gate = resolveLiveTurnAttach({
      screen: [user("u1"), reply("a1"), user("u2")],
      history: [user("u1"), reply("a1"), user("u2")],
    })

    expect(gate.attach).toBe(true)
    expect(gate.reason).toBe("screen-ends-on-prompt")
  })

  test("attaches when this window is streaming the reply it ends on", () => {
    // A refocus mid-turn: the reply is on screen and history adds no prompt.
    const gate = resolveLiveTurnAttach({
      screen: [user("u1"), reply("partial-a1")],
      history: [user("u1")],
    })

    expect(gate.attach).toBe(true)
    expect(gate.reason).toBe("screen-streams-this-turn")
  })

  test("attaches into an empty screen", () => {
    const gate = resolveLiveTurnAttach({ screen: [], history: [user("u1")] })

    expect(gate.attach).toBe(true)
    expect(gate.reason).toBe("nothing-on-screen")
  })
})

/**
 * The user-visible half of SHO-147, on the grouping the panel renders: the
 * transcript groups one assistant per turn, so a second reply with no prompt
 * between them takes the first reply's bubble. That is why the fix keeps the
 * prompt on screen rather than touching the grouping.
 */
describe("the transcript the paint produces", () => {
  const ui = (id: string, role: "user" | "assistant", text: string) =>
    ({ id, role, parts: [{ type: "text", text }] }) as any

  test("two turns, with the first reply unchanged", () => {
    const paint = resolveHistoryPaint({
      history: [ui("u1", "user", "one"), ui("u2", "user", "two")],
      current: [ui("u1", "user", "one"), ui("sdk-a1", "assistant", "reply one")],
      keepsLiveTail: true,
    })

    // The new turn's stream appends its reply to what is on screen.
    const turns = groupMessagesIntoTurns(
      [...(paint.messages as any[]), ui("sdk-a2", "assistant", "reply two")],
      false,
      undefined,
      undefined,
    )

    expect(turns.map((turn: any) => [turn.userMessage?.id, turn.assistantMessage?.id])).toEqual([
      ["u1", "sdk-a1"],
      ["u2", "sdk-a2"],
    ])
  })

  test("without the paint, the second reply takes the first one's bubble", () => {
    const turns = groupMessagesIntoTurns(
      [
        ui("u1", "user", "one"),
        ui("sdk-a1", "assistant", "reply one"),
        ui("sdk-a2", "assistant", "reply two"),
      ],
      false,
      undefined,
      undefined,
    )

    expect(turns).toHaveLength(1)
    expect(turns[0].assistantMessage?.id).toBe("sdk-a2")
  })
})
