// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pending `ask_user` derivation.
 *
 * The interactive question UI is attached above the chat input (like the
 * message queue) rather than rendered inline in the message stream. ChatPanel
 * derives the pending question from the live message list with
 * `derivePendingQuestion`; AssistantContent decides whether a given `ask_user`
 * part renders as a collapsed in-stream bar or the answered summary widget with
 * `askUserStreamVariant`. Both are pure so they can be unit-tested without
 * React / React Native.
 */

import type { UIMessage } from "@ai-sdk/react"
import { type ToolCallData, getToolCategory } from "../tools/types"
import { mapToolState } from "./messageParts"

export interface PendingQuestion {
  messageId: string
  tool: ToolCallData
}

/**
 * Returns the pending `ask_user` tool call in the last assistant message, or
 * `null` when there is no open question. A question is "pending" while its
 * dynamic-tool part is still awaiting input (`input-available` /
 * `input-streaming`) — i.e. the agent has asked but no answer has been
 * persisted yet.
 */
export function derivePendingQuestion(
  messages: readonly UIMessage[],
): PendingQuestion | null {
  const lastMsg = messages[messages.length - 1]
  if (!lastMsg || (lastMsg as any).role !== "assistant") return null
  const parts = (lastMsg as any).parts as any[] | undefined
  if (!parts) return null
  const part = parts.find(
    (p: any) =>
      p.type === "dynamic-tool" &&
      p.toolName === "ask_user" &&
      (p.state === "input-available" || p.state === "input-streaming"),
  )
  if (!part) return null
  const toolCallId = part.toolCallId || "tool-ask_user"
  return {
    messageId: (lastMsg as any).id,
    tool: {
      id: toolCallId,
      toolName: "ask_user",
      category: getToolCategory("ask_user"),
      state: mapToolState(part.state),
      args: part.input,
      result: part.output,
      timestamp: 0,
    },
  }
}

/**
 * How an `ask_user` part should render in the message stream.
 *
 * - `"bar"`: pending — a small collapsed status bar (the interactive widget
 *   lives attached above the composer).
 * - `"widget"`: answered — the existing collapsed summary widget.
 */
export function askUserStreamVariant(toolResult: unknown): "bar" | "widget" {
  return toolResult === undefined ? "bar" : "widget"
}
