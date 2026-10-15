// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression test for #1083: a long agent turn died with React #185
 * ("Maximum update depth exceeded") while the SDK applied a buffered burst of
 * `tool-input-delta` chunks. `useChat`'s leading-edge throttle turned every
 * chunk into a synchronous render once a render outlasted the throttle window,
 * and `useThrottledWhileStreaming` queued a Default-lane update from its
 * passive effect after each of those commits; with no macrotask in between,
 * React's nested-update counter passed 50 inside the SDK's `write()`.
 *
 * Drives the real `useChat` with the production hook and a render cost above
 * the publication window. Timings are scaled down 10× (publication 120 → 12ms,
 * hook 50 → 5ms, render ~130 → 13ms).
 *
 * `REPRO_BASELINE=1` also runs the pre-fix configuration (plain `useChat` with
 * `experimental_throttle`) and logs whether it crashes on the installed stack.
 *
 * Run (from apps/mobile): bun test components/chat/__tests__/use-chat-burst-185.repro.test.tsx
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { ReadableStream as WebReadableStream, TransformStream as WebTransformStream } from "node:stream/web"
import React from "react"
import { createRoot } from "react-dom/client"
import { useChat, type UIMessage } from "@ai-sdk/react"
import { PacedChat } from "../paced-chat"
import { coalesceChunkBursts } from "../chunk-coalescer"
import { useThrottledWhileStreaming } from "../turns/use-throttled-while-streaming"

type Chunk = Record<string, unknown>

const PUBLISH_MS = 12
const HOOK_MS = 5
const RENDER_COST_MS = 13
const DELTA = "lorem ipsum dolor sit amet "

const preloadTransformStream = globalThis.TransformStream
const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
const preloadActEnv = g.IS_REACT_ACT_ENVIRONMENT
beforeAll(() => {
  // happy-dom installs a non-WHATWG TransformStream; the SDK's stream
  // processor requires the node:stream/web implementation.
  globalThis.TransformStream = WebTransformStream as typeof TransformStream
  g.IS_REACT_ACT_ENVIRONMENT = false
})
afterAll(() => {
  globalThis.TransformStream = preloadTransformStream
  g.IS_REACT_ACT_ENVIRONMENT = preloadActEnv
})

function busy(ms: number) {
  const end = performance.now() + ms
  while (performance.now() < end) {
    /* simulated render cost */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** One `write_file` whose arguments stream as `deltas` small chunks. */
function bigWriteChunks(deltas: number): Chunk[] {
  const chunks: Chunk[] = [
    { type: "start", messageId: "a1" },
    { type: "start-step" },
    { type: "tool-input-start", toolCallId: "t1", toolName: "write_file" },
    { type: "tool-input-delta", toolCallId: "t1", inputTextDelta: '{"path":"issue-body.md","content":"' },
  ]
  for (let i = 0; i < deltas; i++) chunks.push({ type: "tool-input-delta", toolCallId: "t1", inputTextDelta: DELTA })
  chunks.push({ type: "tool-input-delta", toolCallId: "t1", inputTextDelta: '"}' })
  chunks.push({ type: "finish-step" }, { type: "finish" })
  return chunks
}

/** Many small tool calls: consecutive chunks belong to different parts, so the coalescer cannot merge them. */
function manyToolCallChunks(calls: number): Chunk[] {
  const chunks: Chunk[] = [{ type: "start", messageId: "a1" }, { type: "start-step" }]
  for (let i = 0; i < calls; i++) {
    const id = `t${i}`
    chunks.push({ type: "tool-input-start", toolCallId: id, toolName: "read_file" })
    chunks.push({ type: "tool-input-delta", toolCallId: id, inputTextDelta: `{"path":"f${i}.ts"}` })
    chunks.push({ type: "tool-input-available", toolCallId: id, toolName: "read_file", input: { path: `f${i}.ts` } })
    chunks.push({ type: "tool-output-available", toolCallId: id, output: { content: `file ${i}` } })
  }
  chunks.push({ type: "finish-step" }, { type: "finish" })
  return chunks
}

function makeTransport(chunks: Chunk[], { spreadMs = 0, coalesce = false } = {}, arrival = { lastChunkAt: 0 }) {
  return {
    async sendMessages() {
      const source = new WebReadableStream<Chunk>({
        async start(controller) {
          for (const chunk of chunks) {
            if (spreadMs) await sleep(spreadMs)
            controller.enqueue(chunk)
          }
          arrival.lastChunkAt = performance.now()
          controller.close()
        },
      }) as unknown as ReadableStream<any>
      return coalesce ? coalesceChunkBursts(source) : source
    },
    async reconnectToStream() {
      return null
    },
  }
}

type Measure = (message: UIMessage | undefined) => number

const writeContentLength: Measure = (message) => {
  const part = message?.parts?.find((p: any) => typeof p.type === "string" && p.type.startsWith("tool")) as any
  return part?.input?.content?.length ?? 0
}
const toolCallCount: Measure = (message) =>
  message?.parts?.filter((p: any) => typeof p.type === "string" && p.type.startsWith("tool-")).length ?? 0

interface RunResult {
  error: unknown
  renders: number
  status: string
  elapsedMs: number
  shown: number
  shownCompleteAtMs: number | null
  /** When the transport enqueued its last chunk, relative to send. */
  arrivalMs: number
}

async function run({
  chunks,
  expected,
  measure,
  mode,
  spreadMs = 0,
  coalesce = false,
}: {
  chunks: Chunk[]
  expected: number
  measure: Measure
  mode: "paced" | "sdk-throttle"
  spreadMs?: number
  coalesce?: boolean
}): Promise<RunResult> {
  const arrival = { lastChunkAt: 0 }
  const transport = makeTransport(chunks, { spreadMs, coalesce }, arrival)
  let error: unknown = null
  const onError = (e: unknown) => {
    error ??= e
  }
  const chat = mode === "paced" ? new PacedChat({ transport: transport as any, publishWaitMs: PUBLISH_MS, onError }) : null
  let renders = 0
  let shown = 0
  let shownCompleteAt: number | null = null
  let status = ""
  let send: ((m: { text: string }) => Promise<void>) | null = null
  const t0Ref = { t0: 0 }

  function Assistant({ message, isStreaming }: { message: UIMessage; isStreaming: boolean }) {
    const visible = useThrottledWhileStreaming(message, isStreaming, HOOK_MS)
    busy(RENDER_COST_MS)
    renders++
    shown = measure(visible)
    if (shown >= expected && shownCompleteAt === null) shownCompleteAt = performance.now() - t0Ref.t0
    return React.createElement("div", null, String(shown))
  }

  function Panel() {
    const result = chat
      ? useChat({ chat })
      : useChat({ transport: transport as any, experimental_throttle: PUBLISH_MS, onError })
    send = result.sendMessage as any
    status = result.status
    const last = result.messages[result.messages.length - 1]
    return last?.role === "assistant"
      ? React.createElement(Assistant, { message: last, isStreaming: result.status === "streaming" })
      : null
  }

  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(React.createElement(Panel))
  await sleep(20)
  t0Ref.t0 = performance.now()
  await send!({ text: "go" }).catch(onError)
  for (let i = 0; i < 50 && status !== "ready" && status !== "error"; i++) await sleep(20)
  await sleep(50)
  const elapsedMs = performance.now() - t0Ref.t0
  root.unmount()
  container.remove()
  return {
    error,
    renders,
    status,
    elapsedMs,
    shown,
    shownCompleteAtMs: shownCompleteAt,
    arrivalMs: arrival.lastChunkAt - t0Ref.t0,
  }
}

const describeError = (e: unknown) => (e instanceof Error ? e.message.slice(0, 80) : e == null ? null : String(e))
const isDepthError = (e: unknown) => /Maximum update depth|#185/.test(describeError(e) ?? "")

// Render counts and latency depend on machine speed, so they are only
// asserted when REPRO_TIMING=1; CI checks correctness (no #185, full content).
const CHECK_TIMING = process.env.REPRO_TIMING === "1"

function expectHealthy(r: RunResult, expected: number) {
  expect(describeError(r.error)).toBeNull()
  expect(r.status).toBe("ready")
  expect(r.shown).toBe(expected)
  // About one render per publication window, not one per chunk.
  if (CHECK_TIMING) expect(r.renders).toBeLessThanOrEqual(Math.ceil(r.elapsedMs / PUBLISH_MS) + 5)
}

describe("#1083: buffered tool-input bursts never trip React's nested-update guard", () => {
  const DELTAS = 1500
  const bigExpected = DELTAS * DELTA.length

  test("1,500-delta write_file burst, no coalescer: paced publication alone keeps the stream alive", async () => {
    const r = await run({ chunks: bigWriteChunks(DELTAS), expected: bigExpected, measure: writeContentLength, mode: "paced" })
    expectHealthy(r, bigExpected)
    if (CHECK_TIMING) expect(r.renders).toBeLessThan(DELTAS / 10)
  }, 30_000)

  test("1,500-delta write_file burst through the production coalescer", async () => {
    const r = await run({
      chunks: bigWriteChunks(DELTAS),
      expected: bigExpected,
      measure: writeContentLength,
      mode: "paced",
      coalesce: true,
    })
    expectHealthy(r, bigExpected)
  }, 30_000)

  test("400 small tool calls (unmergeable chunks) through the coalescer", async () => {
    const calls = 400
    const r = await run({ chunks: manyToolCallChunks(calls), expected: calls, measure: toolCallCount, mode: "paced", coalesce: true })
    expectHealthy(r, calls)
    if (CHECK_TIMING) expect(r.renders).toBeLessThan(calls)
  }, 30_000)

  test("spread arrival: display keeps up with the stream", async () => {
    const deltas = 300
    const spreadMs = 3
    const expected = deltas * DELTA.length
    const r = await run({ chunks: bigWriteChunks(deltas), expected, measure: writeContentLength, mode: "paced", spreadMs })
    console.log(
      `[spread] arrival=${Math.round(r.arrivalMs)}ms shownComplete=${Math.round(r.shownCompleteAtMs ?? -1)}ms renders=${r.renders}`,
    )
    expectHealthy(r, expected)
    // Timers clamp small delays (about 15ms on Windows), so compare against
    // when the last chunk actually arrived, not the nominal spread.
    expect(r.shownCompleteAtMs).not.toBeNull()
    if (CHECK_TIMING) expect(r.shownCompleteAtMs! - r.arrivalMs).toBeLessThanOrEqual(Math.max(r.arrivalMs * 0.5, 300))
  }, 30_000)

  const baseline = process.env.REPRO_BASELINE === "1" ? test : test.skip
  baseline("baseline: plain useChat + experimental_throttle on the installed stack (logs the outcome)", async () => {
    for (const deltas of [150, 600, 1500]) {
      const expected = deltas * DELTA.length
      const r = await run({ chunks: bigWriteChunks(deltas), expected, measure: writeContentLength, mode: "sdk-throttle" })
      console.log(
        `[baseline] deltas=${deltas} ${isDepthError(r.error) ? "CRASH #185" : r.error ? "ERROR" : "ok"} renders=${r.renders} ` +
          `status=${r.status} ${Math.round(r.elapsedMs)}ms shown=${r.shown}/${expected} ${describeError(r.error) ?? ""}`,
      )
    }
  }, 120_000)
})
