// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from "bun:test"
import {
  ReadableStream as WebReadableStream,
  TransformStream as WebTransformStream,
} from "node:stream/web"
import { readUIMessageStream, type UIMessage } from "ai"
import {
  dropUnfinishedAssistantTail,
  isUnfinishedAssistant,
  messageToChunks,
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

/** Runs the chunks through the SDK the way a resumed response does: into a new message. */
async function assemble(chunks: unknown[]): Promise<UIMessage | undefined> {
  // The DOM preload swaps in stream classes the SDK can't pipe through.
  const globals = globalThis as any
  const saved = { ReadableStream: globals.ReadableStream, TransformStream: globals.TransformStream }
  Object.assign(globals, { ReadableStream: WebReadableStream, TransformStream: WebTransformStream })
  try {
    const stream = new WebReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })
    let last: UIMessage | undefined
    for await (const m of readUIMessageStream({ stream: stream as any })) last = m
    return last
  } finally {
    Object.assign(globals, saved)
  }
}

const toolSnapshot = {
  id: "",
  role: "assistant",
  parts: [
    { type: "data-turn-start", data: { turnId: "t1" } },
    { type: "step-start" },
    { type: "reasoning", text: "thinking", state: "done" },
    { type: "text", text: "looking", state: "done" },
    {
      type: "tool-read_file",
      toolCallId: "call-1",
      state: "output-available",
      input: { path: "a.ts" },
      output: { ok: true },
    },
    {
      type: "dynamic-tool",
      toolName: "mcp_search",
      toolCallId: "call-2",
      state: "output-error",
      input: { q: "x" },
      errorText: "boom",
    },
    { type: "step-start" },
    { type: "text", text: "done reading", state: "done" },
  ],
} as unknown as UIMessage

describe("messageToChunks", () => {
  test("the chunks rebuild the snapshot's parts", async () => {
    const rebuilt = await assemble(messageToChunks(toolSnapshot))
    const shape = (m: UIMessage | undefined) =>
      (m?.parts ?? []).map((p: any) => ({
        type: p.type,
        text: p.text,
        state: p.state,
        input: p.input,
        output: p.output,
        errorText: p.errorText,
        toolName: p.toolName,
        data: p.data,
      }))
    expect(shape(rebuilt)).toEqual(shape(toolSnapshot))
  })

  test("keeps the snapshot's id when it has one", async () => {
    const rebuilt = await assemble(messageToChunks({ ...toolSnapshot, id: "msg-1" }))
    expect(rebuilt?.id).toBe("msg-1")
  })
})

describe("joining a turn by snapshot", () => {
  const snapshotChunk = (message: UIMessage) => ({
    type: "data-message-snapshot",
    data: { message },
    transient: true,
  })

  async function join(chunks: unknown[]): Promise<UIMessage | undefined> {
    const transport = withResumeReplayReset(
      { sendMessages: async () => chunkStream([]), reconnectToStream: async () => chunkStream(chunks) },
      () => {},
    )
    return assemble(await readAll(await transport.reconnectToStream({ chatId: "c1" })))
  }

  test("a turn that already finished arrives as one message with its reply", async () => {
    const finished = {
      id: "",
      role: "assistant",
      parts: [{ type: "step-start" }, { type: "text", text: "the reply", state: "done" }],
    } as unknown as UIMessage
    const message = await join([
      snapshotChunk(finished),
      { type: "data-turn-complete", data: { status: "completed" } },
      { type: "finish" },
    ])
    const texts = message?.parts.filter((p: any) => p.type === "text").map((p: any) => p.text)
    expect(texts).toEqual(["the reply"])
    expect(message?.parts.some((p: any) => p.type === "data-turn-complete")).toBe(true)
  })

  test("the rest of a live turn continues the snapshot's message", async () => {
    const message = await join([
      snapshotChunk(toolSnapshot),
      { type: "start-step" },
      { type: "text-start", id: "live-0" },
      { type: "text-delta", id: "live-0", delta: "and the next step" },
      { type: "text-end", id: "live-0" },
      { type: "finish-step" },
      { type: "finish" },
    ])
    const texts = message?.parts.filter((p: any) => p.type === "text").map((p: any) => p.text)
    expect(texts).toEqual(["looking", "done reading", "and the next step"])
  })
})


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
    )
  }

  test("replaces the snapshot chunk with the chunks that rebuild it, then the rest", async () => {
    const calls: string[] = []
    const out = await readAll(await wrap([snapshotChunk, ...rest], calls).reconnectToStream(request))
    expect(out).toEqual([...messageToChunks(snapshotMessage), ...rest])
    expect(calls).toEqual(["reset"])
  })

  test("a runtime that replays the stream passes through", async () => {
    const calls: string[] = []
    const replay = [{ type: "start" }, ...rest]
    expect(await readAll(await wrap(replay, calls).reconnectToStream(request))).toEqual(replay)
    expect(calls).toEqual(["reset"])
  })

  test("only a leading snapshot chunk is expanded", async () => {
    const calls: string[] = []
    const replay = [{ type: "start" }, snapshotChunk]
    expect(await readAll(await wrap(replay, calls).reconnectToStream(request))).toEqual(replay)
  })

  test("nothing is reset for a 204", async () => {
    const calls: string[] = []
    const transport = withResumeReplayReset(
      { sendMessages: async () => chunkStream([]), reconnectToStream: async () => null },
      () => calls.push("reset"),
    )
    expect(await transport.reconnectToStream(request)).toBeNull()
    expect(calls).toEqual([])
  })

  test("a silent stream resets right away and keeps later chunks", async () => {
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
    )
    const stream = (await transport.reconnectToStream(request))!
    expect(calls).toEqual(["reset"])
    push({ type: "late" })
    close()
    expect(await readAll(stream)).toEqual([{ type: "late" }])
  })
})
