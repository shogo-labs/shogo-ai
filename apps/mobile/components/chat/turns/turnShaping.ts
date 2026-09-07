// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Turn Shaping
 *
 * Pure functions (no React) that turn a flat, ordered `MessagePart[]`
 * for one assistant message into the shape the chat UI renders:
 *
 *   1. `groupWorkParts` — collapse consecutive "work" tool calls
 *      (reads, searches, fetches, edits, writes, shell commands) into
 *      a single `work-group`, and collapse consecutive same-name
 *      calls that aren't work tools (repeated MCP/skill calls) into
 *      a `tool-group`. Everything else passes through unchanged.
 *   2. `partitionTurn` — split the grouped parts into the "work log"
 *      (everything before the LAST text part) and the "final segment"
 *      (the last text part + everything after it). The work log is
 *      what `AssistantContent` folds under a "Worked for X" header
 *      once the turn is done; the final segment always stays visible.
 *   3. `extractTurnTiming` — read `data-turn-start` / `data-turn-complete`
 *      (live, from the AI SDK stream) or a persisted `data-turn-timing`
 *      part (see `apps/api/src/routes/project-chat.ts`) off the raw
 *      `UIMessage.parts`, falling back to `message.createdAt`.
 *   4. `formatWorkedDuration` — `8s` / `1m 05s` / `1h 2m`.
 *   5. `shouldShowPlanningStatus` — whether the muted "Planning next
 *      moves" status line should render at the bottom of a streaming
 *      turn (covers the gap between a finished tool and the next one,
 *      and a streaming reasoning burst — both render as this status
 *      line instead of a live tool widget / ThinkingWidget).
 *
 * Kept dependency-free (only imports `tools/summary.ts` for verb
 * classification) so every branch here is unit-testable without
 * mounting any component.
 */

import type { UIMessage } from "@ai-sdk/react"
import type { MessagePart, GroupedMessagePart } from "./types"
import { type ToolCallData } from "../tools/types"
import { getToolSummary } from "../tools/summary"

// Verbs (from tools/summary.ts) that classify a tool call as a
// read-only "exploration" action for the purposes of grouping. Note
// this is ONLY used to decide whether an `exec`/`Bash` call counts as
// a "work" tool at all — kind classification (edited vs explored vs
// ran) for the *label* lives in `workSummary.ts`.
const EXPLORATION_VERBS = new Set([
  "Read",
  "List",
  "Search for",
  "Find in",
  "Find files matching",
  "Search the web for",
  "Fetch",
  "pwd",
])

const EDITING_TOOL_NAMES = new Set(["write_file", "Write", "edit_file", "Edit", "StrReplace"])

/**
 * Tools that never fold into a group (same-name or otherwise) — each
 * renders as its own dedicated widget/card. Note write/edit/exec are
 * deliberately absent: the "work" pass below always intercepts them
 * before this list is even consulted, since a lone edit or command
 * still gets the one-line summary treatment (`MIN_WORK_GROUP_SIZE` is
 * 1) rather than a bare inline card.
 */
const UNGROUPABLE_TOOLS = new Set([
  "ask_user",
  "notify_user_error",
  "TodoWrite",
  "todo_write",
  "connect",
  // Legacy: keep so historical install turns still render ungrouped
  "tool_install",
  "mcp_install",
  "generate_image",
  "task",
  "Task",
  "agent_spawn",
  "team_create",
  "browser",
  "create_plan",
  "update_plan",
])

const MIN_WORK_GROUP_SIZE = 1
const MIN_GROUP_SIZE = 2

function isExplorationTool(tool: ToolCallData): boolean {
  const { verb } = getToolSummary(tool.toolName, tool.args)
  return EXPLORATION_VERBS.has(verb)
}

function isEditingTool(tool: ToolCallData): boolean {
  return EDITING_TOOL_NAMES.has(tool.toolName)
}

/**
 * Shell command (`exec` / `Bash`) whose verb is *not* a pure
 * exploration verb — generic `Run`, `Install`, `git X`, or mutating
 * ops like `Move` / `Remove` / `Copy` / `Touch`. These count as
 * "work" alongside reads/writes since they're actions, not pure
 * inspection.
 */
function isShellRunCommand(tool: ToolCallData): boolean {
  if (tool.toolName !== "exec" && tool.toolName !== "Bash") return false
  const { verb } = getToolSummary(tool.toolName, tool.args)
  return !EXPLORATION_VERBS.has(verb)
}

function isWorkTool(tool: ToolCallData): boolean {
  return isExplorationTool(tool) || isEditingTool(tool) || isShellRunCommand(tool)
}

/**
 * Walk forward from `start` collecting tool parts that match
 * `accept`, treating `reasoning` parts as transparent (consumed into
 * the run but not counted toward the tool threshold). Returns the
 * exclusive end of the *trimmed* slice (trailing reasoning excluded)
 * and the tool count.
 */
function scanTransparentRun(
  parts: MessagePart[],
  start: number,
  accept: (tool: ToolCallData) => boolean,
): { endIdx: number; toolCount: number } {
  let j = start + 1
  let toolCount = 1
  let lastToolIdx = start
  while (j < parts.length) {
    const next = parts[j]
    if (next.type === "reasoning") {
      j++
      continue
    }
    if (next.type === "tool" && accept(next.tool)) {
      toolCount++
      lastToolIdx = j
      j++
      continue
    }
    break
  }
  return { endIdx: lastToolIdx + 1, toolCount }
}

/**
 * Group consecutive "work" tool calls (reads/searches/fetches/edits/
 * writes/shell commands, in any mix, with reasoning riding along
 * transparently) into a single `work-group`. Falls back to same-name
 * grouping (`tool-group`) for repeated non-work tools (MCP/skill
 * calls), and passes everything else through unchanged.
 */
export function groupWorkParts(parts: MessagePart[]): GroupedMessagePart[] {
  const result: GroupedMessagePart[] = []
  let i = 0

  while (i < parts.length) {
    const part = parts[i]

    if (part.type !== "tool") {
      result.push(part)
      i++
      continue
    }

    if (isWorkTool(part.tool)) {
      const { endIdx, toolCount } = scanTransparentRun(parts, i, isWorkTool)
      if (toolCount >= MIN_WORK_GROUP_SIZE) {
        const slice = parts.slice(i, endIdx)
        result.push({
          type: "work-group",
          items: slice,
          id: `work-${parts[i].id}`,
        })
        i = endIdx
        continue
      }
      // Unreachable while MIN_WORK_GROUP_SIZE is 1, but keep the
      // fallthrough so raising the threshold later degrades safely.
    }

    if (UNGROUPABLE_TOOLS.has(part.tool.toolName)) {
      result.push(part)
      i++
      continue
    }

    const toolName = part.tool.toolName
    let j = i + 1
    while (
      j < parts.length &&
      parts[j].type === "tool" &&
      !UNGROUPABLE_TOOLS.has((parts[j] as { type: "tool"; tool: ToolCallData }).tool.toolName) &&
      (parts[j] as { type: "tool"; tool: ToolCallData }).tool.toolName === toolName
    ) {
      j++
    }

    const runLength = j - i
    if (runLength >= MIN_GROUP_SIZE) {
      const groupTools = parts.slice(i, j).map((p) => ({
        tool: (p as { type: "tool"; tool: ToolCallData; id: string }).tool,
        id: p.id,
      }))
      result.push({
        type: "tool-group",
        toolName,
        tools: groupTools,
        id: `group-${parts[i].id}`,
      })
    } else {
      result.push(part)
    }

    i = j
  }

  return result
}

export interface TurnPartition {
  /** Everything before the last `text` part — folds under "Worked for X". */
  workLog: GroupedMessagePart[]
  /** The last `text` part and everything after it — always visible. */
  finalSegment: GroupedMessagePart[]
}

/**
 * Split grouped parts on the LAST `text` part: everything before it
 * is the "work log" (collapsible), the last text part plus everything
 * after it is the "final segment" (always visible — this is what
 * makes the trailing "Explored N files…" row and a trailing plan
 * card stay visible in the reference screenshots).
 *
 * When there's no text part at all (a turn that ends mid-tool-call,
 * or hasn't produced any prose yet), everything is the final segment
 * and the work log is empty — there's nothing to fold away.
 */
export function partitionTurn(grouped: GroupedMessagePart[]): TurnPartition {
  let lastTextIdx = -1
  for (let i = 0; i < grouped.length; i++) {
    if (grouped[i].type === "text") lastTextIdx = i
  }
  if (lastTextIdx === -1) {
    return { workLog: [], finalSegment: grouped }
  }
  return {
    workLog: grouped.slice(0, lastTextIdx),
    finalSegment: grouped.slice(lastTextIdx),
  }
}

export interface TurnTiming {
  startedAt?: number
  completedAt?: number
}

/**
 * Read turn-level timing off a `UIMessage`. Prefers the live
 * `data-turn-start` / `data-turn-complete` SSE frames (which AI SDK
 * v6 appends to `message.parts` since they're non-transient `data-*`
 * chunks), then the persisted `data-turn-timing` part written by
 * `apps/api/src/routes/project-chat.ts` for historical messages,
 * falling back to `message.createdAt` for `completedAt` when no turn
 * timing was ever recorded (e.g. messages persisted before that
 * change shipped).
 */
export function extractTurnTiming(message: UIMessage): TurnTiming {
  const parts = (message as { parts?: unknown }).parts
  let startedAt: number | undefined
  let completedAt: number | undefined

  if (Array.isArray(parts)) {
    for (const part of parts as Array<Record<string, unknown>>) {
      const type = part?.type
      const data = part?.data as Record<string, unknown> | undefined
      if ((type === "data-turn-start" || type === "data-turn-timing") && typeof data?.startedAt === "number") {
        startedAt = data.startedAt as number
      }
      if ((type === "data-turn-complete" || type === "data-turn-timing") && typeof data?.completedAt === "number") {
        completedAt = data.completedAt as number
      }
    }
  }

  if (completedAt === undefined) {
    const createdAt = (message as { createdAt?: unknown }).createdAt
    if (createdAt instanceof Date) {
      completedAt = createdAt.getTime()
    } else if (typeof createdAt === "number") {
      completedAt = createdAt
    }
  }

  return { startedAt, completedAt }
}

/**
 * Format a millisecond duration as `8s` / `1m 05s` / `1h 2m` for the
 * "Worked for X" header.
 */
export function formatWorkedDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`
  }
  const hours = Math.floor(minutes / 60)
  const remMinutes = minutes % 60
  return `${hours}h ${remMinutes}m`
}

/**
 * Format a timestamp as a short relative "time ago" string for the
 * turn footer ("just now" / "2m ago" / "3h ago" / "5d ago" / "2mo
 * ago" / "1y ago"). `nowMs` is injectable for tests; callers in the
 * UI re-render on an interval (see `useRelativeTimeLabel` in
 * `TurnFooter.tsx`) to keep the label ticking without re-deriving the
 * whole turn tree.
 */
export function formatRelativeTime(timestampMs: number, nowMs: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((nowMs - timestampMs) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  const years = Math.floor(months / 12)
  return `${years}y ago`
}

/**
 * Whether the muted "Planning next moves" status line should render
 * at the bottom of a streaming turn. True when the model is
 * "between" visible activity: no tool is actively streaming, the
 * last part isn't growing prose, and there's either nothing yet, a
 * finished tool waiting for the next step, or a live reasoning burst
 * (which renders as this line instead of a live ThinkingWidget).
 */
export function shouldShowPlanningStatus(parts: MessagePart[], isStreaming: boolean): boolean {
  if (!isStreaming) return false
  if (parts.length === 0) return true
  const last = parts[parts.length - 1]
  if (last.type === "tool" && last.tool.state === "streaming") return false
  if (last.type === "text") return false
  return true
}
