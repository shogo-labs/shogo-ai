// SPDX-License-Identifier: MIT
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
 *
 * Adjacent reasoning parts (no other part type between them) are
 * coalesced into a single `MessagePart` so they render as one
 * `ThinkingWidget` instead of N separate widgets that each open and
 * auto-close on their own ~3s timer. Extended-thinking models
 * (Anthropic with extended thinking, GPT-5 with reasoning) routinely
 * emit several `reasoning-start`/`reasoning-end` chunks back-to-back
 * — without coalescing, the chat column visibly bounces as the
 * cascade of close timers fires and the parent ScrollView auto-
 * follows each height change.
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
      const firstIndex = index
      let mergedText = ""
      let anyStreaming = false
      let totalDurationMs = 0
      let hasDuration = false

      while (index < parts.length && parts[index].type === "reasoning") {
        const r = parts[index]
        if (r.text) {
          if (mergedText.length > 0) mergedText += "\n\n"
          mergedText += r.text
        }
        if ("state" in r && r.state === "streaming") {
          anyStreaming = true
        }
        if (typeof r.durationMs === "number") {
          totalDurationMs += r.durationMs
          hasDuration = true
        }
        index++
      }
      // Step back so the outer-loop `index++` lands on the next part
      // (the one that broke the reasoning run).
      index--

      const hasContent = mergedText.trim().length > 0
      if (hasContent || anyStreaming) {
        result.push({
          type: "reasoning",
          text: mergedText,
          isStreaming: anyStreaming,
          durationSeconds: hasDuration
            ? Math.ceil(totalDurationMs / 1000)
            : undefined,
          // Key on the FIRST index of the run so the coalesced widget's
          // identity stays stable as later bursts get appended into it.
          id: `reasoning-${firstIndex}`,
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
