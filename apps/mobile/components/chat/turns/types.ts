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
 * - Consecutive tool calls with the same name are collapsed into a
 *   `tool-group` (rendered by `ToolCallGroup`).
 * - Consecutive read-only "exploration" tool calls of mixed names
 *   (Read / Grep / Glob / WebSearch / WebFetch and read-only exec
 *   commands like `cat`, `ls`, `grep`, `find`) are collapsed into an
 *   `exploration-group` (rendered by `ExplorationGroup`) once at least
 *   3 such calls fire back-to-back.
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
      type: "exploration-group"
      /**
       * Ordered tool + reasoning parts for a run of consecutive
       * read-only "exploration" actions (Read/Grep/Glob/WebSearch/
       * WebFetch + read-only exec verbs). Reasoning is transparent.
       */
      items: MessagePart[]
      id: string
    }
  | {
      type: "editing-group"
      /**
       * Ordered tool + reasoning parts for a run that contains at
       * least one write / edit / StrReplace call. Reads interleaved
       * in the same run fold in here too so a "read → edit → write"
       * sequence renders as a single Editing group.
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
