// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA round 1 on SHO-431 found the draft restore unreachable: `Chat.sendMessage`
 * reports a transport failure to `onError` and then **resolves**, so the
 * `catch` that was supposed to notice the 401 never ran and the composer's text
 * was lost. These pin the contract the fix is built on — the SDK resolves, the
 * refusal is recorded from `onError`, and the send path reads it back.
 */

import { describe, expect, test } from "bun:test"
import { Chat } from "@ai-sdk/react"
import { withResumeReplayReset } from "../resume-replay-transport"
import {
  refusalIsFor,
  refusedSendFor,
  withoutRefusedSend,
  type RefusedSend,
} from "../session-refusal"

/** What `requireAuth` in apps/api answers a refused chat request. */
const API_401 = JSON.stringify({
  error: { code: "unauthorized", message: "Authentication required" },
})

const TURN = "turn-1"

/**
 * The pieces of `ChatPanel` this card changed, wired the way the panel wires
 * them: a pending turn id, the transport's one-shot refresh, and the refusal
 * recorded from `onError`.
 *
 * Every outcome here is a refusal: a send the refresh repaired never reaches
 * `onError`, and that the transport replays it once is pinned in
 * `resume-replay-transport.auth.test.ts` — a success stream cannot be driven
 * through `Chat` under `bun test` (the AI SDK pipes through a `TransformStream`
 * its own realm rejects).
 */
function panelHarness(outcomes: Array<"ok" | "unauthorized">) {
  let attempts = 0
  const base = {
    async sendMessages() {
      const outcome = outcomes[attempts++] ?? "ok"
      if (outcome === "ok")
        throw new Error("this harness only drives refusals")
      throw new Error(API_401)
    },
    async reconnectToStream() {
      return null
    },
  } as any

  let reauthorized = 0
  let refused: RefusedSend | null = null
  const pendingTurn: { current: string | null } = { current: null }

  const transport = withResumeReplayReset(
    base,
    () => {},
    undefined,
    async () => {
      reauthorized += 1
      return true
    },
  )

  const chat = new Chat({
    transport,
    onError: () => {
      refused = refusedSendFor(pendingTurn.current)
    },
  } as any)

  const send = async (turnId: string) => {
    pendingTurn.current = turnId
    refused = null
    await chat.sendMessage({ text: "hello" })
    return {
      sessionExpired: refusalIsFor(refused, turnId),
      attempts,
      reauthorized,
    }
  }

  return { chat, send, refusal: () => refused }
}

describe("a send the API refused", () => {
  test("resolves instead of throwing — why the old catch never ran", async () => {
    const { chat } = panelHarness(["unauthorized", "unauthorized"])

    // Resolves: `makeRequest` catches the transport throw, reports it to
    // `onError` and returns. A `try/catch` around this sees nothing.
    await expect(chat.sendMessage({ text: "hello" })).resolves.toBeUndefined()
    expect(chat.status).toBe("error")
  })

  test("is reported back to the send path after the one refresh and retry", async () => {
    const { send } = panelHarness(["unauthorized", "unauthorized"])

    expect(await send(TURN)).toEqual({
      sessionExpired: true,
      attempts: 2,
      reauthorized: 1,
    })
  })

  test("a refusal that lands after the person moved on does not match the next send", async () => {
    const { send, refusal } = panelHarness(["unauthorized", "unauthorized"])

    await send(TURN)

    // The refusal stays recorded; only the turn id keeps it from restoring
    // that text into a composer someone is now typing in.
    expect(refusalIsFor(refusal(), "turn-2")).toBe(false)
    expect(refusalIsFor(refusal(), TURN)).toBe(true)
  })
})

describe("withoutRefusedSend", () => {
  const user = { id: "u2", role: "user" }
  const assistant = { id: "a1", role: "assistant" }

  test("drops the bubble the refused send pushed", () => {
    expect(withoutRefusedSend([assistant, user])).toEqual([assistant])
  })

  test("leaves a transcript that ends with a reply alone", () => {
    const messages = [user, assistant]
    expect(withoutRefusedSend(messages)).toEqual(messages)
  })

  test("is a no-op on an empty transcript", () => {
    expect(withoutRefusedSend([])).toEqual([])
  })
})
