// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * EditFileWidget — Unified diff display for edit_file / Edit tool calls.
 *
 * Computes a line-level diff between old_string and new_string, then
 * renders removed lines with red tint, added lines with green tint,
 * and unchanged context lines with no tint.
 */

import { useState, useMemo, memo } from "react"
import { View, Text, Pressable, ScrollView } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { FileEdit, Loader2, CheckCircle2, XCircle, ChevronRight, ChevronDown } from "lucide-react-native"
import type { ToolCallData } from "../tools/types"
import { getBasename, getLanguageLabel } from "./file-lang-map"
import { computeLineDiff } from "./diff-utils"

export interface EditFileWidgetProps {
  tool: ToolCallData
  isExpanded?: boolean
  onToggle?: () => void
  className?: string
}

function extractEditData(tool: ToolCallData) {
  const path = (tool.args?.path ?? tool.args?.file_path) as string | undefined
  const oldString = (tool.args?.old_string ?? "") as string
  const newString = (tool.args?.new_string ?? "") as string
  const replaceAll = tool.args?.replace_all as boolean | undefined
  return { path: path || "unknown", oldString, newString, replaceAll }
}

function stableStringify(val: unknown): string {
  if (val === null || val === undefined) return ""
  if (typeof val === "string") return val
  try { return JSON.stringify(val) } catch { return "" }
}

// See WriteFileWidget.tsx for rationale on the terminal-state fast path.
function toolWidgetPropsEqual(
  prev: EditFileWidgetProps,
  next: EditFileWidgetProps,
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

export const EditFileWidget = memo(function EditFileWidget({
  tool,
  isExpanded: controlledExpanded,
  onToggle,
  className,
}: EditFileWidgetProps) {
  const [internalExpanded, setInternalExpanded] = useState(false)
  const isExpanded = controlledExpanded ?? internalExpanded
  const handleToggle = () => {
    if (onToggle) onToggle()
    else setInternalExpanded(!internalExpanded)
  }

  const { path, oldString, newString } = useMemo(() => extractEditData(tool), [tool.args])
  const basename = getBasename(path)
  const langLabel = getLanguageLabel(path)

  const diffLines = useMemo(
    () => computeLineDiff(oldString, newString),
    [oldString, newString],
  )

  const added = diffLines.filter(l => l.type === "added").length
  const removed = diffLines.filter(l => l.type === "removed").length

  const StateIcon = {
    streaming: Loader2,
    success: CheckCircle2,
    error: XCircle,
  }[tool.state]

  return (
    <View className={cn("overflow-hidden rounded-md", className)}>
      {/* Header */}
      <Pressable
        onPress={handleToggle}
        className="group w-full flex-row items-center gap-1.5 py-1.5 px-2 bg-gray-100 dark:bg-gray-950 border border-gray-200 dark:border-transparent"
      >
        <View className="group-hover:hidden">
          <FileEdit className="w-3 h-3 text-primary" size={12} />
        </View>
        <View className="hidden group-hover:flex">
          {isExpanded ? (
            <ChevronDown className="w-3 h-3 text-gray-800 dark:text-gray-400" size={12} />
          ) : (
            <ChevronRight className="w-3 h-3 text-gray-800 dark:text-gray-400" size={12} />
          )}
        </View>

        <View className="bg-gray-200 dark:bg-gray-800 rounded px-1 py-0.5">
          <Text className="text-[8px] font-medium text-gray-800 dark:text-gray-300 uppercase tracking-wide">
            {langLabel}
          </Text>
        </View>

        <Text className="flex-1 font-mono text-[11px] font-medium text-foreground" numberOfLines={1}>
          {basename}
        </Text>

        {(added > 0 || removed > 0) && (
          <Text className="font-mono text-[9px] mr-1">
            {added > 0 && <Text className="text-emerald-600 dark:text-emerald-500">+{added}</Text>}
            {added > 0 && removed > 0 && <Text className="text-gray-500 dark:text-gray-600"> </Text>}
            {removed > 0 && <Text className="text-red-600 dark:text-red-400">-{removed}</Text>}
          </Text>
        )}

        <StateIcon
          className={cn(
            "w-3 h-3",
            tool.state === "streaming" && "text-primary animate-spin",
            tool.state === "success" && "text-emerald-500",
            tool.state === "error" && "text-red-500",
          )}
          size={12}
        />
      </Pressable>

      {/* Expanded diff view */}
      {isExpanded && (
        <View className="bg-gray-50 dark:bg-gray-950 border-t border-gray-200 dark:border-gray-800">
          {tool.state === "streaming" && !oldString && !newString && (
            <View className="flex-row items-center gap-1.5 px-2 py-2">
              <Loader2 className="w-3 h-3 text-primary animate-spin" size={12} />
              <Text className="text-[10px] text-gray-800 dark:text-gray-400">Editing…</Text>
            </View>
          )}

          {(oldString || newString) && (
            <ScrollView nestedScrollEnabled className="max-h-64">
              {diffLines.map((line, i) => (
                <View
                  key={i}
                  className={cn(
                    "flex-row min-h-[18px]",
                    line.type === "removed" && "bg-red-500/15",
                    line.type === "added" && "bg-emerald-500/15",
                  )}
                >
                  <View className="w-5 items-center justify-center">
                    <Text
                      className={cn(
                        "text-[11px] font-mono",
                        line.type === "removed" && "text-red-700 dark:text-red-400",
                        line.type === "added" && "text-emerald-700 dark:text-emerald-400",
                        line.type === "context" && "text-gray-700 dark:text-gray-500",
                      )}
                    >
                      {line.type === "removed" ? "-" : line.type === "added" ? "+" : " "}
                    </Text>
                  </View>
                  <Text
                    className={cn(
                      "flex-1 text-[11px] font-mono leading-[18px] px-1",
                      line.type === "removed" && "text-red-800 dark:text-red-300",
                      line.type === "added" && "text-emerald-800 dark:text-emerald-300",
                      line.type === "context" && "text-foreground",
                    )}
                    selectable
                  >
                    {line.text || " "}
                  </Text>
                </View>
              ))}
            </ScrollView>
          )}

          {tool.state === "error" && tool.error && (
            <View className="bg-red-500/10 px-2 py-1.5 border-t border-gray-200 dark:border-gray-800">
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

export default EditFileWidget
