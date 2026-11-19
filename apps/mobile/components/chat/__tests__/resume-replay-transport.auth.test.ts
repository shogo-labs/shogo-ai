// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A chat send refused with 401 is the one failure a retry can repair on its own:
 * refresh the session and replay the same request once (SHO-431). These pin the
 * bounds — exactly one retry, only for a 401, and only when the session actually
 * came back.
 */

import { describe, expect, test } from "bun:test"
import type { ChatTransport } from "ai"
import { withResumeReplayReset } from "../resume-replay-transport"

/** What `requireAuth` in apps/api answers a refused chat request. */
const API_401 = JSON.stringify({
  error: { code: "unauthorized", message: "Authentication required" },
})

type Outcome = "ok" | "unauthorized" | "boom"

function closedStream(): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      controller.close()
    },
  })
}

/** A transport that answers with `outcomes` in order, one per attempt. */
function scripted(outcomes: Outcome[]) {
  let calls = 0
  const next = () => outcomes[calls++] ?? "ok"
  const transport = {
    async sendMessages() {
      const outcome = next()
      if (outcome === "ok") return closedStream()
      throw new Error(outcome === "unauthorized" ? API_401 : "boom")
    },
    async reconnectToStream() {
      const outcome = next()
      if (outcome === "ok") return closedStream()
      throw new Error(outcome === "unauthorized" ? API_401 : "boom")
    },
  } as unknown as ChatTransport<any>
  return { transport, attempts: () => calls }
}

function wrap(transport: ChatTransport<any>, reauthorize?: () => Promise<boolean>) {
  return withResumeReplayReset(transport, () => {}, undefined, reauthorize)
}

const sendOptions = { trigger: "submit-message", chatId: "chat-1" } as any

describe("a refused session on send", () => {
  test("refreshes the session and replays the same request once", async () => {
    const { transport, attempts } = scripted(["unauthorized", "ok"])
    let reauthorized = 0
    const wrapped = wrap(transport, async () => {
      reauthorized += 1
      return true
    })

    await wrapped.sendMessages(sendOptions)

    expect(reauthorized).toBe(1)
    expect(attempts()).toBe(2)
  })

  test("gives up after one retry rather than hammering the API", async () => {
    const { transport, attempts } = scripted(["unauthorized", "unauthorized"])
    let reauthorized = 0
    const wrapped = wrap(transport, async () => {
      reauthorized += 1
      return true
    })

    await expect(wrapped.sendMessages(sendOptions)).rejects.toThrow("unauthorized")

    expect(reauthorized).toBe(1)
    expect(attempts()).toBe(2)
  })

  test("does not retry when the session could not be re-established", async () => {
    const { transport, attempts } = scripted(["unauthorized", "ok"])
    const wrapped = wrap(transport, async () => false)

    await expect(wrapped.sendMessages(sendOptions)).rejects.toThrow("unauthorized")

    expect(attempts()).toBe(1)
  })

  test("leaves every other failure to the caller", async () => {
    const { transport, attempts } = scripted(["boom"])
    let reauthorized = 0
    const wrapped = wrap(transport, async () => {
      reauthorized += 1
      return true
    })

    await expect(wrapped.sendMessages(sendOptions)).rejects.toThrow("boom")

    expect(reauthorized).toBe(0)
    expect(attempts()).toBe(1)
  })

  test("a transport with no way to re-authorise surfaces the refusal", async () => {
    const { transport, attempts } = scripted(["unauthorized", "ok"])

    await expect(wrap(transport).sendMessages(sendOptions)).rejects.toThrow(
      "unauthorized",
    )

    expect(attempts()).toBe(1)
  })
})

describe("a refused session on resume", () => {
  test("refreshes the session and replays the stream request", async () => {
    const { transport, attempts } = scripted(["unauthorized", "ok"])
    const wrapped = wrap(transport, async () => true)

    await wrapped.reconnectToStream(sendOptions)

    expect(attempts()).toBe(2)
  })

  test("a stream that arrives after the retry is handed back", async () => {
    const { transport } = scripted(["unauthorized", "ok"])
    const wrapped = wrap(transport, async () => true)

    expect(await wrapped.reconnectToStream(sendOptions)).not.toBeNull()
  })
})
