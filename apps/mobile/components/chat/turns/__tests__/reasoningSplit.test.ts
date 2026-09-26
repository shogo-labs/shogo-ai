// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression tests for a live chat turn rendering a stack of bare
 * "Thought" rows (and a long connectivity wait growing `message.parts`
 * without bound).
 *
 * The chunks below are the UI message stream the runtime writes
 * (`packages/agent-runtime/src/gateway.ts`, `server.ts`), consumed by the
 * same `Chat` state machine the studio uses (`@ai-sdk/react` →
 * `processUIMessageStream` in `ai`), through the same transport wrapper
 * `ChatPanel` installs.
 *
 * Causes covered:
 *
 * 1. Non-transient `data-*` chunks are appended to `message.parts`, and
 *    `extractOrderedParts` used to merge reasoning only when parts were
 *    directly adjacent — so any heartbeat between bursts became another
 *    row. The gateway never sends `durationMs`, so each row read "Thought".
 * 2. `data-inference-retry` left the failed attempt's reasoning in place:
 *    the SDK keeps its own copy of the message, so trimming it from
 *    `onData` never stuck.
 * 3. `resumeStream()` replays the buffered turn from seq 0 on top of the
 *    assistant message already on screen, pushing every reasoning/text
 *    block again on each resume.
 * 4. Heartbeats with no `id` add one part per tick unless sent transient.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { TransformStream as WebTransformStream } from "node:stream/web"
import { Chat, type UIMessage } from "@ai-sdk/react"
import { extractOrderedParts } from "../messageParts"
import { formatThoughtLabel } from "../workSummary"
import {
  dropUnfinishedAssistantTail,
  withResumeReplayReset,
} from "../../resume-replay-transport"

type Chunk = Record<string, unknown>

// The happy-dom preload replaces the global `TransformStream` with a
// non-WHATWG class, which breaks the SDK's `processUIMessageStream`.
const preloadTransformStream = globalThis.TransformStream
beforeAll(() => {
  globalThis.TransformStream = WebTransformStream as typeof TransformStream
})
afterAll(() => {
  globalThis.TransformStream = preloadTransformStream
})

function chunkStream(chunks: Chunk[]): ReadableStream<Chunk> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

/** One reasoning burst, matching gateway `onThinkingStart/Delta/End`. */
function reasoningBurst(id: string, text: string): Chunk[] {
  return [
    { type: "reasoning-start", id },
    { type: "reasoning-delta", id, delta: text },
    { type: "reasoning-end", id },
  ]
}

function textReply(id: string, text: string): Chunk[] {
  return [
    { type: "text-start", id },
    { type: "text-delta", id, delta: text },
    { type: "text-end", id },
  ]
}

function lastAssistant(chat: Chat<UIMessage>): UIMessage {
  if (chat.error) {
    throw new Error(`chat ended in error: ${chat.error.message}`)
  }
  const assistant = [...chat.messages]
    .reverse()
    .find((message) => message.role === "assistant")
  if (!assistant) {
    throw new Error(`no assistant message after stream (status=${chat.status})`)
  }
  return assistant
}

/**
 * `replay` is what `/stream` returns on `resumeStream()` (`null` = 204).
 * The SDK's default reconnect URL carries no `fromSeq`, so the runtime
 * replays the buffered turn from seq 0.
 */
function createChat(
  chunks: Chunk[],
  replay: Chunk[] | null = chunks,
  onData?: (part: { type: string }) => void,
): Chat<UIMessage> {
  let chat!: Chat<UIMessage>
  const transport = withResumeReplayReset<UIMessage>(
    {
      async sendMessages() {
        return chunkStream(chunks) as ReadableStream<any>
      },
      async reconnectToStream() {
        return replay ? (chunkStream(replay) as ReadableStream<any>) : null
      },
    },
    () => {
      chat.messages = dropUnfinishedAssistantTail(chat.messages)
    },
  )
  chat = new Chat<UIMessage>({ id: "reasoning-split", transport, onData })
  return chat
}

async function playTurn(chunks: Chunk[]): Promise<UIMessage> {
  const chat = createChat(chunks)
  await chat.sendMessage({ text: "keep going" })
  return lastAssistant(chat)
}

function thoughtLabels(message: UIMessage): string[] {
  return extractOrderedParts(message).flatMap((part) =>
    part.type === "reasoning"
      ? [formatThoughtLabel(part.durationSeconds, part.isStreaming)]
      : [],
  )
}

describe("repeated Thought rows", () => {
  test("adjacent reasoning bursts coalesce into one Thought row", async () => {
    const message = await playTurn([
      ...reasoningBurst("r0", "first look"),
      ...reasoningBurst("r1", "second look"),
      ...reasoningBurst("r2", "third look"),
      ...textReply("t0", "done"),
    ])

    expect(thoughtLabels(message)).toEqual(["Thought"])
  })

  test("inference retries render only the attempt that landed", async () => {
    // Gateway `onInferenceRetry` closes the open reasoning block, then
    // writes `data-inference-retry`. The next attempt starts a new block.
    const attempts = 6
    const chunks: Chunk[] = [...textReply("pre", "before the dropped call")]
    chunks.push({
      type: "tool-input-start",
      toolCallId: "t1",
      toolName: "read_file",
      dynamic: true,
    })
    chunks.push({
      type: "tool-input-available",
      toolCallId: "t1",
      toolName: "read_file",
      input: {},
      dynamic: true,
    })
    chunks.push({ type: "tool-output-available", toolCallId: "t1", output: {} })
    for (let attempt = 1; attempt <= attempts; attempt++) {
      chunks.push(...reasoningBurst(`retry-${attempt}`, `attempt ${attempt}`))
      chunks.push(...textReply(`partial-${attempt}`, `partial ${attempt}`))
      chunks.push({
        type: "data-inference-retry",
        data: { attempt, maxAttempts: attempts, reason: "network", delayMs: 0 },
      })
    }
    chunks.push(...reasoningBurst("final", "the one that landed"))
    chunks.push(...textReply("t0", "done"))

    const message = await playTurn(chunks)
    const parts = extractOrderedParts(message)

    expect(parts.map((part) => part.type)).toEqual([
      "text",
      "tool",
      "reasoning",
      "text",
    ])
    expect(parts[0]).toMatchObject({ text: "before the dropped call" })
    expect(parts[2]).toMatchObject({ text: "the one that landed" })
    expect(parts[3]).toMatchObject({ text: "done" })
  })

  test("data parts between reasoning bursts do not split Thought rows", async () => {
    // Older runtimes send these heartbeats without `transient`, and
    // `data-turn-start` is intentionally kept in the message.
    let seq = 0
    const tick = (): Chunk => ({
      type: "data-turn-seq",
      data: { turnId: "turn-1", seq: ++seq },
    })
    const message = await playTurn([
      { type: "data-turn-start", data: { turnId: "turn-1" } },
      { type: "start-step" },
      ...reasoningBurst("r0", "first"),
      tick(),
      { type: "data-context-usage", data: { inputTokens: 10, contextWindowTokens: 200_000 } },
      { type: "data-process-update", data: { processes: [] } },
      ...reasoningBurst("r1", "second"),
      tick(),
      ...reasoningBurst("r2", "third"),
      ...textReply("t0", "done"),
    ])

    expect(thoughtLabels(message)).toEqual(["Thought"])
    expect(extractOrderedParts(message)[0]).toMatchObject({
      text: "first\n\nsecond\n\nthird",
    })
  })

  test("reasoning runs separated by a tool call stay separate", async () => {
    const message = await playTurn([
      ...reasoningBurst("r0", "let me look"),
      { type: "data-context-usage", data: { inputTokens: 10, contextWindowTokens: 200_000 } },
      { type: "tool-input-start", toolCallId: "t1", toolName: "read_file", dynamic: true },
      { type: "tool-input-available", toolCallId: "t1", toolName: "read_file", input: {}, dynamic: true },
      { type: "tool-output-available", toolCallId: "t1", output: {} },
      ...reasoningBurst("r1", "now I know"),
      ...textReply("t0", "done"),
    ])

    expect(extractOrderedParts(message).map((part) => part.type)).toEqual([
      "reasoning",
      "tool",
      "reasoning",
      "text",
    ])
  })

  test("transient heartbeats reach onData without growing message.parts", async () => {
    const ticks = 200
    const chunks: Chunk[] = [...reasoningBurst("r0", "waiting on the network")]
    for (let attempt = 1; attempt <= ticks; attempt++) {
      chunks.push({
        type: "data-connectivity-wait",
        data: { state: "waiting", attempt, elapsedMs: attempt * 15_000, nextProbeInMs: 15_000 },
        transient: true,
      })
      chunks.push({
        type: "data-turn-seq",
        data: { turnId: "turn-1", seq: attempt },
        transient: true,
      })
    }
    chunks.push({
      type: "data-connectivity-wait",
      data: { state: "reconnected" },
      transient: true,
    })
    chunks.push(...textReply("t0", "back"))

    const seen: string[] = []
    const chat = createChat(chunks, null, (part) => seen.push(part.type))
    await chat.sendMessage({ text: "keep going" })
    const message = lastAssistant(chat)

    expect(message.parts.map((part) => part.type)).toEqual(["reasoning", "text"])
    expect(seen.filter((type) => type === "data-connectivity-wait")).toHaveLength(ticks + 1)
    expect(seen.filter((type) => type === "data-turn-seq")).toHaveLength(ticks)
  })
})

describe("resuming a live turn", () => {
  // A turn still in progress: no `data-turn-complete` yet.
  const liveTurn: Chunk[] = [
    { type: "data-turn-start", data: { turnId: "turn-1", startedAt: 1 } },
    { type: "start-step" },
    ...reasoningBurst("r0", "let me look"),
    { type: "tool-input-start", toolCallId: "t1", toolName: "read_file", dynamic: true },
    { type: "tool-input-available", toolCallId: "t1", toolName: "read_file", input: { path: "a.ts" }, dynamic: true },
    { type: "tool-output-available", toolCallId: "t1", output: { ok: true } },
    ...reasoningBurst("r1", "now I know"),
    ...textReply("text-0", "here is the answer"),
  ]

  test("a full replay rebuilds the message instead of appending to it", async () => {
    const chat = createChat(liveTurn, liveTurn)
    await chat.sendMessage({ text: "keep going" })
    const before = extractOrderedParts(lastAssistant(chat))

    await chat.resumeStream()
    await chat.resumeStream()
    await chat.resumeStream()

    expect(extractOrderedParts(lastAssistant(chat))).toEqual(before)
    expect(chat.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ])
  })

  test("a replay that has moved further picks up the new chunks", async () => {
    const chat = createChat(liveTurn.slice(0, 7), liveTurn)
    await chat.sendMessage({ text: "keep going" })

    await chat.resumeStream()

    expect(
      extractOrderedParts(lastAssistant(chat)).map((part) => part.type),
    ).toEqual(["reasoning", "tool", "reasoning", "text"])
  })

  test("nothing to resume (204) keeps the message on screen", async () => {
    const chat = createChat(liveTurn, null)
    await chat.sendMessage({ text: "keep going" })
    const before = lastAssistant(chat)

    await chat.resumeStream()

    expect(lastAssistant(chat)).toBe(before)
  })
})
