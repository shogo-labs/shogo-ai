// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * WorkGroup Component (React Native)
 *
 * Collapsible one-line summary for a run of consecutive "work" tool
 * calls — reads, searches, fetches, edits, writes, and shell commands
 * in any mix (reasoning rides along transparently). Replaces the old
 * `ExplorationGroup` + `EditingGroup` split: label + kind + tense all
 * come from the pure `summarizeWork` (see `workSummary.ts`), so a run
 * that mixes reads and writes reads as "Edited N files, explored …,
 * ran N commands" — matching the Cursor-style reference screenshots —
 * instead of splitting into two different widgets.
 *
 * Collapsed by default even while streaming (`defaultExpandedWhileStreaming
 * = false` on the underlying `CollapsibleToolGroup`) — the one-line
 * label itself updates live (present-tense verb, ticking counts) so
 * the user doesn't need the body open to see progress. The `+N`/`-N`
 * diff badge only appears once the group is done (past tense).
 */

import { useState, useCallback, useMemo, memo } from "react"
import { Text, View } from "react-native"
import { WriteFileWidget } from "./WriteFileWidget"
import { EditFileWidget } from "./EditFileWidget"
import { ExecWidget } from "./ExecWidget"
import { ThinkingWidget } from "./ThinkingWidget"
import { InlineToolWidget } from "./InlineToolWidget"
import { CollapsibleToolGroup } from "./CollapsibleToolGroup"
import { summarizeWork } from "./workSummary"
import type { MessagePart } from "./types"

export interface WorkGroupProps {
  items: MessagePart[]
  isStreaming: boolean
  isExpanded?: boolean
  onToggle?: () => void
  className?: string
}

const WRITE_TOOL_NAMES = new Set(["write_file", "Write"])
const EDIT_TOOL_NAMES = new Set(["edit_file", "Edit", "StrReplace"])
const EXEC_TOOL_NAMES = new Set(["exec", "Bash"])

function DiffBadge({ added, removed }: { added: number; removed: number }) {
  if (added <= 0 && removed <= 0) return null
  return (
    <Text className="font-mono text-[10px]">
      {added > 0 && <Text className="text-emerald-600 dark:text-emerald-500">+{added}</Text>}
      {added > 0 && removed > 0 && <Text className="text-muted-foreground"> </Text>}
      {removed > 0 && <Text className="text-red-600 dark:text-red-400">-{removed}</Text>}
    </Text>
  )
}

function WorkGroupImpl({ items, isStreaming, isExpanded, onToggle, className }: WorkGroupProps) {
  const summary = useMemo(
    () => summarizeWork(items, isStreaming ? "present" : "past"),
    [items, isStreaming],
  )

  // Per-row expansion state so users can drill into a specific
  // diff/output without affecting siblings.
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())
  const toggleRow = useCallback((id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const badge = !isStreaming ? (
    <DiffBadge added={summary.added} removed={summary.removed} />
  ) : undefined

  return (
    <CollapsibleToolGroup
      label={summary.label}
      isStreaming={isStreaming}
      isExpanded={isExpanded}
      onToggle={onToggle}
      className={className}
      contentKey="work-content"
      defaultExpandedWhileStreaming={false}
      badge={badge}
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
            // Reads / searches / lists / fetches interleaved with
            // edits — render as compact minimal rows so the diff
            // cards still stand out visually as the primary content.
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
            // Streaming reasoning renders as the turn-level "Planning
            // next moves" status line instead (see
            // `shouldShowPlanningStatus` in turnShaping.ts) so it
            // doesn't duplicate here.
            if (item.isStreaming) return null
            return (
              <ThinkingWidget
                key={item.id}
                text={item.text}
                isStreaming={false}
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

export const WorkGroup = memo(WorkGroupImpl)

export default WorkGroup
