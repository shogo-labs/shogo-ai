// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The end-of-turn reconcile asks *which* saved row is this turn's reply, against
 * a snapshot taken when that turn started (SHO-325).
 *
 * The helper is unit-tested in `reconcile-reply-row.test.ts`; what those tests
 * cannot see is whether `ChatPanel` actually uses it. The `onFinish` reconcile
 * only runs inside a live stream, so this guards the wiring the way
 * `chat-panel-inactive-tab.guard.test.ts` guards its timers: the structure that
 * makes the behaviour true.
 *
 * Two ways it can silently regress, both of which shipped before:
 *  - back to "an assistant id that was not there before" (`priorAssistantIds`),
 *    which never fires once the API saves the reply mid-turn;
 *  - keeping a snapshot taken only by `sendMessageInternal`, which describes the
 *    previous send for a turn the server dispatched itself, so that turn's
 *    reply looks new and the repaint paints saved history over it.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

const MOBILE = join(import.meta.dir, "../../..")
const panel = readFileSync(join(MOBILE, "components/chat/ChatPanel.tsx"), "utf8")

/** The `onFinish` reconcile loop, from its attempt budget to the warning. */
function reconcileBlock(): string {
  const start = panel.indexOf("RECONCILE_ATTEMPTS")
  expect(start).toBeGreaterThan(-1)
  const end = panel.indexOf("Assistant message not yet persisted", start)
  expect(end).toBeGreaterThan(start)
  return panel.slice(start, end)
}

describe("the reconcile finds this turn's reply", () => {
  test("it asks the helper, not 'an id I had not seen before'", () => {
    const block = reconcileBlock()
    expect(block).toContain("findTurnReplyRow({")
    expect(block).toContain("atSend: reconcileAtSendRef.current")
    expect(block).toContain("turnText: assistantText")
    expect(panel).not.toContain("priorAssistantIds")
  })

  test("the snapshot is taken when a send starts", () => {
    const send = panel.slice(panel.indexOf("const sendMessageInternal = useCallback("))
    const snapshot = send.indexOf("reconcileAtSendRef.current = assistantRowsAtSend(")
    expect(snapshot).toBeGreaterThan(-1)
    // Before the request goes out: everything already saved is "before".
    expect(snapshot).toBeLessThan(send.indexOf("await deliverMessage("))
  })

  test("the snapshot is retaken on every turn start, so a turn this window did not start has its own", () => {
    const turnStart = panel.slice(
      panel.indexOf('dataPart.type === "data-turn-start"'),
    )
    const block = turnStart.slice(0, turnStart.indexOf('data-turn-seq'))
    expect(block).toContain("reconcileAtSendRef.current = assistantRowsAtSend(")
    // Inside the "a new turn id" branch, not on every heartbeat.
    const newTurn = block.indexOf("d.turnId !== currentTurnIdRef.current")
    expect(newTurn).toBeGreaterThan(-1)
    expect(block.indexOf("reconcileAtSendRef.current = assistantRowsAtSend(")).toBeGreaterThan(
      newTurn,
    )
  })
})
