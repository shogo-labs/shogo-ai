// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Turn Types
 * Task: task-chat-004
 * Task: feat-chat-tool-interleaving
 *
 * Shared types for turn grouping components.
 */

import type { UIMessage } from "@ai-sdk/react"
import type { ToolCallData } from "../tools/types"

/**
 * Normalized message part for interleaved rendering.
 * Transforms AI SDK parts into a consistent structure while preserving order.
 */
export type MessagePart =
  | { type: "text"; text: string; id: string }
  | { type: "reasoning"; text: string; isStreaming: boolean; durationSeconds?: number; id: string }
  | { type: "tool"; tool: ToolCallData; id: string }
  | { type: "image"; url: string; mediaType: string; id: string }
  | { type: "file"; url: string; mediaType: string; id: string }

/**
 * A message part after consecutive-tool grouping.
 *
 * - Consecutive tool calls with the same name (that aren't "work"
 *   tools — see below) are collapsed into a `tool-group` (rendered
 *   by `ToolCallGroup`). Used for repeated MCP / skill calls.
 * - Consecutive "work" tool calls — reads, searches, fetches, edits,
 *   writes, and shell commands, in any mix — are collapsed into a
 *   single `work-group` (rendered by `WorkGroup`), one line like
 *   "Edited 5 files, ran 2 commands" that expands to the individual
 *   rows. A run of just one such call still gets the summary
 *   treatment (`MIN_WORK_GROUP_SIZE` in `turnShaping.ts` is 1) so a
 *   lone edit reads the same way as a burst of edits.
 */
export type GroupedMessagePart =
  | MessagePart
  | {
      type: "tool-group"
      toolName: string
      tools: Array<{ tool: ToolCallData; id: string }>
      id: string
    }
  | {
      type: "work-group"
      /**
       * Ordered tool + reasoning parts for a run of consecutive
       * "work" tool calls (reads/searches/fetches/edits/writes/shell
       * commands). Reasoning is transparent — it rides along inside
       * the group instead of splitting the run.
       */
      items: MessagePart[]
      id: string
    }

/**
 * A conversation turn groups a user message with its subsequent
 * assistant response and any tool calls in between.
 */
export interface ConversationTurn {
  /** Unique identifier for the turn */
  id: string
  /** The initiating user message */
  userMessage: UIMessage | null
  /** The assistant's response message */
  assistantMessage: UIMessage | null
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
