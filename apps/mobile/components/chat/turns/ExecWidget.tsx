// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ExecWidget — Terminal-style display for exec/Bash tool calls.
 *
 * Shows command with a prompt indicator and output in a dark
 * monospace panel, giving users clear visibility into what the
 * agent is executing.
 */

import { useState } from "react"
import { View, Text, Pressable, ScrollView } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { Terminal, Loader2, CheckCircle2, XCircle, ChevronRight, ChevronDown } from "lucide-react-native"
import type { ToolCallData } from "../tools/types"

const MAX_OUTPUT_LINES = 30
const MAX_OUTPUT_CHARS = 3000

export interface ExecWidgetProps {
  tool: ToolCallData
  isExpanded?: boolean
  onToggle?: () => void
  className?: string
}

function extractExecOutput(tool: ToolCallData): { stdout: string; stderr: string; exitCode?: number; durationMs?: number } {
  if (!tool.result || typeof tool.result !== "object") {
    return { stdout: typeof tool.result === "string" ? tool.result : "", stderr: "" }
  }
  const r = tool.result as Record<string, unknown>
  return {
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
    exitCode: typeof r.exitCode === "number" ? r.exitCode : undefined,
    durationMs: typeof r.durationMs === "number" ? r.durationMs : undefined,
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function truncateOutput(text: string): { display: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { display: text, truncated: false }
  const lines = text.split("\n")
  if (lines.length <= MAX_OUTPUT_LINES) {
    return { display: text.slice(0, MAX_OUTPUT_CHARS) + "\n…", truncated: true }
  }
  const head = lines.slice(0, 10).join("\n")
  const tail = lines.slice(-10).join("\n")
  return {
    display: `${head}\n\n  … ${lines.length - 20} lines hidden …\n\n${tail}`,
    truncated: true,
  }
}

export function ExecWidget({
  tool,
  isExpanded: controlledExpanded,
  onToggle,
  className,
}: ExecWidgetProps) {
  const [internalExpanded, setInternalExpanded] = useState(false)
  const [showFull, setShowFull] = useState(false)

  const isExpanded = controlledExpanded ?? internalExpanded
  const handleToggle = () => {
    if (onToggle) onToggle()
    else setInternalExpanded(!internalExpanded)
  }

  const command = (tool.args?.command as string) || ""
  const firstLine = command.split("\n")[0]
  const displayCmd = firstLine.length > 60 ? firstLine.slice(0, 57) + "…" : firstLine
  const { stdout, stderr, exitCode, durationMs } = extractExecOutput(tool)
  const hasOutput = stdout || stderr
  const output = [stdout, stderr].filter(Boolean).join("\n")
  const { display: truncatedOutput, truncated } = truncateOutput(output)

  const StateIcon = {
    streaming: Loader2,
    success: CheckCircle2,
    error: XCircle,
  }[tool.state]

  return (
    <View className={cn("overflow-hidden rounded-md", className)}>
      {/* Header — always visible */}
      <Pressable
        onPress={handleToggle}
        className={cn(
          "w-full flex-row items-center gap-1.5 py-1.5 px-2",
          "bg-gray-900 dark:bg-gray-950",
        )}
      >
        {isExpanded ? (
          <ChevronDown className="w-2.5 h-2.5 text-gray-500" />
        ) : (
          <ChevronRight className="w-2.5 h-2.5 text-gray-500" />
        )}
        <Terminal className="w-3 h-3 text-emerald-500" size={12} />
        <Text className="flex-1 font-mono text-[10px] text-gray-300" numberOfLines={1}>
          <Text className="text-emerald-400">$</Text> {displayCmd}
        </Text>
        {durationMs != null && tool.state !== "streaming" && (
          <Text className="font-mono text-[9px] text-gray-600 mr-1">
            {formatDuration(durationMs)}
          </Text>
        )}
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

      {/* Expanded — full command + output */}
      {isExpanded && (
        <View className="bg-gray-900 dark:bg-gray-950 border-t border-gray-800 px-2 pb-2 gap-1.5">
          {/* Full command (if multi-line or long) */}
          {command !== firstLine && (
            <View className="gap-0.5">
              <Text className="text-[9px] font-medium text-gray-500 uppercase tracking-wide">
                Command
              </Text>
              <ScrollView nestedScrollEnabled className="bg-black/30 rounded p-1.5 max-h-24">
                <Text className="text-[10px] font-mono text-gray-300" selectable>
                  {command}
                </Text>
              </ScrollView>
            </View>
          )}

          {/* Output */}
          {tool.state !== "streaming" && hasOutput && (
            <View className="gap-0.5">
              <View className="flex-row items-center justify-between">
                <Text className="text-[9px] font-medium text-gray-500 uppercase tracking-wide">
                  Output
                </Text>
                {exitCode !== undefined && exitCode !== 0 && (
                  <Text className="text-[9px] font-mono text-red-400">
                    exit {exitCode}
                  </Text>
                )}
              </View>
              <ScrollView nestedScrollEnabled className="bg-black/30 rounded p-1.5 max-h-48">
                <Text
                  className={cn(
                    "text-[10px] font-mono",
                    stderr && !stdout ? "text-red-400" : "text-gray-300"
                  )}
                  selectable
                >
                  {showFull ? output : truncatedOutput}
                </Text>
              </ScrollView>
              {truncated && (
                <Pressable onPress={() => setShowFull(!showFull)}>
                  <Text className="text-[9px] text-gray-500">
                    {showFull ? "Show less" : "Show full output"}
                  </Text>
                </Pressable>
              )}
            </View>
          )}

          {/* Streaming indicator */}
          {tool.state === "streaming" && (
            <View className="flex-row items-center gap-1.5 py-1">
              <Loader2 className="w-3 h-3 text-blue-400" size={12} />
              <Text className="text-[10px] text-gray-500">Running…</Text>
            </View>
          )}

          {/* Error without output */}
          {tool.state === "error" && !hasOutput && tool.error && (
            <View className="bg-red-500/10 rounded p-1.5">
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

export default ExecWidget
