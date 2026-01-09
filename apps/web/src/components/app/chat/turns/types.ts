/**
 * Turn Types
 * Task: task-chat-004
 *
 * Shared types for turn grouping components.
 */

import type { Message } from "@ai-sdk/react"
import type { ToolCallData } from "../tools/types"

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
  /** Tool calls associated with this turn */
  toolCalls: ToolCallData[]
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
