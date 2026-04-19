// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useTurnGrouping Hook (React Native)
 *
 * Groups flat AI SDK message array into ConversationTurn objects.
 * Pure logic hook — identical to web version, no DOM dependencies.
 *
 * PERFORMANCE:
 * The AI SDK mutates the LAST message (new reference) on every streaming token,
 * but historical messages keep stable references. We exploit this by caching
 * previous turns and reusing turn objects whose (userMessage, assistantMessage,
 * isStreaming) inputs are referentially equal across renders. That keeps the
 * `turn` prop stable for historical TurnGroups so their React.memo bails in,
 * avoiding a full TurnGroup/AssistantContent re-render for every historical
 * turn on every streaming character.
 */

import { useMemo, useRef } from "react"
import type { UIMessage } from "@ai-sdk/react"
import type { ConversationTurn, MessagePart } from "./types"
import { type ToolCallData, getToolCategory } from "../tools/types"

function safeErrorString(error: unknown): string | undefined {
  if (error == null) return undefined
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  return String(error)
}

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
        error: safeErrorString(invocation?.error),
        timestamp: 0,
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
 * Lightweight descriptor used to match a turn to a cached entry.
 * Keyed by turn.id (which is derived from the first message of the turn
 * and therefore stable once the turn exists).
 */
interface TurnSkeleton {
  id: string
  userMessage: UIMessage | null
  assistantMessage: UIMessage | null
  isStreaming: boolean
  timestamp: number
}

/**
 * Pure function that groups flat messages into turns while reusing
 * previously-computed turn objects whose inputs are referentially equal.
 *
 * Exported for unit testing. Keep no React imports in this function.
 */
export function groupMessagesIntoTurns(
  messages: UIMessage[],
  isStreaming: boolean,
  externalToolCalls: ToolCallData[] | undefined,
  prevTurns: ConversationTurn[] | undefined,
): ConversationTurn[] {
  const skeletons: TurnSkeleton[] = []
  let current: TurnSkeleton | null = null

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    const ts = (message as any).createdAt?.getTime?.() ?? 0

    if (message.role === "user") {
      if (current) skeletons.push(current)
      current = {
        id: `turn-${message.id}`,
        userMessage: message,
        assistantMessage: null,
        isStreaming: false,
        timestamp: ts,
      }
    } else if (message.role === "assistant") {
      if (!current) {
        current = {
          id: `turn-${message.id}`,
          userMessage: null,
          assistantMessage: null,
          isStreaming: false,
          timestamp: ts,
        }
      }
      current.assistantMessage = message
      if (i === messages.length - 1 && isStreaming) {
        current.isStreaming = true
      }
    }
  }
  if (current) skeletons.push(current)

  const prevById = new Map<string, ConversationTurn>()
  if (prevTurns) {
    for (const t of prevTurns) prevById.set(t.id, t)
  }

  const result: ConversationTurn[] = []
  for (let idx = 0; idx < skeletons.length; idx++) {
    const skel = skeletons[idx]
    const prior = prevById.get(skel.id)

    // Reuse prior turn when its inputs are referentially identical.
    // This is the hot path during streaming: historical turns match and
    // return the same object reference so React.memo bails in.
    const canReuse =
      prior !== undefined &&
      prior.userMessage === skel.userMessage &&
      prior.assistantMessage === skel.assistantMessage &&
      prior.isStreaming === skel.isStreaming

    if (canReuse) {
      result.push(prior!)
      continue
    }

    const toolCalls = skel.assistantMessage
      ? extractToolCallsFromMessage(skel.assistantMessage)
      : []
    const assistantParts = skel.assistantMessage
      ? extractOrderedParts(skel.assistantMessage)
      : []

    result.push({
      id: skel.id,
      userMessage: skel.userMessage,
      assistantMessage: skel.assistantMessage,
      toolCalls,
      assistantParts,
      timestamp: skel.timestamp,
      isStreaming: skel.isStreaming,
    })
  }

  // External tool calls (e.g. from subagent stream) attach to the last turn.
  // We build a NEW turn object rather than mutate, so reference-equality
  // remains a reliable signal of "content changed" for downstream memo.
  if (externalToolCalls && externalToolCalls.length > 0 && result.length > 0) {
    const lastIdx = result.length - 1
    const lastTurn = result[lastIdx]
    const existingIds = new Set(lastTurn.toolCalls.map((t) => t.id))
    const uniqueExternalTools = externalToolCalls.filter(
      (t) => !existingIds.has(t.id),
    )
    if (uniqueExternalTools.length > 0) {
      result[lastIdx] = {
        ...lastTurn,
        toolCalls: [...lastTurn.toolCalls, ...uniqueExternalTools],
      }
    }
  }

  return result
}

export function useTurnGrouping(
  messages: UIMessage[],
  isStreaming: boolean = false,
  externalToolCalls?: ToolCallData[],
): ConversationTurn[] {
  const prevTurnsRef = useRef<ConversationTurn[] | undefined>(undefined)

  const turns = useMemo(
    () =>
      groupMessagesIntoTurns(
        messages,
        isStreaming,
        externalToolCalls,
        prevTurnsRef.current,
      ),
    [messages, isStreaming, externalToolCalls],
  )

  prevTurnsRef.current = turns
  return turns
}

export default useTurnGrouping
