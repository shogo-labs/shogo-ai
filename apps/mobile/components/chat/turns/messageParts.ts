// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared helpers for normalizing AI SDK `UIMessage.parts` into the
 * `MessagePart` shape rendered by the chat UI, plus a small extractor
 * that returns just the task / agent_spawn tool calls so non-chat
 * surfaces (e.g. the Shogo Mode overlay) can render the same
 * `<SubagentCard>` UI without duplicating part-parsing.
 *
 * The AssistantContent component used to own these helpers privately;
 * they have been hoisted here so `ChatPanel` can publish a snapshot of
 * subagent tool calls through the ChatBridge for the Shogo overlay.
 */

import type { UIMessage } from "@ai-sdk/react"
import type { MessagePart } from "./types"
import { type ToolCallData, getToolCategory } from "../tools/types"

export const TASK_TOOL_NAMES = new Set(["task", "Task", "agent_spawn"])

export function safeErrorString(error: unknown): string | undefined {
  if (error == null) return undefined
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Translate an AI SDK tool-part state into a tri-state ToolCallData state.
 *
 * `preliminary: true` keeps a tool call in `streaming` even after the
 * runtime has produced an `output-available` event — that's how
 * subagent / browser tools stream interim updates while still running.
 */
export function mapToolState(
  state?: string,
  preliminary?: boolean,
): ToolCallData["state"] {
  if (state === "input-streaming") return "streaming"
  if (state === "output-available") return preliminary ? "streaming" : "success"
  if (state === "output-error") return "error"
  if (state === "result") return "success"
  if (state === "error") return "error"
  return "streaming"
}

/**
 * Convert AI SDK `UIMessage.parts` into the ordered `MessagePart[]`
 * structure rendered by AssistantContent and the Shogo overlay.
 */
export function extractOrderedParts(message: UIMessage): MessagePart[] {
  const parts = (message as any).parts as any[] | undefined

  if (!parts || !Array.isArray(parts)) {
    if (
      typeof (message as any).content === "string" &&
      (message as any).content
    ) {
      return [{ type: "text", text: (message as any).content, id: "text-0" }]
    }
    return []
  }

  const result: MessagePart[] = []

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]

    if (part.type === "reasoning") {
      const hasContent = part.text?.trim().length > 0
      const isPartStreaming = "state" in part && part.state === "streaming"
      if (hasContent || isPartStreaming) {
        const durationMs = part.durationMs as number | undefined
        result.push({
          type: "reasoning",
          text: part.text || "",
          isStreaming: isPartStreaming,
          durationSeconds: durationMs ? Math.ceil(durationMs / 1000) : undefined,
          id: `reasoning-${index}`,
        })
      }
    } else if (part.type === "text") {
      if (part.text && part.text.trim()) {
        result.push({ type: "text", text: part.text, id: `text-${index}` })
      }
    } else if (part.type === "tool-invocation") {
      const inv = part.toolInvocation
      if (inv) {
        result.push({
          type: "tool",
          id: inv.toolCallId || `tool-${index}`,
          tool: {
            id: inv.toolCallId || `tool-${index}`,
            toolName: inv.toolName || "unknown",
            category: getToolCategory(inv.toolName || ""),
            state: mapToolState(inv.state),
            args: inv.args,
            result: inv.result,
            error: safeErrorString(inv.error),
            timestamp: 0,
          },
        })
      }
    } else if (part.type === "dynamic-tool") {
      const toolCallId = part.toolCallId || `tool-${index}`
      const rawError =
        part.state === "output-error"
          ? (part as { errorText?: string }).errorText ?? part.error
          : part.error
      const preliminary =
        part.state === "output-available" && (part as any).preliminary === true
      result.push({
        type: "tool",
        id: toolCallId,
        tool: {
          id: toolCallId,
          toolName: part.toolName || "unknown",
          category: getToolCategory(part.toolName || ""),
          state: mapToolState(part.state, preliminary),
          args: part.input,
          result: part.output,
          error: safeErrorString(rawError),
          timestamp: 0,
        },
      })
    } else if (part.type === "file" && part.url) {
      if (part.mediaType?.startsWith("image/")) {
        result.push({
          type: "image",
          url: part.url,
          mediaType: part.mediaType,
          id: `img-${index}`,
        })
      } else {
        result.push({
          type: "file",
          url: part.url,
          mediaType: part.mediaType || "application/octet-stream",
          id: `file-${index}`,
        })
      }
    }
  }

  return result
}

/**
 * Walk every assistant message in `messages` and return the ordered list
 * of `task` / `Task` / `agent_spawn` tool calls as `ToolCallData`. The
 * Shogo Mode overlay re-uses this snapshot to render `<SubagentCard>`
 * without owning any AI SDK message state itself.
 *
 * The returned array is keyed by the tool call id, so re-deriving it on
 * every messages update produces a stable identity for cards that have
 * not changed (within the limits of new ToolCallData objects per call).
 */
export function extractTaskToolsFromMessages(
  messages: readonly UIMessage[],
): ToolCallData[] {
  const out: ToolCallData[] = []
  for (const msg of messages) {
    if ((msg as any).role !== "assistant") continue
    const parts = extractOrderedParts(msg)
    for (const part of parts) {
      if (part.type !== "tool") continue
      if (!TASK_TOOL_NAMES.has(part.tool.toolName)) continue
      out.push(part.tool)
    }
  }
  return out
}
