// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * REPRODUCTION — Sentry JAVASCRIPT-REACT-45, current dominant variant (prod web,
 * still firing on 2.1.0):
 *
 *   [AutoResume:d17d0579] stream errored mid-turn (network error); reconnecting fromSeq=4319
 *   [ChatPanel] Stream error: AI_UIMessageStreamError: Received text-delta for
 *     missing text part with ID "text-…". Ensure a "text-start" chunk is sent
 *     before any "text-delta" chunks.
 *
 * The client's resume cursor is the last `data-turn-seq` heartbeat it saw. The
 * runtime only writes that heartbeat every 250ms (server.ts `seqHeartbeat`), and
 * `/stream?fromSeq=N` replays every buffered chunk with seq > N. Every frame
 * the client already forwarded to the AI SDK after the last heartbeat is
 * therefore delivered twice. When that window contains a `text-end`, the
 * replayed `text-delta` targets a part the SDK already closed and it throws;
 * otherwise the text is silently duplicated.
 *
 * Uses the real runtime StreamBufferStore, the real auto-resuming fetch, and
 * the AI SDK's own UI-message-stream processor.
 *
 * Run: bun test packages/agent-runtime/src/__tests__/resume-duplicate-replay.repro.test.ts
 */
import { describe, expect, test } from "bun:test"
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai"
import { StreamBufferStore } from "../../../core/src/stream-buffer"
import { createAutoResumingFetch } from "../../../shared-app/src/chat/auto-resuming-fetch"

const SESSION = "session-resume-dup"
const POST_URL = "https://studio.shogo.ai/api/projects/p1/chat"
const SILENT_LOGGER = { warn: () => {}, log: () => {} }

const encoder = new TextEncoder()
const frame = (event: unknown) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`)

/**
 * Writes the turn into the runtime buffer the way server.ts does: each UI
 * chunk lands as its own buffered chunk, and the heartbeat reports
 * `bufWriter.lastSeq` at the moment it is written.
 */
function bufferTurn(store: StreamBufferStore, afterHeartbeat: unknown[], tail: unknown[]) {
  const writer = store.create(SESSION)
  const turnId = writer.turnId
  const write = (e: unknown) => writer.append(frame(e))

  write({ type: "data-turn-start", data: { turnId, chatSessionId: SESSION, startedAt: 1 } })
  write({ type: "start", messageId: "m1" })
  write({ type: "start-step" })
  write({ type: "text-start", id: "t1" })
  write({ type: "text-delta", id: "t1", delta: "Hello " })
  write({ type: "data-turn-seq", data: { turnId, seq: writer.lastSeq }, transient: true })
  const deliveredBeforeDrop = [...afterHeartbeat]
  for (const e of afterHeartbeat) write(e)
  const dropAfterSeq = writer.lastSeq
  for (const e of tail) write(e)
  write({ type: "finish-step" })
  write({ type: "finish" })
  write({ type: "data-turn-complete", data: { turnId, status: "completed", lastSeq: writer.lastSeq } })
  writer.complete()
  return { turnId, dropAfterSeq, deliveredBeforeDrop }
}

/** The live POST body: replays the buffer, then the connection drops mid-turn. */
function bodyThatDropsAfter(store: StreamBufferStore, lastDeliveredSeq: number): ReadableStream<Uint8Array> {
  const source = store.createReplayStream(SESSION)!.getReader()
  let delivered = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (delivered >= lastDeliveredSeq) throw new TypeError("network error")
      const { done, value } = await source.read()
      if (done) return controller.close()
      delivered++
      controller.enqueue(value)
    },
  })
}

function sseToChunks(body: ReadableStream<Uint8Array>): ReadableStream<UIMessageChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) return controller.close()
      pending += decoder.decode(value, { stream: true })
      let idx = pending.indexOf("\n\n")
      while (idx !== -1) {
        const line = pending.slice(0, idx)
        pending = pending.slice(idx + 2)
        if (line.startsWith("data:")) controller.enqueue(JSON.parse(line.slice(5).trim()))
        idx = pending.indexOf("\n\n")
      }
    },
  })
}

async function runTurn(afterHeartbeat: unknown[], tail: unknown[]) {
  const store = new StreamBufferStore()
  const { turnId, dropAfterSeq } = bufferTurn(store, afterHeartbeat, tail)
  const resumeUrls: string[] = []

  const baseFetch = (async (url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "POST") {
      return new Response(bodyThatDropsAfter(store, dropAfterSeq), {
        status: 200,
        headers: { "X-Turn-Id": turnId, "X-Chat-Session-Id": SESSION },
      })
    }
    resumeUrls.push(url)
    const fromSeq = Number(new URL(url).searchParams.get("fromSeq") ?? 0)
    return new Response(store.createReplayStream(SESSION, { fromSeq }), {
      status: 200,
      headers: { "X-Turn-Id": turnId },
    })
  }) as unknown as typeof fetch

  const fetcher = createAutoResumingFetch(baseFetch, {
    logger: SILENT_LOGGER,
    initialBackoffMs: 0,
    maxBackoffMs: 0,
  })
  const res = await fetcher(POST_URL, { method: "POST" })

  let error: unknown = null
  let message: UIMessage | undefined
  try {
    for await (const m of readUIMessageStream<UIMessage>({
      stream: sseToChunks(res.body!),
      terminateOnError: true,
    })) {
      message = m
    }
  } catch (err) {
    error = err
  }
  const text = (message?.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("|")
  return { error, text, resumeUrls }
}

describe("REPRODUCTION JAVASCRIPT-REACT-45: resume replays frames already delivered after the last seq heartbeat", () => {
  test("a text part that ends between the heartbeat and the drop → 'text-delta for missing text part'", async () => {
    const { error, resumeUrls } = await runTurn(
      [
        { type: "text-delta", id: "t1", delta: "world" },
        { type: "text-end", id: "t1" },
      ],
      [
        { type: "text-start", id: "t2" },
        { type: "text-delta", id: "t2", delta: "second part" },
        { type: "text-end", id: "t2" },
      ],
    )

    expect(resumeUrls[0]).toEndWith("?fromSeq=5")
    expect(String((error as Error)?.message)).toContain(
      'Received text-delta for missing text part with ID "t1"',
    )
  })

  test("a drop mid text part → the deltas after the heartbeat render twice", async () => {
    const { error, text } = await runTurn(
      [{ type: "text-delta", id: "t1", delta: "world" }],
      [
        { type: "text-delta", id: "t1", delta: "!" },
        { type: "text-end", id: "t1" },
      ],
    )

    expect(error).toBeNull()
    expect(text).toBe("Hello worldworld!")
  })
})
