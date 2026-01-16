/**
 * Turn Types
 * Task: task-chat-004
 * Task: feat-chat-tool-interleaving
 *
 * Shared types for turn grouping components.
 */

import type { Message } from "@ai-sdk/react"
import type { ToolCallData } from "../tools/types"

/**
 * Normalized message part for interleaved rendering.
 * Transforms AI SDK parts into a consistent structure while preserving order.
 */
export type MessagePart =
  | { type: "text"; text: string; id: string }
  | { type: "tool"; tool: ToolCallData; id: string }
  | { type: "image"; url: string; mediaType: string; id: string }

/**
 * A conversation turn groups a user message with its subsequent
 * assistant response and any tool calls in between.
 */
export interface ConversationTurn {
  /** Unique identifier for the turn */
  id: string
  /** The initiating user message */
  userMessage: Message | null
  /** The assistant's response message */
  assistantMessage: Message | null
  /** Tool calls associated with this turn (flat array for summary/counts) */
  toolCalls: ToolCallData[]
  /** Ordered parts for interleaved rendering (text, tools, images in sequence) */
  assistantParts: MessagePart[]
  /** Timestamp of the turn start */
  timestamp: number
  /** Whether the assistant is currently streaming */
  isStreaming: boolean
}

/**
 * Turn boundary detection result
 */
export interface TurnBoundary {
  /** Index in the messages array where this turn starts */
  startIndex: number
  /** Index in the messages array where this turn ends */
  endIndex: number
}
