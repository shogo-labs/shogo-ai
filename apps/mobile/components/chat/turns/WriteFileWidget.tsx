// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * WriteFileWidget — Displays write_file / Write tool calls with
 * a code preview showing the written content, file type badge,
 * and line numbers.
 */

import { useState, useMemo, memo } from "react"
import { View, Text, Pressable, ScrollView } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { FilePlus2, Loader2, CheckCircle2, XCircle, ChevronRight, ChevronDown } from "lucide-react-native"
import type { ToolCallData } from "../tools/types"
import { getBasename, getLanguageLabel } from "./file-lang-map"
import { isDeliverable } from "../../../lib/deliverable"
import { useChatContextSafe } from "../ChatContext"
import { DownloadChip } from "./DownloadChip"

const MAX_PREVIEW_LINES = 40
const MAX_PREVIEW_CHARS = 4000

export interface WriteFileWidgetProps {
  tool: ToolCallData
  isExpanded?: boolean
  onToggle?: () => void
  className?: string
}

function extractWriteData(tool: ToolCallData) {
  const path = (tool.args?.path ?? tool.args?.file_path) as string | undefined
  const content = (tool.args?.content ?? "") as string
  const append = tool.args?.append as boolean | undefined
  const bytes = typeof (tool.result as any)?.bytes === "number"
    ? (tool.result as any).bytes
    : content.length

  return { path: path || "unknown", content, append, bytes }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / (1024 * 1024)).toFixed(1)}MB`
}

function truncateContent(text: string): { display: string; truncated: boolean; totalLines: number } {
  const lines = text.split("\n")
  const totalLines = lines.length
  if (text.length <= MAX_PREVIEW_CHARS && totalLines <= MAX_PREVIEW_LINES) {
    return { display: text, truncated: false, totalLines }
  }
  const kept = lines.slice(0, MAX_PREVIEW_LINES)
  const trimmed = kept.join("\n").slice(0, MAX_PREVIEW_CHARS)
  return { display: trimmed, truncated: true, totalLines }
}

function stableStringify(val: unknown): string {
  if (val === null || val === undefined) return ""
  if (typeof val === "string") return val
  try { return JSON.stringify(val) } catch { return "" }
}

// Memo equality for the tool widget. `groupConsecutiveParts` upstream
// rebuilds the `tool` object reference on every commit, so we can't use
// referential equality on `tool` itself. Instead:
//   - If `tool.id` matches AND state hasn't changed AND we're in a terminal
//     state (success / error), we know args + result are frozen and bail
//     out with cheap primitive comparisons. This is the common case during
//     long subagent runs where most widgets are already complete.
//   - Otherwise (streaming, or state transition), fall back to the
//     full content-equality JSON.stringify check. That's still cheaper
//     than re-rendering the entire widget subtree.
function toolWidgetPropsEqual(
  prev: WriteFileWidgetProps,
  next: WriteFileWidgetProps,
) {
  if (
    prev.isExpanded !== next.isExpanded ||
    prev.onToggle !== next.onToggle ||
    prev.className !== next.className
  ) {
    return false
  }
  if (prev.tool.state !== next.tool.state) return false
  if (prev.tool.error !== next.tool.error) return false
  // Fast path: terminal-state tool with the same id can never mutate.
  if (
    prev.tool.id === next.tool.id &&
    next.tool.state !== "streaming"
  ) {
    return true
  }
  return (
    stableStringify(prev.tool.args) === stableStringify(next.tool.args) &&
    stableStringify(prev.tool.result) === stableStringify(next.tool.result)
  )
}

export const WriteFileWidget = memo(function WriteFileWidget({
  tool,
  isExpanded: controlledExpanded,
  onToggle,
  className,
}: WriteFileWidgetProps) {
  const [internalExpanded, setInternalExpanded] = useState(false)
  const [showFull, setShowFull] = useState(false)

  const isExpanded = controlledExpanded ?? internalExpanded
  const handleToggle = () => {
    if (onToggle) onToggle()
    else setInternalExpanded(!internalExpanded)
  }

  const chatContext = useChatContextSafe()
  const { path, content, append, bytes } = useMemo(() => extractWriteData(tool), [tool.args, tool.result])
  const basename = getBasename(path)
  const langLabel = getLanguageLabel(path)
  // Auto-offer a download for deliverable files the agent wrote (PPT, PDF,
  // CSV, ZIP, video, …). Only once the write succeeded and only for the
  // curated allowlist so intermediate source writes don't sprout chips.
  const showDownload =
    tool.state === "success" && path !== "unknown" && isDeliverable(path)
  const { display, truncated, totalLines } = truncateContent(content)
  const displayLines = (showFull ? content : display).split("\n")

  const StateIcon = {
    streaming: Loader2,
    success: CheckCircle2,
    error: XCircle,
  }[tool.state]

  const isStreamingNoContent = tool.state === "streaming" && !content

  return (
    <View className={cn("overflow-hidden", className)}>
      {/* Header — minimal row, matches ExecWidget/EditFileWidget: no
          boxed background, hover-chevron replaces the leading icon,
          state icon only shown while streaming/error. */}
      <Pressable
        onPress={handleToggle}
        className="group w-full flex-row items-center gap-1.5 py-0.5 rounded hover:bg-muted/40"
      >
        {tool.state === "success" ? (
          <View className="hidden group-hover:flex">
            {isExpanded ? (
              <ChevronDown className="w-3 h-3 text-muted-foreground" size={12} />
            ) : (
              <ChevronRight className="w-3 h-3 text-muted-foreground" size={12} />
            )}
          </View>
        ) : (
          <>
            <View className="group-hover:hidden">
              <FilePlus2 className="w-3 h-3 text-emerald-600 dark:text-emerald-500" size={12} />
            </View>
            <View className="hidden group-hover:flex">
              {isExpanded ? (
                <ChevronDown className="w-3 h-3 text-muted-foreground" size={12} />
              ) : (
                <ChevronRight className="w-3 h-3 text-muted-foreground" size={12} />
              )}
            </View>
          </>
        )}

        <Text className="flex-1 text-[11px] text-muted-foreground" numberOfLines={1}>
          <Text className="font-medium text-muted-foreground">Wrote</Text>
          <Text className="font-mono text-foreground"> {basename}</Text>
        </Text>

        <Text className="font-mono text-[9px] text-muted-foreground/70 mr-1">
          {append ? "Append" : totalLines > 1 ? `${totalLines} lines` : ""}{" "}
          {formatBytes(bytes)}
        </Text>

        {tool.state !== "success" && (
          <StateIcon
            className={cn(
              "w-3 h-3",
              tool.state === "streaming" && "text-primary animate-spin",
              tool.state === "error" && "text-red-500",
            )}
            size={12}
          />
        )}
      </Pressable>

      {/* Expanded code preview */}
      {isExpanded && (
        <View className="border-l border-border/40 ml-2 pl-2 py-1.5">
          {isStreamingNoContent && (
            <View className="flex-row items-center gap-1.5 py-1">
              <Loader2 className="w-3 h-3 text-primary animate-spin" size={12} />
              <Text className="text-[10px] text-muted-foreground">Writing…</Text>
            </View>
          )}

          {content.length > 0 && (
            <ScrollView nestedScrollEnabled horizontal={false} className="bg-background/50 rounded max-h-64">
              <View className="flex-row">
                {/* Line number gutter */}
                <View className="px-1.5 py-1.5 border-r border-border/40 items-end">
                  {displayLines.map((_, i) => (
                    <Text key={i} className="text-[10px] font-mono text-muted-foreground/70 leading-[18px]">
                      {i + 1}
                    </Text>
                  ))}
                </View>
                {/* Code content */}
                <ScrollView nestedScrollEnabled horizontal className="flex-1 px-2 py-1.5">
                  {displayLines.map((line, i) => (
                    <Text key={i} className="text-[11px] font-mono text-foreground leading-[18px]" selectable>
                      {line || " "}
                    </Text>
                  ))}
                </ScrollView>
              </View>
            </ScrollView>
          )}

          {truncated && !showFull && (
            <Pressable onPress={() => setShowFull(true)} className="py-1 mt-1">
              <Text className="text-[9px] text-muted-foreground">
                Show all {totalLines} lines
              </Text>
            </Pressable>
          )}

          {tool.state === "error" && tool.error && (
            <View className="bg-red-500/10 rounded p-1.5 mt-1.5">
              <Text className="text-[10px] font-mono text-red-600 dark:text-red-400" selectable>
                {tool.error}
              </Text>
            </View>
          )}
        </View>
      )}
    </View>
  )
}, toolWidgetPropsEqual)

export default WriteFileWidget
