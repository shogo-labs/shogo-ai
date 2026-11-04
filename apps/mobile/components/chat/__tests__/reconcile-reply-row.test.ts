// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Which saved row is this turn's reply (SHO-300).
 *
 * The API writes the assistant row partway through a turn, so by the time the
 * turn ends that row can already be on screen. Looking for "an assistant id
 * that was not there before" then finds nothing — every turn ended with the
 * reconcile warning while the reply was saved all along.
 */

import { expect, test } from "bun:test"
import {
  assistantRowsAtSend,
  findTurnReplyRow,
  isReplyForTurn,
  shouldPaintReconciledHistory,
} from "../reconcile-reply-row"

const SESSION = "sess_1"

const row = (id: string, content: string, sessionId = SESSION) => ({
  id,
  role: "assistant" as const,
  sessionId,
  content,
})

const userRow = (id: string, content: string) => ({
  id,
  role: "user" as const,
  sessionId: SESSION,
  content,
})

test("a reply written after the send is found", () => {
  const before = [row("a1", "an older reply")]
  const atSend = assistantRowsAtSend(before, SESSION)

  const now = [...before, row("a2", "the new reply")]
  expect(findTurnReplyRow({ rows: now, sessionId: SESSION, atSend, turnText: "the new reply" })).toBe(
    "a2",
  )
})

test("a reply that was already saved mid-turn is still found", () => {
  const before = [row("a1", "an older reply")]
  const atSend = assistantRowsAtSend(before, SESSION)

  // The runtime saved this turn's row partway through, and the panel already
  // has it: no id is "new", and the row is not in the send-time snapshot.
  const now = [...before, row("a2", "the streamed reply")]
  expect(findTurnReplyRow({ rows: now, sessionId: SESSION, atSend, turnText: "the streamed reply" })).toBe(
    "a2",
  )
})

test("a row written mid-turn that grew into the final text is found", () => {
  const before = [row("a1", "an older reply")]
  const atSend = assistantRowsAtSend([...before, row("a2", "a partial")], SESSION)

  const now = [...before, row("a2", "a partial reply that finished later")]
  expect(
    findTurnReplyRow({
      rows: now,
      sessionId: SESSION,
      atSend,
      turnText: "a partial reply that finished later",
    }),
  ).toBe("a2")
})

test("a stale row is never mistaken for this turn's reply", () => {
  const atSend = assistantRowsAtSend([row("a1", "an older reply")], SESSION)
  expect(
    findTurnReplyRow({
      rows: [row("a1", "an older reply")],
      sessionId: SESSION,
      atSend,
      turnText: "the reply still streaming",
    }),
  ).toBeNull()
})

test("another chat's rows are ignored", () => {
  const atSend = new Map<string, string>()
  expect(
    findTurnReplyRow({
      rows: [row("a1", "someone else's reply", "sess_2"), userRow("u1", "the prompt")],
      sessionId: SESSION,
      atSend,
      turnText: "the reply still streaming",
    }),
  ).toBeNull()
})

test("a partial mid-turn row matches the text that finished it", () => {
  const firstHalf = "The first half of the answer that the runtime saved mid-turn,"
  expect(isReplyForTurn(firstHalf, `${firstHalf} and the rest of it.`)).toBe(true)
  expect(isReplyForTurn("ok", "ok then a much longer answer follows here and keeps going")).toBe(
    false,
  )
})

/**
 * The turn this window is reconciling was not started by it — a queued row the
 * server dispatched, a wake — so `atSend` still describes the previous send and
 * that turn's reply looks new. Picking it made the panel repaint saved history
 * over a reply that had only ever been on screen, and the reply was gone
 * (SHO-325: `chat-send-now-leaves-dock` lost the sent row's answer this way).
 */
test("an earlier turn's reply is not this turn's, even when the snapshot is stale", () => {
  expect(
    findTurnReplyRow({
      rows: [row("a1", "send-now lead reply streaming-mw24ndka")],
      sessionId: SESSION,
      atSend: new Map<string, string>(),
      turnText: "beta reply after send now streaming-mw24ndka",
    }),
  ).toBeNull()
})

test("a turn with no text still finds the row written after the send", () => {
  const atSend = assistantRowsAtSend([row("a1", "the previous turn's reply")], SESSION)
  expect(
    findTurnReplyRow({
      rows: [row("a1", "the previous turn's reply"), row("a2", "done")],
      sessionId: SESSION,
      atSend,
      turnText: "",
    }),
  ).toBe("a2")
})

/**
 * The repaint the reconcile runs replaces the transcript with saved history. It
 * is right for the turn that just ended (SHO-85) and fatal for a newer one —
 * that turn's reply is on screen only until the server writes it, and painting
 * over it deletes it for good (SHO-325: `chat-send-now-leaves-dock`).
 */
test("a newer turn that is streaming stops the older reconcile's paint", () => {
  expect(
    shouldPaintReconciledHistory({
      generationAtReconcile: 4,
      generationNow: 5,
      isStreaming: true,
    }),
  ).toBe(false)
})

test("a newer turn that already finished still stops the older paint", () => {
  // The send-now turn can end before the previous turn's 5 × 400 ms loop does.
  // Its reply is on screen and the server has not written it: painting history
  // here drops it just the same.
  expect(
    shouldPaintReconciledHistory({
      generationAtReconcile: 4,
      generationNow: 5,
      isStreaming: false,
    }),
  ).toBe(false)
})

test("a turn whose reply arrived after its own stream closed still paints", () => {
  // Nothing started since this reconcile began: this is the SHO-85 repaint, and
  // skipping it would bring back the bug the reconcile exists to fix.
  expect(
    shouldPaintReconciledHistory({
      generationAtReconcile: 7,
      generationNow: 7,
      isStreaming: false,
    }),
  ).toBe(true)
})

test("a stream that began without a turn-start frame still stops the paint", () => {
  // `chat-send-now-leaves-dock` mocks the sent turn with no `data-turn-start`,
  // so the generation cannot move for it — the streaming flag is the only
  // signal, and it has to be enough.
  expect(
    shouldPaintReconciledHistory({
      generationAtReconcile: 2,
      generationNow: 2,
      isStreaming: true,
    }),
  ).toBe(false)
})
