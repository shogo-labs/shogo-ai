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
import {
  findRemovedReplies,
  resolveHistoryPaint,
  resolveLiveTurnAttach,
  type PaintableMessage,
} from "../history-paint"
import { groupMessagesIntoTurns } from "../turns/useTurnGrouping"

const user = (id: string): PaintableMessage => ({ id, role: "user" })
const reply = (id: string): PaintableMessage => ({ id, role: "assistant", content: "reply" })
/** The empty bubble the panel opens for a stream that has produced nothing yet. */
const placeholder = (id: string): PaintableMessage => ({
  id,
  role: "assistant",
  content: "",
  parts: [],
})

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

  test("does not count an empty assistant bubble as a reply", () => {
    // A reload paints the device copy, which still carries the empty bubble the
    // panel opened for a stream that never filled in. Counting it would make
    // history look behind by a reply it already holds, and the paint — the only
    // thing that can bring the reopened window up to date — would be refused
    // forever (SHO-260).
    const history = [user("u1"), reply("srv-a1")]
    const current = [user("u1"), reply("srv-a1"), placeholder("sdk-a2")]

    const paint = resolveHistoryPaint({ history, current, keepsLiveTail: true })

    expect(paint.keptLiveTail).toBe(false)
    expect(paint.messages).toBe(history as unknown as readonly PaintableMessage[])
  })

  test("paints history over the empty bubbles a reload leaves behind", () => {
    // The reopen from the failing chat-resume spec: the screen is a mid-stream
    // device copy (a synthetic reply plus the placeholder opened for the queued
    // turn's stream), and history holds the finished reply and the prompt the
    // queued turn belongs to.
    const history = [user("u1"), reply("srv-a1"), user("u2")]
    const current = [
      user("u1"),
      reply("sdk-a1"),
      placeholder("sdk-a2"),
      placeholder("sdk-a3"),
    ]

    const paint = resolveHistoryPaint({ history, current, keepsLiveTail: false })

    expect(paint.keptLiveTail).toBe(false)
    expect(paint.reason).toBe("history-has-newer-prompt")
    // history's own reply for turn 1 wins, and the queued prompt is on screen so
    // its turn can attach a stream.
    expect((paint.messages as readonly PaintableMessage[]).map((m) => m.id)).toEqual([
      "u1",
      "srv-a1",
      "u2",
    ])
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

  describe("history is the newest page of a longer chat (SHO-483)", () => {
    // 30 turns on screen (60 rows) after the person scrolled up; the reload
    // brings back only the newest 50 rows.
    const turns = (from: number, to: number): PaintableMessage[] => {
      const rows: PaintableMessage[] = []
      for (let n = from; n <= to; n += 1) rows.push(user(`u${n}`), reply(`a${n}`))
      return rows
    }

    test("paints a reply written elsewhere instead of refusing as history-behind", () => {
      const current = turns(1, 30)
      const history = [...turns(6, 30), user("u31"), reply("a31")].slice(-50)

      const paint = resolveHistoryPaint({ history, current, keepsLiveTail: false })

      expect(paint.keptLiveTail).toBe(false)
      const ids = (paint.messages as readonly PaintableMessage[]).map((m) => m.id)
      // Older rows the page does not cover stay above it, and the new turn lands.
      expect(ids[0]).toBe("u1")
      expect(ids.slice(-2)).toEqual(["u31", "a31"])
      expect(new Set(ids).size).toBe(ids.length)
    })

    test("a same-length page with nothing new is a plain paint, not a refusal", () => {
      const current = turns(1, 30)
      const history = current.slice(-50)

      const paint = resolveHistoryPaint({ history, current, keepsLiveTail: false })

      expect(paint.keptLiveTail).toBe(false)
      expect(paint.reason).toBe("history-has-reply")
      expect((paint.messages as readonly PaintableMessage[]).length).toBe(60)
    })

    test("still keeps a live reply the server has not written", () => {
      const current = [...turns(1, 30), user("u31"), reply("live-a31")]
      const history = [...turns(1, 30), user("u31")].slice(-50)

      const paint = resolveHistoryPaint({ history, current, keepsLiveTail: true })

      expect(paint.keptLiveTail).toBe(true)
      expect(paint.messages).toBe(current)
    })
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

// SHO-328: the reply vanished on the desktop at turn end while
// `chat_history_paint_dropped_reply` reported the *refusal*, so the guard was not
// the thing that lost it. These lock down the two halves the card named: the
// alignment that made a 50-row page against a 55-row screen look `history-behind`
// forever, and the invariant that reports a paint which deletes a reply.
describe("a page whose ids the screen has not adopted (SHO-328)", () => {
  /** Oldest-first screen/page of `turns` turns, with an id prefix per source. */
  const ordered = (prefix: string, from: number, to: number): PaintableMessage[] => {
    const rows: PaintableMessage[] = []
    for (let n = from; n <= to; n += 1) {
      rows.push({ id: `${prefix}-u${n}`, role: "user" })
      rows.push({ id: `${prefix}-a${n}`, role: "assistant", content: `reply ${n}` })
    }
    return rows
  }

  test("paints the page and keeps the older pages above it", () => {
    // 30 turns on screen (60 rows) from scrolling up; the newest page is 25
    // turns, and not one of its ids is on screen (temp/SDK ids, SHO-260).
    const current = ordered("screen", 1, 30)
    const history = ordered("server", 6, 30)

    const paint = resolveHistoryPaint({ history, current, keepsLiveTail: true })

    expect(paint.keptLiveTail, "the page is not 'behind' a screen it covers").toBe(false)
    const ids = (paint.messages as readonly PaintableMessage[]).map((message) => message.id)
    // Rows the page does not cover stay above it; the page lands under them once.
    expect(ids.slice(0, 10)).toEqual(ordered("screen", 1, 5).map((message) => message.id))
    expect(ids.slice(-1)).toEqual(["server-a30"])
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("paints the page's reply instead of refusing as history-behind", () => {
    // The Sentry shape (historyRows 50, screenRows 55+) with the page holding the
    // reply and the screen streaming it under an id nobody adopted yet. The reply
    // counts then differ by one on every pass, so counting alone refused forever.
    const current = [
      ...ordered("screen", 1, 27),
      { id: "screen-u28", role: "user" },
      { id: "sdk-a28", role: "assistant", content: "reply 28" },
    ]
    const history = [
      ...ordered("server", 4, 27),
      { id: "server-u28", role: "user" },
      { id: "server-a28", role: "assistant", content: "reply 28" },
    ]

    const paint = resolveHistoryPaint({ history, current, keepsLiveTail: true })

    expect(paint.keptLiveTail, "the page holds the reply, so painting it is safe").toBe(false)
    const ids = (paint.messages as readonly PaintableMessage[]).map((message) => message.id)
    // The older rows above the page stay, and the page's row replaces the live one.
    expect(ids).toHaveLength(56)
    expect(ids.slice(0, 6)).toEqual(ordered("screen", 1, 3).map((message) => message.id))
    expect(ids.slice(-1)).toEqual(["server-a28"])
  })

  test("keeps a live reply whose prompt the page has not answered yet", () => {
    // Two turns on screen under SDK ids; the page has both prompts and only the
    // first reply. The second reply exists on screen only, and the window aligns
    // past the first prompt — counting prompts over the window alone would make
    // the reply look like it answers the wrong turn.
    const current: PaintableMessage[] = [
      { id: "screen-u1", role: "user" },
      { id: "sdk-a1", role: "assistant", content: "reply one" },
      { id: "screen-u2", role: "user" },
      { id: "sdk-a2", role: "assistant", content: "reply two" },
    ]
    const history: PaintableMessage[] = [
      { id: "server-u1", role: "user" },
      { id: "server-a1", role: "assistant", content: "reply one" },
      { id: "server-u2", role: "user" },
    ]

    const paint = resolveHistoryPaint({ history, current, keepsLiveTail: true })

    expect(paint.keptLiveTail).toBe(true)
    expect(paint.messages).toBe(current as unknown as readonly PaintableMessage[])
  })
})

describe("findRemovedReplies", () => {
  const promptRow = (id: string): PaintableMessage => ({ id, role: "user", content: "prompt" })
  const savedRow = (id: string, text = "the answer"): PaintableMessage => ({
    id,
    role: "assistant",
    content: text,
    parts: [{ type: "text", text }],
  })
  const liveRow = (id: string, text = "the answer"): PaintableMessage => ({
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
  })

  test("nothing is lost when the saved row keeps the id", () => {
    expect(
      findRemovedReplies([promptRow("u1"), liveRow("a1")], [promptRow("u1"), savedRow("a1")]),
    ).toEqual([])
  })

  test("nothing is lost when the reply is adopted under the server's id", () => {
    // The happy path: the transcript swaps the SDK id for the row id and the
    // text is unchanged, so this is a paint, not a vanish.
    expect(
      findRemovedReplies([promptRow("u1"), liveRow("sdk-a1")], [promptRow("u1"), savedRow("row-a1")]),
    ).toEqual([])
  })

  test("reports the reply a page that is behind the screen deletes", () => {
    // The reported symptom: the paint lands on the prompt the reply answered.
    const removed = findRemovedReplies([promptRow("u1"), liveRow("sdk-a1")], [promptRow("u1")])

    expect(removed.map((entry) => entry.id)).toEqual(["sdk-a1"])
    expect(removed[0].contentLength).toBe("the answer".length)
  })

  test("a swapped or regenerated answer is not a lost reply", () => {
    // Same number of replies: the id changed, the answer changed, the count did
    // not. Reporting this would flag every adoption and every regenerate.
    expect(
      findRemovedReplies(
        [promptRow("u1"), liveRow("sdk-a1", "old answer")],
        [promptRow("u1"), savedRow("row-a1", "regenerated answer")],
      ),
    ).toEqual([])
  })

  test("reports only the replies a shorter transcript drops", () => {
    // Two replies on screen, one painted: the newest one is the loss.
    const removed = findRemovedReplies(
      [promptRow("u1"), savedRow("a1", "first answer"), promptRow("u2"), liveRow("sdk-a2", "second answer")],
      [promptRow("u1"), savedRow("a1", "first answer")],
    )

    expect(removed.map((entry) => entry.id)).toEqual(["sdk-a2"])
  })

  test("does not count the empty bubble a turn opens with", () => {
    // Same rule as the paint decision (SHO-260): an empty assistant bubble is
    // not a reply anyone can lose.
    expect(
      findRemovedReplies(
        [promptRow("u1"), { id: "sdk-a1", role: "assistant", content: "", parts: [] }],
        [promptRow("u1")],
      ),
    ).toEqual([])
  })
})
