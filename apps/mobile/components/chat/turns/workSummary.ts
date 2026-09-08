// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Work Summary
 *
 * Pure label/stats module for `WorkGroup` and the "Worked for X"
 * header. Tallies a run of work-tool parts into buckets (files
 * edited, files read, searches, fetches, commands), classifies the
 * run's `kind`, and builds the Cursor-style one-line label:
 *
 *   Explored 14 files, 9 searches, ran 4 commands
 *   Edited 11 files, explored 3 searches, 1 fetch, ran 13 commands
 *   Editing 32 files, explored 1 search, ran 23 commands   (present tense)
 *   Ran 3 commands
 *
 * The leading verb reflects `tense` ("Edited"/"Editing"); the
 * trailing "explored …" / "ran …" segments are always past tense —
 * each of those sub-actions already resolved even while the overall
 * group (e.g. a batch of edits) is still in progress.
 *
 * Pure module — no React imports. Safe to unit-test directly.
 */

import { getToolSummary } from "../tools/summary"
import { computeLineDiff } from "./diff-utils"
import type { GroupedMessagePart, MessagePart } from "./types"
import type { ToolCallData } from "../tools/types"

export type WorkKind = "edited" | "explored" | "ran"
export type WorkTense = "present" | "past"

export interface WorkCounts {
  /** Unique file paths written or edited (deduped). */
  editedFiles: number
  readFiles: number
  searches: number
  fetches: number
  commands: number
}

export interface WorkSummary {
  kind: WorkKind
  label: string
  added: number
  removed: number
  counts: WorkCounts
}

const WRITE_TOOL_NAMES = new Set(["write_file", "Write"])
const EDIT_TOOL_NAMES = new Set(["edit_file", "Edit", "StrReplace"])
const EXEC_TOOL_NAMES = new Set(["exec", "Bash"])

function toolArgs(tool: ToolCallData): Record<string, unknown> {
  return (tool.args as Record<string, unknown> | undefined) ?? {}
}

function toolPath(tool: ToolCallData): string | undefined {
  const args = toolArgs(tool)
  const path = args.path ?? args.file_path
  return typeof path === "string" ? path : undefined
}

/**
 * Tally a run of work-tool parts into buckets plus aggregated
 * added/removed line counts. Reasoning parts are ignored (transparent).
 */
export function tallyWork(items: ReadonlyArray<MessagePart>): {
  counts: WorkCounts
  added: number
  removed: number
} {
  const counts: WorkCounts = { editedFiles: 0, readFiles: 0, searches: 0, fetches: 0, commands: 0 }
  const editedPaths = new Set<string>()
  let added = 0
  let removed = 0

  for (const item of items) {
    if (item.type !== "tool") continue
    const tool = item.tool

    if (WRITE_TOOL_NAMES.has(tool.toolName)) {
      editedPaths.add(toolPath(tool) ?? tool.id)
      const content = toolArgs(tool).content
      if (typeof content === "string" && content.length > 0) {
        added += content.split("\n").length
      }
      continue
    }

    if (EDIT_TOOL_NAMES.has(tool.toolName)) {
      editedPaths.add(toolPath(tool) ?? tool.id)
      const oldString = toolArgs(tool).old_string
      const newString = toolArgs(tool).new_string
      if (typeof oldString === "string" || typeof newString === "string") {
        const diff = computeLineDiff((oldString as string) ?? "", (newString as string) ?? "")
        for (const line of diff) {
          if (line.type === "added") added++
          else if (line.type === "removed") removed++
        }
      }
      continue
    }

    const { verb } = getToolSummary(tool.toolName, tool.args, tool.state)
    switch (verb) {
      case "Read":
        counts.readFiles++
        break
      case "Search for":
      case "Find in":
      case "Find files matching":
      case "Search the web for":
        counts.searches++
        break
      case "Fetch":
        counts.fetches++
        break
      default:
        // Generic shell commands (Run/Install/git X/Move/Remove/…),
        // plus List/pwd which don't have a dedicated bucket in the
        // label grammar — fold into "commands" when they came from
        // an exec/Bash call. Non-exec tools with no matching bucket
        // (rare) are silently uncounted rather than misclassified.
        if (EXEC_TOOL_NAMES.has(tool.toolName)) counts.commands++
        break
    }
  }

  counts.editedFiles = editedPaths.size
  return { counts, added, removed }
}

export function classifyWorkKind(counts: WorkCounts): WorkKind {
  if (counts.editedFiles > 0) return "edited"
  if (counts.readFiles > 0 || counts.searches > 0 || counts.fetches > 0) return "explored"
  return "ran"
}

function pluralize(n: number, singular: string, plural: string = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`
}

/**
 * Build the one-line label for a work run. `tense` only affects the
 * LEADING verb ("Edited"/"Editing", "Explored"/"Exploring",
 * "Ran"/"Running") — trailing "explored …" / "ran …" segments are
 * always past tense, matching the reference screenshots where a
 * still-running edit group reads "Editing 32 files, explored 1
 * search, ran 23 commands" (the searches/commands already finished
 * even though the edit batch as a whole hasn't).
 */
export function buildWorkLabel(counts: WorkCounts, kind: WorkKind, tense: WorkTense): string {
  const past = tense === "past"

  if (kind === "edited") {
    const lead = past ? "Edited" : "Editing"
    const segs: string[] = [`${lead} ${pluralize(counts.editedFiles, "file")}`]
    const exploreParts: string[] = []
    if (counts.searches > 0) exploreParts.push(pluralize(counts.searches, "search", "searches"))
    if (counts.fetches > 0) exploreParts.push(pluralize(counts.fetches, "fetch", "fetches"))
    if (exploreParts.length > 0) segs.push(`explored ${exploreParts.join(", ")}`)
    if (counts.commands > 0) segs.push(`ran ${pluralize(counts.commands, "command")}`)
    return segs.join(", ")
  }

  if (kind === "explored") {
    const lead = past ? "Explored" : "Exploring"
    const exploreParts: string[] = []
    if (counts.readFiles > 0) exploreParts.push(pluralize(counts.readFiles, "file"))
    if (counts.searches > 0) exploreParts.push(pluralize(counts.searches, "search", "searches"))
    if (counts.fetches > 0) exploreParts.push(pluralize(counts.fetches, "fetch", "fetches"))
    const bucket = exploreParts.length > 0 ? exploreParts.join(", ") : pluralize(0, "file")
    const segs: string[] = [`${lead} ${bucket}`]
    if (counts.commands > 0) segs.push(`ran ${pluralize(counts.commands, "command")}`)
    return segs.join(", ")
  }

  const lead = past ? "Ran" : "Running"
  return `${lead} ${pluralize(counts.commands, "command")}`
}

export function summarizeWork(items: ReadonlyArray<MessagePart>, tense: WorkTense): WorkSummary {
  const { counts, added, removed } = tallyWork(items)
  const kind = classifyWorkKind(counts)
  const label = buildWorkLabel(counts, kind, tense)
  return { kind, label, added, removed, counts }
}

/**
 * Flatten every `work-group`'s items across a turn's work log and
 * summarize as one run (past tense) — used for the "Worked for X"
 * header's fallback label when no turn timing is available.
 */
export function summarizeTurn(workLog: ReadonlyArray<GroupedMessagePart>): WorkSummary {
  const items: MessagePart[] = []
  for (const part of workLog) {
    if (part.type === "work-group") {
      items.push(...part.items.filter((item) => item.type === "tool"))
    }
  }
  return summarizeWork(items, "past")
}

/**
 * `Worked · edited 5 files, ran 7 commands` — the fallback header
 * label for turns with no recorded timing (persisted before turn
 * timing shipped). Lowercases the leading verb since it now follows
 * "Worked · " mid-sentence.
 */
export function buildFallbackWorkedLabel(workLog: ReadonlyArray<GroupedMessagePart>): string {
  const summary = summarizeTurn(workLog)
  if (!summary.label) return "Worked"
  return `Worked · ${summary.label.charAt(0).toLowerCase()}${summary.label.slice(1)}`
}

/** Reasoning durations shorter than this render as "Thought briefly" instead of "Thought for Ns". */
export const THOUGHT_BRIEFLY_THRESHOLD_S = 5

/**
 * Label for a completed (or in-progress) `ThinkingWidget`. Streaming
 * reasoning no longer renders this widget at all in the chat (it
 * shows as the "Planning next moves" status line instead — see
 * `shouldShowPlanningStatus` in `turnShaping.ts`), but the label
 * logic is still exercised once the burst completes and via any
 * caller that passes `isStreaming: true` directly.
 */
export function formatThoughtLabel(durationSeconds?: number, isStreaming?: boolean): string {
  if (isStreaming) return "Thinking…"
  if (durationSeconds === undefined) return "Thought"
  if (durationSeconds < THOUGHT_BRIEFLY_THRESHOLD_S) return "Thought briefly"
  return `Thought for ${durationSeconds}s`
}
