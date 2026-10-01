// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * REPRODUCTION for Sentry SHOGO-DESKTOP-14 — "Maximum update depth exceeded"
 * (web: `[ChatPanel] Stream error: Error: Minified React error #185`,
 * chatErrorClass=render) thrown while an assistant turn streams
 * `reasoning-delta` chunks.
 *
 * Production stack (react-dom 19.1.0, @ai-sdk/react 3.0.99, ai 6.0.97):
 *   getRootForUpdatedFiber <- forceStoreRerender <- subscribeToStore cb
 *   <- throttleit throttled() (delay elapsed -> called synchronously)
 *   <- ReactChatState._callMessagesCallbacks <- replaceMessage
 *   <- processUIMessageStream `case 'reasoning-delta'` write()
 *
 * Mechanism reproduced here:
 *   1. `useChat({ experimental_throttle: 120 })` re-renders via
 *      useSyncExternalStore -> `forceStoreRerender`, which is always SyncLane.
 *      Once 120ms have elapsed since the last call, throttleit invokes it
 *      synchronously from inside the stream's microtask chain.
 *   2. A SyncLane commit flushes passive effects synchronously. The
 *      `useThrottledWhileStreaming` effect in `AssistantContent` calls
 *      `setThrottled(value)` whenever its `message` prop changes (every
 *      streamed update, as long as >=50ms passed), scheduling DefaultLane
 *      work.
 *   3. React 19.1 increments `nestedUpdateCount` after any commit that leaves
 *      Sync/InputContinuous/Default lanes pending (react-dom-client
 *      `0 !== (remainingLanes & 42)`) and only resets it on a commit that
 *      leaves nothing pending. The pending DefaultLane render is a scheduler
 *      macrotask, so it can't run while buffered reasoning-deltas drain in
 *      one microtask chain.
 *   4. When a render costs >=120ms (long chats; heavy markdown), every
 *      buffered delta finds the throttle window elapsed, so each one produces
 *      another counted commit. After 50 of them, the next stream-driven
 *      `forceStoreRerender` throws #185 from inside the SDK's write(). The
 *      AI SDK reports it through `onError`, killing the turn.
 *
 * The "render cost" is simulated with a virtual clock (Date.now /
 * performance.now advance 130ms per render of a sibling stand-in for the
 * heavy turn list), so the test is deterministic and fast.
 *
 * Run (from apps/mobile):
 *   bun --no-env-file test components/chat/turns/__tests__/AssistantContent.update-depth.repro.test.tsx
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { cleanup, render, waitFor } from "@testing-library/react"
import React from "react"
import { ReadableStream as WebReadableStream, TransformStream as WebTransformStream } from "node:stream/web"
import { useChat, type UIMessage } from "@ai-sdk/react"

mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))
// Leaf widgets that don't load under happy-dom (legendapp/motion etc.) and
// aren't on the streaming-reasoning render path. AssistantContent itself,
// including `useThrottledWhileStreaming`, stays real.
mock.module("../ThinkingWidget", () => ({ ThinkingWidget: () => null }))
mock.module("../PlanningStatusLine", () => ({ PlanningStatusLine: () => null }))
mock.module("../WorkGroup", () => ({ WorkGroup: () => null }))
mock.module("../WorkedForGroup", () => ({ WorkedForGroup: () => null }))
mock.module("../ToolCallGroup", () => ({ ToolCallGroup: () => null }))
mock.module("../ConnectToolWidget", () => ({
  ConnectToolWidget: () => null,
  parseToolInstallResult: () => null,
}))

const { AssistantContent } = await import("../AssistantContent")

// happy-dom installs a non-WHATWG TransformStream; the AI SDK's stream
// processor requires the node:stream/web implementation.
const preloadTransformStream = globalThis.TransformStream
const preloadActEnv = (globalThis as any).IS_REACT_ACT_ENVIRONMENT
const preloadStackLimit = (Error as any).stackTraceLimit
beforeAll(() => {
  ;(Error as any).stackTraceLimit = 60
  globalThis.TransformStream = WebTransformStream as typeof TransformStream
  // Run on React's real microtask/scheduler path, not act()'s queue.
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = false
})
afterAll(() => {
  ;(Error as any).stackTraceLimit = preloadStackLimit
  globalThis.TransformStream = preloadTransformStream
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = preloadActEnv
})
afterEach(cleanup)

const realDateNow = Date.now
const realPerfNow = performance.now.bind(performance)
let virtualMs = 0
function installVirtualClock() {
  virtualMs = 0
  Date.now = () => realDateNow() + virtualMs
  performance.now = () => realPerfNow() + virtualMs
}
function restoreClock() {
  Date.now = realDateNow
  performance.now = realPerfNow
}

const REASONING_DELTAS = 120

/** A turn whose reasoning deltas are already buffered when the body is read. */
function bufferedReasoningTransport() {
  return {
    async sendMessages() {
      return new WebReadableStream({
        start(controller) {
          controller.enqueue({ type: "start", messageId: "assistant-1" })
          controller.enqueue({ type: "start-step" })
          controller.enqueue({ type: "reasoning-start", id: "r1" })
          for (let i = 0; i < REASONING_DELTAS; i++) {
            controller.enqueue({ type: "reasoning-delta", id: "r1", delta: `step ${i}. ` })
          }
          controller.enqueue({ type: "reasoning-end", id: "r1" })
          controller.enqueue({ type: "text-start", id: "t1" })
          controller.enqueue({ type: "text-delta", id: "t1", delta: "Done." })
          controller.enqueue({ type: "text-end", id: "t1" })
          controller.enqueue({ type: "finish-step" })
          controller.enqueue({ type: "finish" })
          controller.close()
        },
      })
    },
    async reconnectToStream() {
      return null
    },
  } as any
}

/** Stand-in for the expensive part of the chat tree (TurnList, markdown). */
function HeavyTurnListCost({ renderCostMs }: { renderCostMs: number; messages: UIMessage[] }) {
  virtualMs += renderCostMs
  return null
}

interface RunResult {
  errors: Error[]
  status: string
}

async function streamTurn(opts: { renderAssistantContent: boolean; renderCostMs: number }): Promise<RunResult> {
  installVirtualClock()
  const errors: Error[] = []
  let sendMessage!: (m: { text: string }) => Promise<void>
  let latestStatus = "ready"

  function ChatPanelHarness() {
    const chat = useChat({
      transport: bufferedReasoningTransport(),
      // Same value as ChatPanel.tsx's useChat call.
      experimental_throttle: 120,
      onError: (err) => errors.push(err),
    })
    sendMessage = chat.sendMessage as any
    latestStatus = chat.status
    const last = chat.messages[chat.messages.length - 1]
    return (
      <>
        <HeavyTurnListCost renderCostMs={opts.renderCostMs} messages={chat.messages} />
        {opts.renderAssistantContent && last?.role === "assistant" ? (
          <AssistantContent message={last} isStreaming={chat.status === "streaming"} />
        ) : null}
      </>
    )
  }

  try {
    render(<ChatPanelHarness />)
    await sendMessage({ text: "Plan the refactor." })
    await waitFor(() => expect(latestStatus === "ready" || latestStatus === "error").toBe(true))
  } finally {
    restoreClock()
  }
  return { errors, status: latestStatus }
}

const isDepthError = (e: Error) => /Maximum update depth exceeded|Minified React error #185/.test(String(e?.message))

describe("SHOGO-DESKTOP-14: streaming reasoning-deltas into AssistantContent", () => {
  test("REPRO: a slow-rendering chat streaming buffered reasoning-deltas must not hit React's update-depth limit", async () => {
    const { errors, status } = await streamTurn({ renderAssistantContent: true, renderCostMs: 130 })

    const depthErrors = errors.filter(isDepthError)
    if (depthErrors.length) {
      const frames = (depthErrors[0].stack ?? "")
        .split("\n")
        .filter((l) => /getRootForUpdatedFiber|forceStoreRerender|throttle|replaceMessage|processUIMessageStream|write/.test(l))
        .map((l) => l.trim().replace(/\(.*node_modules\/\.bun\//, "("))
      console.log(
        `[repro] useChat onError: ${depthErrors[0].message.slice(0, 40)}… | status: ${status}\n  ` +
          frames.join("\n  "),
      )
    }
    // Buggy behaviour: onError receives "Maximum update depth exceeded" and
    // the turn ends in status "error".
    expect(depthErrors.map((e) => e.message)).toEqual([])
    expect(status).toBe("ready")
  }, 30_000)

  test("control: same stream + same render cost without AssistantContent completes cleanly", async () => {
    const { errors, status } = await streamTurn({ renderAssistantContent: false, renderCostMs: 130 })
    expect(errors).toEqual([])
    expect(status).toBe("ready")
  }, 30_000)

  test("control: AssistantContent with fast renders completes cleanly (throttle defers to a macrotask)", async () => {
    const { errors, status } = await streamTurn({ renderAssistantContent: true, renderCostMs: 0 })
    expect(errors).toEqual([])
    expect(status).toBe("ready")
  }, 30_000)
})
