// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ExplorationGroup Component (React Native)
 *
 * Collapsible group for runs of consecutive read-only "exploration"
 * tool calls (Read / Grep / Glob / WebSearch / WebFetch and read-only
 * exec commands like `cat`, `ls`, `grep`, `find`). Reasoning parts
 * interleaved with the tools render inline so a `read → thought →
 * read → thought → read` sequence stays visually contiguous.
 */

import { useMemo, memo } from "react"
import { View } from "react-native"
import { getToolSummary } from "../tools/summary"
import { InlineToolWidget } from "./InlineToolWidget"
import { ThinkingWidget } from "./ThinkingWidget"
import { CollapsibleToolGroup } from "./CollapsibleToolGroup"
import type { MessagePart } from "./types"

export interface ExplorationGroupProps {
  items: MessagePart[]
  isStreaming: boolean
  isExpanded?: boolean
  onToggle?: () => void
  className?: string
}

interface ExplorationCounts {
  reads: number
  searches: number
  lists: number
  webSearches: number
  fetches: number
}

function tallyCounts(items: ReadonlyArray<MessagePart>): ExplorationCounts {
  const counts: ExplorationCounts = {
    reads: 0,
    searches: 0,
    lists: 0,
    webSearches: 0,
    fetches: 0,
  }
  for (const item of items) {
    if (item.type !== "tool") continue
    const { verb } = getToolSummary(item.tool.toolName, item.tool.args)
    switch (verb) {
      case "Read":
        counts.reads++
        break
      case "Search for":
      case "Find in":
      case "Find files matching":
        counts.searches++
        break
      case "List":
        counts.lists++
        break
      case "Search the web for":
        counts.webSearches++
        break
      case "Fetch":
        counts.fetches++
        break
    }
  }
  return counts
}

function buildSummary(counts: ExplorationCounts): string {
  const segs: string[] = []
  if (counts.reads) {
    segs.push(`${counts.reads} file${counts.reads === 1 ? "" : "s"} read`)
  }
  if (counts.searches) {
    segs.push(`${counts.searches} search${counts.searches === 1 ? "" : "es"}`)
  }
  if (counts.lists) {
    segs.push(
      `${counts.lists} director${counts.lists === 1 ? "y" : "ies"} listed`,
    )
  }
  if (counts.webSearches) {
    segs.push(
      `${counts.webSearches} web search${counts.webSearches === 1 ? "" : "es"}`,
    )
  }
  if (counts.fetches) {
    segs.push(
      `${counts.fetches} page${counts.fetches === 1 ? "" : "s"} fetched`,
    )
  }
  return segs.join(", ")
}

function ExplorationGroupImpl({
  items,
  isStreaming,
  isExpanded,
  onToggle,
  className,
}: ExplorationGroupProps) {
  const counts = useMemo(() => tallyCounts(items), [items])
  const summary = useMemo(() => buildSummary(counts), [counts])
  const toolCount = useMemo(
    () => items.filter((it) => it.type === "tool").length,
    [items],
  )

  const label = isStreaming
    ? "Exploring…"
    : summary
      ? `Explored ${summary}`
      : `Explored ${toolCount} tool${toolCount === 1 ? "" : "s"}`

  return (
    <CollapsibleToolGroup
      label={label}
      isStreaming={isStreaming}
      isExpanded={isExpanded}
      onToggle={onToggle}
      className={className}
      contentKey="exploration-content"
    >
      <View>
        {items.map((item) => {
          if (item.type === "tool") {
            return (
              <InlineToolWidget
                key={item.id}
                tool={item.tool}
                variant="minimal"
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

export const ExplorationGroup = memo(ExplorationGroupImpl)

export default ExplorationGroup
