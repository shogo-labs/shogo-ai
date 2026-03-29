// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * WriteFileWidget — Displays write_file / Write tool calls with
 * a code preview showing the written content, file type badge,
 * and line numbers.
 */

import { useState } from "react"
import { View, Text, Pressable, ScrollView } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { FilePlus2, Loader2, CheckCircle2, XCircle, ChevronRight, ChevronDown } from "lucide-react-native"
import type { ToolCallData } from "../tools/types"
import { getBasename, getLanguageLabel } from "./file-lang-map"

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

export function WriteFileWidget({
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

  const { path, content, append, bytes } = extractWriteData(tool)
  const basename = getBasename(path)
  const langLabel = getLanguageLabel(path)
  const { display, truncated, totalLines } = truncateContent(content)
  const displayLines = (showFull ? content : display).split("\n")

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
        className="w-full flex-row items-center gap-1.5 py-1.5 px-2 bg-gray-900 dark:bg-gray-950"
      >
        {isExpanded ? (
          <ChevronDown className="w-2.5 h-2.5 text-gray-500" />
        ) : (
          <ChevronRight className="w-2.5 h-2.5 text-gray-500" />
        )}
        <FilePlus2 className="w-3 h-3 text-emerald-500" size={12} />

        <View className="bg-gray-800 rounded px-1 py-0.5">
          <Text className="text-[8px] font-medium text-gray-400 uppercase tracking-wide">
            {langLabel}
          </Text>
        </View>

        <Text className="flex-1 font-mono text-[10px] text-gray-300" numberOfLines={1}>
          {basename}
        </Text>

        <Text className="font-mono text-[9px] text-gray-600 mr-1">
          {append ? "Append" : totalLines > 1 ? `${totalLines} lines` : ""}{" "}
          {formatBytes(bytes)}
        </Text>

        <StateIcon
          className={cn(
            "w-3 h-3",
            tool.state === "streaming" && "text-blue-400",
            tool.state === "success" && "text-emerald-500",
            tool.state === "error" && "text-red-500",
          )}
          size={12}
        />
      </Pressable>

      {/* Expanded code preview */}
      {isExpanded && (
        <View className="bg-gray-900 dark:bg-gray-950 border-t border-gray-800">
          {tool.state === "streaming" && !content && (
            <View className="flex-row items-center gap-1.5 px-2 py-2">
              <Loader2 className="w-3 h-3 text-blue-400" size={12} />
              <Text className="text-[10px] text-gray-500">Writing…</Text>
            </View>
          )}

          {content.length > 0 && (
            <ScrollView nestedScrollEnabled horizontal={false} className="max-h-64">
              <View className="flex-row">
                {/* Line number gutter */}
                <View className="px-1.5 py-1.5 border-r border-gray-800 items-end">
                  {displayLines.map((_, i) => (
                    <Text key={i} className="text-[9px] font-mono text-gray-600 leading-[16px]">
                      {i + 1}
                    </Text>
                  ))}
                </View>
                {/* Code content */}
                <ScrollView nestedScrollEnabled horizontal className="flex-1 px-2 py-1.5">
                  {displayLines.map((line, i) => (
                    <Text key={i} className="text-[10px] font-mono text-gray-300 leading-[16px]" selectable>
                      {line || " "}
                    </Text>
                  ))}
                </ScrollView>
              </View>
            </ScrollView>
          )}

          {truncated && !showFull && (
            <Pressable onPress={() => setShowFull(true)} className="px-2 py-1 border-t border-gray-800">
              <Text className="text-[9px] text-gray-500">
                Show all {totalLines} lines
              </Text>
            </Pressable>
          )}

          {tool.state === "error" && tool.error && (
            <View className="bg-red-500/10 px-2 py-1.5 border-t border-gray-800">
              <Text className="text-[10px] font-mono text-red-400" selectable>
                {tool.error}
              </Text>
            </View>
          )}
        </View>
      )}
    </View>
  )
}

export default WriteFileWidget
