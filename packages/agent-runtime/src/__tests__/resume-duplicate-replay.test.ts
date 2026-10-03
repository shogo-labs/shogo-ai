// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression — Sentry JAVASCRIPT-REACT-45, dominant variant on prod web:
 *
 *   [AutoResume:d17d0579] stream errored mid-turn (network error); reconnecting fromSeq=4319
 *   [ChatPanel] Stream error: AI_UIMessageStreamError: Received text-delta for
 *     missing text part with ID "text-…". Ensure a "text-start" chunk is sent
 *     before any "text-delta" chunks.
 *
 * The client used the last `data-turn-seq` heartbeat as its resume cursor. The
 * runtime writes that heartbeat every 250ms with the buffer's lastSeq at write
 * time, and `/stream?fromSeq=N` replays every chunk with seq > N, so every
 * frame forwarded after the last heartbeat was delivered twice: duplicated
 * text, or the SDK error above when the window spanned a `text-end`.
 *
 * The runtime now buffers one SSE frame per seq and says so in
 * `data-turn-start` (`seqMode: 'frame'`); the client then resumes from the
 * count of frames it fully received.
 *
 * Uses the real StreamBufferStore, the real auto-resuming fetch, and the AI
 * SDK's own UI-message-stream processor.
 */
import { describe, expect, test } from "bun:test"
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai"
import { StreamBufferStore, createSseFrameSplitter } from "../../../core/src/stream-buffer"
import { createAutoResumingFetch } from "../../../shared-app/src/chat/auto-resuming-fetch"

const SESSION = "session-resume-dup"
const POST_URL = "https://studio.shogo.ai/api/projects/p1/chat"
const SILENT_LOGGER = { warn: () => {}, log: () => {} }

const encoder = new TextEncoder()
const frameText = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`

interface RuntimeOptions {
  /** Runtime advertises (and honours) one buffered frame per seq. */
  seqPerFrame: boolean
  /** The runtime's reads coalesce several frames per chunk. */
  coalesce?: boolean
}

/**
 * Buffers a turn the way server.ts does: the heartbeat reports
 * `bufWriter.lastSeq` at the moment it is written. Returns the buffered seq
 * after which the live connection drops.
 */
function bufferTurn(
  store: StreamBufferStore,
  afterHeartbeat: unknown[],
  tail: unknown[],
  { seqPerFrame, coalesce = false }: RuntimeOptions,
) {
  const writer = store.create(SESSION)
  const turnId = writer.turnId
  const splitter = createSseFrameSplitter()
  let queued = ""
  const flushQueued = () => {
    if (!queued) return
    const bytes = encoder.encode(queued)
    queued = ""
    if (seqPerFrame) for (const f of splitter.push(bytes)) writer.append(f)
    else writer.append(bytes)
  }
  const write = (e: unknown) => {
    queued += frameText(e)
    if (!coalesce) flushQueued()
  }

  write({
    type: "data-turn-start",
    data: { turnId, chatSessionId: SESSION, startedAt: 1, ...(seqPerFrame ? { seqMode: "frame" } : {}) },
  })
  write({ type: "start", messageId: "m1" })
  write({ type: "start-step" })
  write({ type: "text-start", id: "t1" })
  write({ type: "text-delta", id: "t1", delta: "Hello " })
  flushQueued()
  write({ type: "data-turn-seq", data: { turnId, seq: writer.lastSeq }, transient: true })
  for (const e of afterHeartbeat) write(e)
  flushQueued()
  const dropAfterSeq = writer.lastSeq
  for (const e of tail) write(e)
  write({ type: "finish-step" })
  write({ type: "finish" })
  write({ type: "data-turn-complete", data: { turnId, status: "completed", lastSeq: writer.lastSeq } })
  flushQueued()
  writer.complete()
  return { turnId, dropAfterSeq }
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

async function runTurn(afterHeartbeat: unknown[], tail: unknown[], runtime: RuntimeOptions) {
  const store = new StreamBufferStore()
  const { turnId, dropAfterSeq } = bufferTurn(store, afterHeartbeat, tail, runtime)
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
  return { error, text, resumeUrls, dropAfterSeq }
}

const TEXT_PART_ENDS_BEFORE_DROP = [
  [
    { type: "text-delta", id: "t1", delta: "world" },
    { type: "text-end", id: "t1" },
  ],
  [
    { type: "text-start", id: "t2" },
    { type: "text-delta", id: "t2", delta: "second part" },
    { type: "text-end", id: "t2" },
  ],
] as const

const DROP_MID_TEXT_PART = [
  [{ type: "text-delta", id: "t1", delta: "world" }],
  [
    { type: "text-delta", id: "t1", delta: "!" },
    { type: "text-end", id: "t1" },
  ],
] as const

describe("JAVASCRIPT-REACT-45: resume after a mid-turn drop delivers each frame once", () => {
  test("a text part that ended after the last heartbeat is not replayed", async () => {
    const { error, text, resumeUrls, dropAfterSeq } = await runTurn(
      [...TEXT_PART_ENDS_BEFORE_DROP[0]],
      [...TEXT_PART_ENDS_BEFORE_DROP[1]],
      { seqPerFrame: true },
    )

    expect(error).toBeNull()
    expect(resumeUrls).toHaveLength(1)
    expect(resumeUrls[0]).toEndWith(`?fromSeq=${dropAfterSeq}`)
    expect(text).toBe("Hello world|second part")
  })

  test("a drop mid text part does not duplicate the deltas after the heartbeat", async () => {
    const { error, text } = await runTurn([...DROP_MID_TEXT_PART[0]], [...DROP_MID_TEXT_PART[1]], {
      seqPerFrame: true,
    })

    expect(error).toBeNull()
    expect(text).toBe("Hello world!")
  })

  test("runtime reads that coalesce several frames are split to one frame per seq", async () => {
    const { error, text } = await runTurn(
      [...TEXT_PART_ENDS_BEFORE_DROP[0]],
      [...TEXT_PART_ENDS_BEFORE_DROP[1]],
      { seqPerFrame: true, coalesce: true },
    )

    expect(error).toBeNull()
    expect(text).toBe("Hello world|second part")
  })

  test("an older runtime without seqMode keeps the heartbeat cursor (never skips frames)", async () => {
    const { resumeUrls, text } = await runTurn([...DROP_MID_TEXT_PART[0]], [...DROP_MID_TEXT_PART[1]], {
      seqPerFrame: false,
    })

    expect(resumeUrls[0]).toEndWith("?fromSeq=5")
    expect(text).toBe("Hello worldworld!")
  })
})

describe("createSseFrameSplitter", () => {
  const decode = (chunks: Uint8Array[]) => chunks.map((c) => new TextDecoder().decode(c))

  test("splits coalesced frames and holds a partial tail until it completes", () => {
    const splitter = createSseFrameSplitter()
    expect(decode(splitter.push(encoder.encode("data: 1\n\ndata: 2\n\ndata: ")))).toEqual([
      "data: 1\n\n",
      "data: 2\n\n",
    ])
    expect(decode(splitter.push(encoder.encode("3\n")))).toEqual([])
    expect(decode(splitter.push(encoder.encode("\ndata: 4\n\n")))).toEqual(["data: 3\n\n", "data: 4\n\n"])
    expect(splitter.flush()).toBeNull()
  })

  test("flush returns an unterminated tail", () => {
    const splitter = createSseFrameSplitter()
    splitter.push(encoder.encode("data: x"))
    expect(new TextDecoder().decode(splitter.flush()!)).toBe("data: x")
  })
})
