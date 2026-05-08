// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ExecWidget — Terminal-style display for exec/Bash tool calls.
 *
 * Shows command with a prompt indicator and output in a
 * theme-aware monospace panel, giving users clear visibility
 * into what the agent is executing.
 */

import { useState, memo, Fragment } from "react"
import { View, Text, Pressable, ScrollView } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { Terminal, Loader2, CheckCircle2, XCircle, ChevronRight, ChevronDown } from "lucide-react-native"
import type { ToolCallData } from "../tools/types"
import { parseShellCommand } from "../tools/summary"

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

function stableStringify(val: unknown): string {
  if (val === null || val === undefined) return ""
  if (typeof val === "string") return val
  try { return JSON.stringify(val) } catch { return "" }
}

// See InlineToolWidget for the full rationale. Streaming exec calls
// (long-running scripts, build pipelines) commit at the throttled
// 50ms cadence of `useThrottledWhileStreaming`; without a content-aware
// comparator the entire terminal panel re-renders per delta even when
// stdout/stderr haven't changed.
function execToolPropsEqual(
  prev: ExecWidgetProps,
  next: ExecWidgetProps,
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

function ExecWidgetImpl({
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
  const summary = parseShellCommand(command)
  const { stdout, stderr, exitCode, durationMs } = extractExecOutput(tool)
  const hasOutput = stdout || stderr
  const output = [stdout, stderr].filter(Boolean).join("\n")
  const { display: truncatedOutput, truncated } = truncateOutput(output)

  const StateIcon = {
    streaming: Loader2,
    success: CheckCircle2,
    error: XCircle,
  }[tool.state]

  // Bash/exec is in the minimal-row allow-list — always render as plain
  // text with a hover background, no border/panel chrome. Errors and
  // streaming keep their leading icon for signal; success collapses to
  // just text.
  const showLeadingIcon = tool.state !== "success"

  return (
    <View className={cn("overflow-hidden", className)}>
      {/* Header — always visible */}
      <Pressable
        onPress={handleToggle}
        className="group w-full flex-row items-center gap-1.5 py-0.5 rounded hover:bg-muted/40"
      >
        {showLeadingIcon ? (
          <>
            <View className="group-hover:hidden">
              <Terminal className="w-3 h-3 text-emerald-600 dark:text-emerald-500" size={12} />
            </View>
            <View className="hidden group-hover:flex">
              {isExpanded ? (
                <ChevronDown className="w-3 h-3 text-muted-foreground" size={12} />
              ) : (
                <ChevronRight className="w-3 h-3 text-muted-foreground" size={12} />
              )}
            </View>
          </>
        ) : (
          <View className="hidden group-hover:flex">
            {isExpanded ? (
              <ChevronDown className="w-3 h-3 text-muted-foreground" size={12} />
            ) : (
              <ChevronRight className="w-3 h-3 text-muted-foreground" size={12} />
            )}
          </View>
        )}
        <Text className="flex-1 text-[11px] text-muted-foreground" numberOfLines={1}>
          <Text className="font-medium text-muted-foreground">{summary.verb}</Text>
          {summary.target ? (
            <Text className="text-foreground"> {summary.target}</Text>
          ) : null}
          {summary.rest?.map((s, i) => (
            <Fragment key={i}>
              <Text className="text-muted-foreground/60"> && </Text>
              <Text className="font-medium text-muted-foreground">{s.verb}</Text>
              {s.target ? <Text className="text-foreground"> {s.target}</Text> : null}
            </Fragment>
          ))}
        </Text>
        {durationMs != null && tool.state !== "streaming" && (
          <Text className="hidden group-hover:flex font-mono text-[9px] text-muted-foreground mr-1">
            {formatDuration(durationMs)}
          </Text>
        )}
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

      {/* Expanded — full command + output */}
      {isExpanded && (
        <View className="border-l border-border/40 ml-2 pl-2 py-2 gap-1.5">
          {/* Full command — always show in minimal so users can grab the raw text */}
          <View className="gap-0.5">
            <Text className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
              Command
            </Text>
            <ScrollView nestedScrollEnabled className="bg-background/50 rounded p-1.5 max-h-24">
              <Text className="text-[10px] font-mono text-foreground" selectable>
                {command}
              </Text>
            </ScrollView>
          </View>

          {/* Output */}
          {tool.state !== "streaming" && hasOutput && (
            <View className="gap-0.5">
              <View className="flex-row items-center justify-between">
                <Text className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
                  Output
                </Text>
                {exitCode !== undefined && exitCode !== 0 && (
                  <Text className="text-[9px] font-mono text-red-500">
                    exit {exitCode}
                  </Text>
                )}
              </View>
              <ScrollView nestedScrollEnabled className="bg-background/50 rounded p-1.5 max-h-48">
                <Text
                  className={cn(
                    "text-[10px] font-mono",
                    stderr && !stdout ? "text-red-500" : "text-foreground"
                  )}
                  selectable
                >
                  {showFull ? output : truncatedOutput}
                </Text>
              </ScrollView>
              {truncated && (
                <Pressable onPress={() => setShowFull(!showFull)}>
                  <Text className="text-[9px] text-muted-foreground">
                    {showFull ? "Show less" : "Show full output"}
                  </Text>
                </Pressable>
              )}
            </View>
          )}

          {/* Streaming indicator */}
          {tool.state === "streaming" && (
            <View className="flex-row items-center gap-1.5 py-1">
              <Loader2 className="w-3 h-3 text-primary animate-spin" size={12} />
              <Text className="text-[10px] text-muted-foreground">Running…</Text>
            </View>
          )}

          {/* Error without output */}
          {tool.state === "error" && !hasOutput && tool.error && (
            <View className="bg-red-500/10 rounded p-1.5">
              <Text className="text-[10px] font-mono text-red-600 dark:text-red-400" selectable>
                {tool.error}
              </Text>
            </View>
          )}
        </View>
      )}
    </View>
  )
}

export const ExecWidget = memo(ExecWidgetImpl, execToolPropsEqual)

export default ExecWidget
