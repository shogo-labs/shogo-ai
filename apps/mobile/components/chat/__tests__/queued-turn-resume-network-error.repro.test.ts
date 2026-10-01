// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * REPRODUCTION for Sentry JAVASCRIPT-REACT-46 (`TypeError: network error`,
 * shogo_telemetry=chat_stream_error, chatErrorClass=connection,
 * recovered=false) — the variant with NO `[AutoResume:xxxx]` breadcrumbs.
 *
 * Latest-event timeline (breadcrumbs):
 *   1:29:52  POST /api/projects/<id>/chat              (turn 1, durable-wrapped)
 *   1:30:04  POST /api/chat-queued-messages            (user queues turn 2)
 *   1:30:09  turn 1 ends → server `dispatchNext()` starts turn 2 server-side
 *   1:30:12  GET /api/chat-queued-messages → head row gone
 *            → useServerMessageQueue.onTurnAvailable → resumeQueuedTurn
 *            → useChat.resumeStream() → DefaultChatTransport.reconnectToStream
 *            → GET /api/projects/<id>/chat/<sid>/stream   (turn 2 attach)
 *   … 15 min of /api/version polling while turn 2 streams over that GET …
 *   1:45:45  [ChatPanel] Stream error: TypeError: network error
 *
 * Root cause: `createAutoResumingFetch`'s `wrapped` only makes POSTs durable
 * (`if (method !== 'POST') return baseFetch(...)`). The queued-turn attach
 * (and every other `resumeStream()` caller: live-turn probe, stall recovery,
 * Retry) goes through the SAME wrapped fetch as a GET, so its body is the raw
 * network body. A mid-stream HTTP/2 reset rejects `reader.read()` with
 * `TypeError: network error`, which flows straight into the AI SDK's
 * `onError` — no `/stream?fromSeq=N` reconnect, and no AutoResume log lines.
 *
 * The control test shows the identical body failure on a POST IS recovered
 * (and logs `[AutoResume:…] … reconnecting`); the repro test fails today.
 *
 * Run: bun test apps/mobile/components/chat/__tests__/queued-turn-resume-network-error.repro.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import * as webStreams from "node:stream/web"
import type { Chat as ChatT, UIMessage } from "@ai-sdk/react"
import { createAutoResumingFetch } from "@shogo/shared-app/chat"
import { withResumeReplayReset } from "../resume-replay-transport"

// The happy-dom preload replaces the global web-stream classes with
// non-WHATWG ones. `eventsource-parser`'s `EventSourceParserStream` extends
// the global `TransformStream` at module-evaluation time, so the natives must
// be installed BEFORE `ai` is loaded — hence the dynamic imports below.
const STREAM_GLOBALS = ["ReadableStream", "WritableStream", "TransformStream", "TextDecoderStream"] as const
const preloadStreams = STREAM_GLOBALS.map((k) => (globalThis as any)[k])
for (const k of STREAM_GLOBALS) (globalThis as any)[k] = (webStreams as any)[k]
afterAll(() => {
  STREAM_GLOBALS.forEach((k, i) => ((globalThis as any)[k] = preloadStreams[i]))
})

let Chat!: typeof ChatT
let DefaultChatTransport!: typeof import("ai").DefaultChatTransport
beforeAll(async () => {
  ;({ Chat } = await import("@ai-sdk/react"))
  ;({ DefaultChatTransport } = await import("ai"))
})

const TURN_ID = "d7cc300e-efa7-498f-8e32-1c6e76635859"
const SESSION_ID = "bde7bc1c-5308-4330-a33a-bdb0ab0dadc5"
const CHAT_API = "https://studio.shogo.ai/api/projects/70494906-f391-459b-a129-8a7da09ef707/chat"
const STREAM_URL = `${CHAT_API}/${SESSION_ID}/stream`

function sse(event: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
}

const TURN_HEAD = [
  sse({ type: "start" }),
  sse({ type: "data-turn-start", data: { turnId: TURN_ID, chatSessionId: SESSION_ID } }),
  sse({ type: "text-start", id: "t0" }),
  sse({ type: "text-delta", id: "t0", delta: "working on the HR pipeline… " }),
  sse({ type: "data-turn-seq", data: { turnId: TURN_ID, seq: 42 }, transient: true }),
]

const TURN_TAIL = [
  sse({ type: "text-delta", id: "t0", delta: "done." }),
  sse({ type: "text-end", id: "t0" }),
  sse({ type: "data-turn-complete", data: { turnId: TURN_ID, status: "completed" } }),
  sse({ type: "finish" }),
]

/** Yields `chunks`, then the next `read()` rejects — Chrome's ERR_HTTP2_PROTOCOL_ERROR. */
function bodyThatDiesMidTurn(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++])
        return
      }
      controller.error(new TypeError("network error"))
    },
  })
}

function bodyOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    },
  })
}

const sseHeaders = (extra: Record<string, string>) => ({
  "Content-Type": "text/event-stream",
  "X-Turn-Id": TURN_ID,
  ...extra,
})

/**
 * Mimics the production API: POST /chat and GET /<sid>/stream both carry the
 * turn on a body that dies mid-turn; GET /<sid>/stream?fromSeq=42 serves the
 * buffered remainder (the runtime is still streaming the turn).
 */
function makeBaseFetch(calls: Array<{ method: string; url: string }>) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? "GET").toUpperCase()
    calls.push({ method, url })
    if (method === "POST") {
      return new Response(bodyThatDiesMidTurn(TURN_HEAD), {
        status: 200,
        headers: sseHeaders({ "X-Chat-Session-Id": SESSION_ID }),
      })
    }
    if (url === STREAM_URL) {
      // The runtime's /stream proxy exposes X-Turn-Id but not X-Chat-Session-Id.
      return new Response(bodyThatDiesMidTurn(TURN_HEAD), { status: 200, headers: sseHeaders({}) })
    }
    if (url.startsWith(`${STREAM_URL}?fromSeq=`)) {
      return new Response(bodyOf(TURN_TAIL), { status: 200, headers: sseHeaders({}) })
    }
    return new Response(null, { status: 204 })
  }) as typeof globalThis.fetch
}

/** Wire up exactly like ChatPanel: useChatTransportConfig → DefaultChatTransport → withResumeReplayReset → useChat. */
function buildChat(calls: Array<{ method: string; url: string }>) {
  const errors: unknown[] = []
  // Production passes no logger → console (captured by Sentry as breadcrumbs).
  const fetch = createAutoResumingFetch(makeBaseFetch(calls), {
    initialBackoffMs: 0,
    maxBackoffMs: 0,
  })
  const transport = withResumeReplayReset<UIMessage>(
    new DefaultChatTransport<UIMessage>({ api: CHAT_API, credentials: "include", fetch }),
    () => {},
  )
  const chat: ChatT<UIMessage> = new Chat<UIMessage>({
    id: SESSION_ID,
    transport,
    onError: (err) => errors.push(err),
  })
  return { chat, errors }
}

// Stand-in for Sentry's console breadcrumb integration.
let breadcrumbs: string[] = []
const originalWarn = console.warn
const originalLog = console.log
beforeEach(() => {
  breadcrumbs = []
  console.warn = (...args: unknown[]) => void breadcrumbs.push(args.map(String).join(" "))
  console.log = (...args: unknown[]) => void breadcrumbs.push(args.map(String).join(" "))
})
afterEach(() => {
  console.warn = originalWarn
  console.log = originalLog
})

const autoResumeCrumbs = () => breadcrumbs.filter((b) => b.includes("[AutoResume"))

describe("JAVASCRIPT-REACT-46: mid-turn network error on a resumeStream() GET", () => {
  test("control: the same mid-stream failure on the chat POST is auto-resumed", async () => {
    const calls: Array<{ method: string; url: string }> = []
    const { chat, errors } = buildChat(calls)

    await chat.sendMessage({ text: "set up the recruiting pipeline" })

    expect(errors).toEqual([])
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${CHAT_API}`,
      `GET ${STREAM_URL}?fromSeq=42`,
    ])
    expect(autoResumeCrumbs().some((b) => b.includes("stream errored mid-turn (network error); reconnecting fromSeq=42"))).toBe(true)
  })

  test("queued-turn attach via resumeStream(): network error should resume from fromSeq, not reach onError", async () => {
    const calls: Array<{ method: string; url: string }> = []
    const { chat, errors } = buildChat(calls)

    // What useServerMessageQueue.onTurnAvailable → resumeQueuedTurn does after
    // the server dispatched the queued message as a new turn.
    await chat.resumeStream()

    const observed = {
      requests: calls.map((c) => `${c.method} ${c.url}`),
      onErrorMessages: errors.map((e) => `${(e as Error)?.name}: ${(e as Error)?.message}`),
      autoResumeBreadcrumbs: autoResumeCrumbs(),
      status: chat.status,
    }

    // Today: requests=[GET …/stream] only, onError=["TypeError: network error"],
    // autoResumeBreadcrumbs=[], status="error" — exactly the Sentry event.
    expect(observed).toEqual({
      requests: [`GET ${STREAM_URL}`, `GET ${STREAM_URL}?fromSeq=42`],
      onErrorMessages: [],
      autoResumeBreadcrumbs: expect.arrayContaining([expect.stringContaining("reconnecting fromSeq=42")]),
      status: "ready",
    })
  })
})
