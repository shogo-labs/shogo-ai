/**
 * useTurnGrouping Hook (React Native)
 *
 * Groups flat AI SDK message array into ConversationTurn objects.
 * Pure logic hook — identical to web version, no DOM dependencies.
 */

import { useMemo } from "react"
import type { UIMessage } from "@ai-sdk/react"
import type { ConversationTurn, MessagePart } from "./types"
import { type ToolCallData, getToolCategory } from "../tools/types"

function extractToolCallsFromMessage(message: UIMessage): ToolCallData[] {
  if (!("parts" in message) || !Array.isArray((message as any).parts)) {
    return []
  }

  return ((message as any).parts as any[])
    .filter((part) => part.type === "tool-invocation")
    .map((part, index) => {
      const invocation = part.toolInvocation
      const toolName = invocation?.toolName || "unknown"

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

function mapToolState(state?: string): ToolCallData["state"] {
  if (state === "result" || state === "output-available") return "success"
  if (state === "error" || state === "output-error") return "error"
  return "streaming"
}

function extractOrderedParts(message: UIMessage): MessagePart[] {
  const parts = (message as any).parts as any[] | undefined

  if (!parts || !Array.isArray(parts)) {
    if (typeof (message as any).content === "string" && (message as any).content) {
      return [{ type: "text", text: (message as any).content, id: "text-0" }]
    }
    return []
  }

  const result: MessagePart[] = []

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]

    if (part.type === "text") {
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
            error: inv.error,
            timestamp: Date.now(),
          },
        })
      }
    } else if (part.type === "dynamic-tool") {
      const toolCallId = part.toolCallId || `tool-${index}`
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
          args: part.input,
          result: part.output,
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

export function useTurnGrouping(
  messages: UIMessage[],
  isStreaming: boolean = false,
  externalToolCalls?: ToolCallData[]
): ConversationTurn[] {
  return useMemo(() => {
    const turns: ConversationTurn[] = []
    let currentTurn: ConversationTurn | null = null

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]

      if (message.role === "user") {
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
        if (!currentTurn) {
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

        if (i === messages.length - 1 && isStreaming) {
          currentTurn.isStreaming = true
        }
      }
    }

    if (currentTurn) {
      turns.push(currentTurn)
    }

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
