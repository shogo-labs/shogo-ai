// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * EditingGroup Component (React Native)
 *
 * Collapsible group for runs of consecutive write / edit / StrReplace
 * tool calls. Each tool item renders inside the body via its dedicated
 * widget (`WriteFileWidget` / `EditFileWidget`) so the user can still
 * tap any row to inspect the diff. Reasoning parts interleaved with
 * the edits render inline as `ThinkingWidget`s, matching
 * `ExplorationGroup`'s "thoughts are transparent" behavior.
 */

import { useState, useCallback, useMemo, memo } from "react"
import { View } from "react-native"
import { WriteFileWidget } from "./WriteFileWidget"
import { EditFileWidget } from "./EditFileWidget"
import { ExecWidget } from "./ExecWidget"
import { ThinkingWidget } from "./ThinkingWidget"
import { InlineToolWidget } from "./InlineToolWidget"
import { CollapsibleToolGroup } from "./CollapsibleToolGroup"
import { getToolSummary } from "../tools/summary"
import type { MessagePart } from "./types"

export interface EditingGroupProps {
  items: MessagePart[]
  isStreaming: boolean
  isExpanded?: boolean
  onToggle?: () => void
  className?: string
}

const WRITE_TOOL_NAMES = new Set(["write_file", "Write"])
const EDIT_TOOL_NAMES = new Set(["edit_file", "Edit", "StrReplace"])
const EXEC_TOOL_NAMES = new Set(["exec", "Bash"])
const READ_VERBS = new Set(["Read"])
const SEARCH_VERBS = new Set([
  "Search for",
  "Find in",
  "Find files matching",
])

interface EditingCounts {
  writes: number
  edits: number
  reads: number
  searches: number
  commands: number
}

function tallyCounts(items: ReadonlyArray<MessagePart>): EditingCounts {
  const counts: EditingCounts = {
    writes: 0,
    edits: 0,
    reads: 0,
    searches: 0,
    commands: 0,
  }
  for (const item of items) {
    if (item.type !== "tool") continue
    if (WRITE_TOOL_NAMES.has(item.tool.toolName)) {
      counts.writes++
      continue
    }
    if (EDIT_TOOL_NAMES.has(item.tool.toolName)) {
      counts.edits++
      continue
    }
    const { verb } = getToolSummary(item.tool.toolName, item.tool.args)
    if (READ_VERBS.has(verb)) {
      counts.reads++
    } else if (SEARCH_VERBS.has(verb)) {
      counts.searches++
    } else if (EXEC_TOOL_NAMES.has(item.tool.toolName)) {
      // Generic Run / Install / git / Move / Remove / Copy / Touch /
      // unknown shell verbs all bucket as "commands".
      counts.commands++
    }
  }
  return counts
}

function buildLabel(
  counts: EditingCounts,
  isStreaming: boolean,
  toolCount: number,
): string {
  if (isStreaming) return "Editing…"
  const segs: string[] = []
  const lead = (verb: string) =>
    segs.length === 0
      ? verb.charAt(0).toUpperCase() + verb.slice(1)
      : verb
  if (counts.edits) {
    segs.push(
      `${lead("edited")} ${counts.edits} file${counts.edits === 1 ? "" : "s"}`,
    )
  }
  if (counts.writes) {
    segs.push(
      `${lead("wrote")} ${counts.writes} file${counts.writes === 1 ? "" : "s"}`,
    )
  }
  if (counts.reads) {
    segs.push(
      `${lead("read")} ${counts.reads} file${counts.reads === 1 ? "" : "s"}`,
    )
  }
  if (counts.searches) {
    segs.push(
      `${lead("ran")} ${counts.searches} search${counts.searches === 1 ? "" : "es"}`,
    )
  }
  if (counts.commands) {
    segs.push(
      `${lead("ran")} ${counts.commands} command${counts.commands === 1 ? "" : "s"}`,
    )
  }
  if (segs.length === 0) {
    return `Edited ${toolCount} file${toolCount === 1 ? "" : "s"}`
  }
  return segs.join(", ")
}

function EditingGroupImpl({
  items,
  isStreaming,
  isExpanded,
  onToggle,
  className,
}: EditingGroupProps) {
  const counts = useMemo(() => tallyCounts(items), [items])
  const toolCount = useMemo(
    () => items.filter((it) => it.type === "tool").length,
    [items],
  )
  const label = useMemo(
    () => buildLabel(counts, isStreaming, toolCount),
    [counts, isStreaming, toolCount],
  )

  // Per-row expansion state so users can drill into a specific diff
  // without affecting siblings.
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())
  const toggleRow = useCallback((id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  return (
    <CollapsibleToolGroup
      label={label}
      isStreaming={isStreaming}
      isExpanded={isExpanded}
      onToggle={onToggle}
      className={className}
      contentKey="editing-content"
    >
      <View className="gap-y-1">
        {items.map((item) => {
          if (item.type === "tool") {
            const isRowExpanded = expandedRows.has(item.id)
            const onRowToggle = () => toggleRow(item.id)
            if (WRITE_TOOL_NAMES.has(item.tool.toolName)) {
              return (
                <WriteFileWidget
                  key={item.id}
                  tool={item.tool}
                  isExpanded={isRowExpanded}
                  onToggle={onRowToggle}
                />
              )
            }
            if (EDIT_TOOL_NAMES.has(item.tool.toolName)) {
              return (
                <EditFileWidget
                  key={item.id}
                  tool={item.tool}
                  isExpanded={isRowExpanded}
                  onToggle={onRowToggle}
                />
              )
            }
            if (EXEC_TOOL_NAMES.has(item.tool.toolName)) {
              return (
                <ExecWidget
                  key={item.id}
                  tool={item.tool}
                  isExpanded={isRowExpanded}
                  onToggle={onRowToggle}
                />
              )
            }
            // Reads / searches / lists / fetches interleaved with edits
            // — render as compact minimal rows so the diff cards still
            // stand out visually as the primary content.
            return (
              <InlineToolWidget
                key={item.id}
                tool={item.tool}
                variant="minimal"
                isExpanded={isRowExpanded}
                onToggle={onRowToggle}
              />
            )
          }
          if (item.type === "reasoning") {
            return (
              <ThinkingWidget
                key={item.id}
                text={item.text}
                isStreaming={item.isStreaming}
                durationSeconds={item.durationSeconds}
              />
            )
          }
          return null
        })}
      </View>
    </CollapsibleToolGroup>
  )
}

export const EditingGroup = memo(EditingGroupImpl)

export default EditingGroup
