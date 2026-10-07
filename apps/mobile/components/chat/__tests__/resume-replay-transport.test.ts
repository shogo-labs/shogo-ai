// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from "bun:test"
import type { UIMessage } from "ai"
import {
  dropUnfinishedAssistantTail,
  isUnfinishedAssistant,
  withResumeReplayReset,
} from "../resume-replay-transport"

function message(role: UIMessage["role"], parts: unknown[] = []): UIMessage {
  return { id: `${role}-${parts.length}`, role, parts } as UIMessage
}

describe("isUnfinishedAssistant", () => {
  test("a streaming assistant message is unfinished", () => {
    expect(
      isUnfinishedAssistant(
        message("assistant", [{ type: "reasoning", text: "hm" }]),
      ),
    ).toBe(true)
  })

  test("a live data-turn-complete frame marks it finished", () => {
    expect(
      isUnfinishedAssistant(
        message("assistant", [
          { type: "text", text: "done" },
          { type: "data-turn-complete", data: { status: "completed" } },
        ]),
      ),
    ).toBe(false)
  })

  test("persisted timing marks it finished only once completedAt is set", () => {
    const partial = message("assistant", [
      { type: "data-turn-timing", data: { startedAt: 1 } },
    ])
    const done = message("assistant", [
      { type: "data-turn-timing", data: { startedAt: 1, completedAt: 2 } },
    ])
    expect(isUnfinishedAssistant(partial)).toBe(true)
    expect(isUnfinishedAssistant(done)).toBe(false)
  })

  test("user messages and an empty list are never dropped", () => {
    expect(isUnfinishedAssistant(message("user"))).toBe(false)
    expect(isUnfinishedAssistant(undefined)).toBe(false)
  })
})

describe("dropUnfinishedAssistantTail", () => {
  test("drops only the trailing unfinished assistant message", () => {
    const history = [message("user"), message("assistant")]
    expect(dropUnfinishedAssistantTail(history)).toEqual([history[0]])
  })

  test("returns the same array when there is nothing to drop", () => {
    const history = [
      message("user"),
      message("assistant", [{ type: "data-turn-complete", data: {} }]),
    ]
    expect(dropUnfinishedAssistantTail(history)).toBe(history)
  })
})

function chunkStream(chunks: unknown[]): ReadableStream<any> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

async function readAll(stream: ReadableStream<any> | null): Promise<unknown[]> {
  const out: unknown[] = []
  if (!stream) return out
  const reader = stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) return out
    out.push(value)
  }
}

describe("withResumeReplayReset", () => {
  const request = { chatId: "c1" }
  const chunks = [{ type: "start" }, { type: "text-start", id: "t" }]

  test("runs beforeReplay only when a replay stream comes back", async () => {
    let resets = 0
    const withStream = withResumeReplayReset(
      {
        sendMessages: async () => chunkStream(chunks),
        reconnectToStream: async () => chunkStream(chunks),
      },
      () => resets++,
    )
    const without = withResumeReplayReset(
      {
        sendMessages: async () => chunkStream(chunks),
        reconnectToStream: async () => null,
      },
      () => resets++,
    )

    expect(await readAll(await withStream.reconnectToStream(request))).toEqual(chunks)
    expect(resets).toBe(1)
    expect(await without.reconnectToStream(request)).toBeNull()
    expect(resets).toBe(1)
  })

  test("sendMessages passes straight through without a reset", async () => {
    let resets = 0
    const transport = withResumeReplayReset(
      {
        sendMessages: async () => chunkStream(chunks),
        reconnectToStream: async () => null,
      },
      () => resets++,
    )

    const result = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "c1",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    })
    expect(await readAll(result)).toEqual(chunks)
    expect(resets).toBe(0)
  })
})
