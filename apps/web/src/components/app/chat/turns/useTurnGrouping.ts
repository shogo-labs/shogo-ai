/**
 * useTurnGrouping Hook
 * Task: task-chat-004
 *
 * Groups flat AI SDK message array into ConversationTurn objects.
 * A turn boundary is detected when a user message appears.
 */

import { useMemo } from "react"
import type { Message } from "@ai-sdk/react"
import type { ConversationTurn } from "./types"
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
            timestamp: Date.now(),
            isStreaming: false,
          }
        }

        currentTurn.assistantMessage = message
        currentTurn.toolCalls = extractToolCallsFromMessage(message)

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
