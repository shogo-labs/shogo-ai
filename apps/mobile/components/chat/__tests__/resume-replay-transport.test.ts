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

describe("withResumeReplayReset message snapshot", () => {
  const request = { chatId: "c1" }
  const snapshotMessage = { id: "m1", role: "assistant", parts: [{ type: "text", text: "so far" }] } as UIMessage
  const snapshotChunk = { type: "data-message-snapshot", data: { message: snapshotMessage }, transient: true }
  const rest = [{ type: "start-step" }, { type: "text-start", id: "0" }]

  function wrap(streamChunks: unknown[], calls: string[]) {
    return withResumeReplayReset(
      {
        sendMessages: async () => chunkStream([]),
        reconnectToStream: async () => chunkStream(streamChunks),
      },
      () => calls.push("reset"),
      (m) => calls.push(`snapshot:${m.id}`),
    )
  }

  test("applies the snapshot, strips its chunk and skips the replay reset", async () => {
    const calls: string[] = []
    const out = await readAll(await wrap([snapshotChunk, ...rest], calls).reconnectToStream(request))
    expect(out).toEqual(rest)
    expect(calls).toEqual(["snapshot:m1"])
  })

  test("falls back to the reset for a runtime that replays the stream", async () => {
    const calls: string[] = []
    const replay = [{ type: "start" }, ...rest]
    expect(await readAll(await wrap(replay, calls).reconnectToStream(request))).toEqual(replay)
    expect(calls).toEqual(["reset"])
  })

  test("a snapshot is not applied for a 204", async () => {
    const calls: string[] = []
    const transport = withResumeReplayReset(
      { sendMessages: async () => chunkStream([]), reconnectToStream: async () => null },
      () => calls.push("reset"),
      () => calls.push("snapshot"),
    )
    expect(await transport.reconnectToStream(request)).toBeNull()
    expect(calls).toEqual([])
  })

  test("a silent stream is treated as a replay once the peek times out, keeping later chunks", async () => {
    const calls: string[] = []
    let push!: (chunk: unknown) => void
    let close!: () => void
    const live = new ReadableStream<any>({
      start(controller) {
        push = (chunk) => controller.enqueue(chunk)
        close = () => controller.close()
      },
    })
    const transport = withResumeReplayReset(
      { sendMessages: async () => chunkStream([]), reconnectToStream: async () => live },
      () => calls.push("reset"),
      () => calls.push("snapshot"),
    )
    const stream = (await transport.reconnectToStream(request))!
    expect(calls).toEqual(["reset"])
    push({ type: "late" })
    close()
    expect(await readAll(stream)).toEqual([{ type: "late" }])
  })

  test("without onSnapshot the snapshot chunk is left alone and the reset runs", async () => {
    const calls: string[] = []
    const transport = withResumeReplayReset(
      { sendMessages: async () => chunkStream([]), reconnectToStream: async () => chunkStream([snapshotChunk]) },
      () => calls.push("reset"),
    )
    expect(await readAll(await transport.reconnectToStream(request))).toEqual([snapshotChunk])
    expect(calls).toEqual(["reset"])
  })
})
