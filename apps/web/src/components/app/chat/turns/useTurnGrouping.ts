/**
 * useTurnGrouping Hook
 * Task: task-chat-004
 * Task: feat-chat-tool-interleaving
 *
 * Groups flat AI SDK message array into ConversationTurn objects.
 * A turn boundary is detected when a user message appears.
 * Now also extracts ordered parts for interleaved rendering.
 */

import { useMemo } from "react"
import type { Message } from "@ai-sdk/react"
import type { ConversationTurn, MessagePart } from "./types"
import { type ToolCallData, getToolCategory } from "../tools/types"

/**
 * Extract tool calls from a message (AI SDK v3 format).
 */
function extractToolCallsFromMessage(message: Message): ToolCallData[] {
  // AI SDK 4.2+ uses message.parts for tool invocations
  if (!("parts" in message) || !Array.isArray((message as any).parts)) {
    return []
  }

  return ((message as any).parts as any[])
    .filter((part) => part.type === "tool-invocation")
    .map((part, index) => {
      const invocation = part.toolInvocation
      const toolName = invocation?.toolName || "unknown"

      // Map state to our execution state
      let state: ToolCallData["state"] = "streaming"
      if (invocation?.state === "result") state = "success"
      if (invocation?.state === "error") state = "error"

      return {
        id: invocation?.toolCallId || `tool-${message.id}-${index}`,
        toolName,
        category: getToolCategory(toolName),
        state,
        args: invocation?.args,
        result: invocation?.result,
        error: invocation?.error,
        timestamp: Date.now(),
      }
    })
}

/**
 * Map AI SDK tool state to our ToolExecutionState
 * Handles both standard tool-invocation states and dynamic-tool states
 */
function mapToolState(state?: string): ToolCallData["state"] {
  if (state === "result" || state === "output-available") return "success"
  if (state === "error" || state === "output-error") return "error"
  return "streaming"
}

/**
 * Extract ordered parts from an AI SDK message.
 * Preserves the natural interleaving of text, tools, and images.
 */
function extractOrderedParts(message: Message): MessagePart[] {
  const parts = (message as any).parts as any[] | undefined

  // Fallback: single text part from content
  if (!parts || !Array.isArray(parts)) {
    if (typeof message.content === "string" && message.content) {
      return [{ type: "text", text: message.content, id: "text-0" }]
    }
    return []
  }

  const result: MessagePart[] = []

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]

    if (part.type === "text") {
      // Skip empty text parts
      if (part.text && part.text.trim()) {
        result.push({ type: "text", text: part.text, id: `text-${index}` })
      }
    } else if (part.type === "tool-invocation") {
      // Standard AI SDK tool-invocation format
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
            error: inv.error,
            timestamp: Date.now(),
          },
        })
      }
    } else if (part.type === "dynamic-tool") {
      // Claude Code provider dynamic-tool format
      // Data is directly on the part, not nested in toolInvocation
      const toolCallId = part.toolCallId || `tool-${index}`
      // For output-error, AI SDK puts error content in errorText, not output/error
      const errorContent =
        part.state === "output-error"
          ? (part as { errorText?: string }).errorText ?? part.error
          : part.error
      result.push({
        type: "tool",
        id: toolCallId,
        tool: {
          id: toolCallId,
          toolName: part.toolName || "unknown",
          category: getToolCategory(part.toolName || ""),
          state: mapToolState(part.state),
          args: part.input, // dynamic-tool uses 'input' not 'args'
          result: part.output, // dynamic-tool uses 'output' not 'result'
          error: errorContent,
          timestamp: Date.now(),
        },
      })
    } else if (
      part.type === "file" &&
      part.mediaType?.startsWith("image/") &&
      part.url
    ) {
      result.push({
        type: "image",
        url: part.url,
        mediaType: part.mediaType,
        id: `img-${index}`,
      })
    }
  }

  return result
}

/**
 * Hook that groups messages into ConversationTurn objects.
 *
 * Turn boundary detection:
 * - A user message starts a new turn
 * - Subsequent assistant messages and tool calls belong to the same turn
 *
 * @param messages - Flat array of AI SDK messages
 * @param isStreaming - Whether the chat is currently streaming
 * @param externalToolCalls - Additional tool calls from external sources (e.g., subagent progress events)
 * @returns Array of ConversationTurn objects
 *
 * @example
 * ```tsx
 * function ChatView({ messages, isLoading, subagentTools }) {
 *   const turns = useTurnGrouping(messages, isLoading, subagentTools)
 *
 *   return turns.map(turn => <TurnGroup key={turn.id} turn={turn} />)
 * }
 * ```
 */
export function useTurnGrouping(
  messages: Message[],
  isStreaming: boolean = false,
  externalToolCalls?: ToolCallData[]
): ConversationTurn[] {
  return useMemo(() => {
    const turns: ConversationTurn[] = []
    let currentTurn: ConversationTurn | null = null

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]

      if (message.role === "user") {
        // User message starts a new turn
        if (currentTurn) {
          turns.push(currentTurn)
        }

        currentTurn = {
          id: `turn-${message.id}`,
          userMessage: message,
          assistantMessage: null,
          toolCalls: [],
          assistantParts: [],
          timestamp: Date.now(),
          isStreaming: false,
        }
      } else if (message.role === "assistant") {
        // Assistant message belongs to current turn
        if (!currentTurn) {
          // Orphan assistant message (no preceding user message)
          currentTurn = {
            id: `turn-${message.id}`,
            userMessage: null,
            assistantMessage: null,
            toolCalls: [],
            assistantParts: [],
            timestamp: Date.now(),
            isStreaming: false,
          }
        }

        currentTurn.assistantMessage = message
        currentTurn.toolCalls = extractToolCallsFromMessage(message)
        currentTurn.assistantParts = extractOrderedParts(message)

        // Mark streaming if this is the last message and we're streaming
        if (i === messages.length - 1 && isStreaming) {
          currentTurn.isStreaming = true
        }
      }
    }

    // Don't forget the last turn
    if (currentTurn) {
      turns.push(currentTurn)
    }

    // Merge external tool calls (from subagent progress events) into the last turn
    // This allows subagent tools to appear in the timeline even though they
    // don't come through the standard tool-invocation message parts
    if (externalToolCalls && externalToolCalls.length > 0 && turns.length > 0) {
      const lastTurn = turns[turns.length - 1]
      const existingIds = new Set(lastTurn.toolCalls.map((t) => t.id))
      const uniqueExternalTools = externalToolCalls.filter(
        (t) => !existingIds.has(t.id)
      )
      if (uniqueExternalTools.length > 0) {
        lastTurn.toolCalls = [...lastTurn.toolCalls, ...uniqueExternalTools]
      }
    }

    return turns
  }, [messages, isStreaming, externalToolCalls])
}

export default useTurnGrouping
