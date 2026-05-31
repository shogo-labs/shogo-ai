// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pending ask_user attachment — derivation + in-stream routing contract.
 *
 * The interactive question UI is attached above the chat input (like the
 * message queue) instead of rendered inline. ChatPanel derives the pending
 * question via `derivePendingQuestion`; AssistantContent routes a given
 * ask_user part to a collapsed bar (pending) or the answered summary widget
 * via `askUserStreamVariant`. These pure helpers are the single source of
 * truth, imported by both the panel and this test.
 *
 * Run: bun test apps/mobile/components/chat/__tests__/pending-question-attachment.test.ts
 */

import { describe, test, expect } from "bun:test"
import type { UIMessage } from "@ai-sdk/react"
import {
  derivePendingQuestion,
  askUserStreamVariant,
} from "../turns/pendingQuestion"

function assistantWithAskUser(part: Record<string, unknown>): UIMessage {
  return {
    id: "msg-assistant-1",
    role: "assistant",
    parts: [{ type: "text", text: "Let me ask." }, part],
  } as unknown as UIMessage
}

const PENDING_PART = {
  type: "dynamic-tool",
  toolName: "ask_user",
  toolCallId: "call-abc",
  state: "input-available",
  input: {
    questions: [
      {
        header: "Stack",
        question: "Which stack?",
        options: [
          { label: "Next.js", description: "" },
          { label: "Remix", description: "" },
        ],
      },
    ],
  },
}

describe("derivePendingQuestion", () => {
  test("returns null when there are no messages", () => {
    expect(derivePendingQuestion([])).toBeNull()
  })

  test("returns null when the last message is from the user", () => {
    const messages = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
    ] as unknown as UIMessage[]
    expect(derivePendingQuestion(messages)).toBeNull()
  })

  test("captures messageId + tool data for a pending ask_user", () => {
    const messages = [assistantWithAskUser(PENDING_PART)]
    const pending = derivePendingQuestion(messages)

    expect(pending).not.toBeNull()
    expect(pending!.messageId).toBe("msg-assistant-1")
    expect(pending!.tool.id).toBe("call-abc")
    expect(pending!.tool.toolName).toBe("ask_user")
    // `input` becomes `args`, `output` becomes `result`.
    expect((pending!.tool.args as any).questions).toHaveLength(1)
    expect(pending!.tool.result).toBeUndefined()
  })

  test("treats input-streaming as pending too", () => {
    const messages = [
      assistantWithAskUser({ ...PENDING_PART, state: "input-streaming" }),
    ]
    expect(derivePendingQuestion(messages)).not.toBeNull()
  })

  test("returns null once the question is answered (output-available)", () => {
    const messages = [
      assistantWithAskUser({
        ...PENDING_PART,
        state: "output-available",
        output: "Next.js",
      }),
    ]
    expect(derivePendingQuestion(messages)).toBeNull()
  })

  test("only considers the LAST message — an older pending ask_user does not count", () => {
    const messages = [
      assistantWithAskUser(PENDING_PART),
      { id: "u2", role: "user", parts: [{ type: "text", text: "Next.js" }] },
    ] as unknown as UIMessage[]
    expect(derivePendingQuestion(messages)).toBeNull()
  })

  test("falls back to a stable id when toolCallId is missing", () => {
    const { toolCallId, ...noId } = PENDING_PART
    const messages = [assistantWithAskUser(noId)]
    expect(derivePendingQuestion(messages)!.tool.id).toBe("tool-ask_user")
  })
})

describe("askUserStreamVariant", () => {
  test("pending (no result) renders the collapsed bar in-stream", () => {
    expect(askUserStreamVariant(undefined)).toBe("bar")
  })

  test("answered (result present) renders the summary widget in-stream", () => {
    expect(askUserStreamVariant("Next.js")).toBe("widget")
    expect(askUserStreamVariant("")).toBe("widget")
  })
})
