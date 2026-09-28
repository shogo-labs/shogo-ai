// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression test for Sentry JAVASCRIPT-REACT-45.
 *
 * The staging crash occurred while a long-running assistant turn updated a
 * message containing a large tool payload:
 *
 *   DataCloneError: Failed to execute 'structuredClone' on 'Window':
 *   Data cannot be cloned, out of memory.
 *
 * @ai-sdk/react <= 3.0.99 deep-cloned the whole assistant message from
 * ReactChatState.replaceMessage() on every stream update. The current 3.x
 * release snapshots only the message and its top-level parts, so large nested
 * tool output is not repeatedly cloned.
 *
 * Run:
 *   bun test apps/mobile/components/chat/__tests__/structured-clone-memory.repro.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { ReadableStream as WebReadableStream, TransformStream as WebTransformStream } from "node:stream/web"
import { Chat, type UIMessage } from "@ai-sdk/react"

type Chunk = Record<string, unknown>

// happy-dom installs a non-WHATWG TransformStream; the AI SDK's stream
// processor requires the implementation from node:stream/web.
const preloadTransformStream = globalThis.TransformStream
beforeAll(() => {
  globalThis.TransformStream = WebTransformStream as typeof TransformStream
})
afterAll(() => {
  globalThis.TransformStream = preloadTransformStream
})

function chunkStream(chunks: Chunk[]): ReadableStream<Chunk> {
  return new WebReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  }) as unknown as ReadableStream<Chunk>
}

function lastAssistant(chat: Chat<UIMessage>): UIMessage {
  const assistant = [...chat.messages]
    .reverse()
    .find((message) => message.role === "assistant")
  if (!assistant) {
    throw new Error(`no assistant message (status=${chat.status})`)
  }
  return assistant
}

describe("REPRODUCTION: large streaming tool payload must not deep-clone", () => {
  test("a large tool result completes without invoking structuredClone on the message", async () => {
    const originalStructuredClone = globalThis.structuredClone
    let messageCloneAttempts = 0

    // This is a deterministic stand-in for the browser's memory failure. The
    // old SDK called structuredClone(message) here; the fixed SDK must not.
    globalThis.structuredClone = ((value: unknown) => {
      if (
        value &&
        typeof value === "object" &&
        "parts" in (value as Record<string, unknown>)
      ) {
        messageCloneAttempts++
        throw new DOMException(
          "Failed to execute 'structuredClone' on 'Window': Data cannot be cloned, out of memory.",
          "DataCloneError",
        )
      }
      return originalStructuredClone(value)
    }) as typeof structuredClone

    try {
      const largeToolOutput = {
        files: Array.from({ length: 2048 }, (_, index) => ({
          path: `src/generated/${index}.tsx`,
          content: "x".repeat(512),
        })),
      }
      const chat = new Chat<UIMessage>({
        id: "structured-clone-memory-repro",
        transport: {
          async sendMessages() {
            return chunkStream([
              {
                type: "tool-input-start",
                toolCallId: "tool-1",
                toolName: "read_workspace",
                dynamic: true,
              },
              {
                type: "tool-input-available",
                toolCallId: "tool-1",
                toolName: "read_workspace",
                input: { path: "src" },
                dynamic: true,
              },
              {
                type: "tool-output-available",
                toolCallId: "tool-1",
                output: largeToolOutput,
              },
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "Done." },
              { type: "text-end", id: "text-1" },
            ])
          },
        },
      })

      await chat.sendMessage({ text: "Inspect the workspace." })
      const assistant = lastAssistant(chat)

      expect(chat.error).toBeUndefined()
      expect(chat.status).toBe("ready")
      expect(assistant.parts?.some((part) => part.type === "dynamic-tool")).toBe(true)
      expect(messageCloneAttempts).toBe(0)
    } finally {
      globalThis.structuredClone = originalStructuredClone
    }
  })
})
