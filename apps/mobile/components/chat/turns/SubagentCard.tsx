// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SubagentCard Component (React Native)
 *
 * Renders a compact card for agent_spawn / task tool calls.
 * Sub-agent content (text, tool calls, reasoning) is nested inside
 * the tool output via AI SDK preliminary tool results. The card
 * shows a summary of activity; pressing navigates to the Agents panel.
 */

import { useState, useEffect, useCallback, useMemo } from "react"
import { View, Text, Pressable } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { Bot, CheckCircle2, XCircle, ChevronRight, GitFork, Wrench } from "lucide-react-native"
import { Motion } from "@legendapp/motion"
import type { ToolCallData } from "../tools/types"
import { subagentStreamStore } from "../../../lib/subagent-stream-store"

export interface SubagentCardProps {
  tool: ToolCallData
  className?: string
}

const SPINNER_DURATION = 1200

function PulsingDot() {
  return (
    <Motion.View
      initial={{ opacity: 0.4, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{
        type: "timing",
        duration: SPINNER_DURATION,
        easing: "easeInOut",
        repeat: Infinity,
        repeatReverse: true,
      }}
      className="w-2 h-2 rounded-full bg-primary"
    />
  )
}

function getAgentLabel(tool: ToolCallData): string {
  const args = tool.args as Record<string, unknown> | undefined
  const desc = args?.description as string | undefined
  if (desc) return desc
  const subagentType = args?.subagent_type as string | undefined
  if (subagentType) return subagentType
  const agentType = args?.type as string | undefined
  if (agentType) return agentType
  return "Sub-agent"
}

function getAgentType(tool: ToolCallData): string {
  const args = tool.args as Record<string, unknown> | undefined
  return (args?.subagent_type as string | undefined)
    ?? (args?.type as string | undefined)
    ?? "task"
}

function isForkMode(tool: ToolCallData): boolean {
  const args = tool.args as Record<string, unknown> | undefined
  return tool.toolName === "agent_spawn" && !args?.type && !args?.subagent_type
}

interface SubagentOutputParts {
  parts: any[]
  toolCount: number
  lastText: string | null
}

function parseOutputParts(result: unknown): SubagentOutputParts {
  const r = result as Record<string, unknown> | undefined
  const parts = (r?.parts as any[]) ?? []
  let toolCount = 0
  let lastText: string | null = null
  for (const p of parts) {
    if (p?.type === "tool") toolCount++
    if (p?.type === "text" && p.text) lastText = p.text
  }
  return { parts, toolCount, lastText }
}

function getStatusText(tool: ToolCallData, elapsed: number, output: SubagentOutputParts): string {
  if (tool.state === "error") return tool.error ?? "Failed"

  if (tool.state === "success") {
    const r = tool.result as Record<string, unknown> | undefined
    const iters = r?.iterations as number | undefined
    const tc = r?.toolCalls as number | undefined ?? output.toolCount
    const parts: string[] = []
    if (tc > 0) parts.push(`${tc} tool${tc > 1 ? "s" : ""}`)
    if (iters && iters > 1) parts.push(`${iters} iterations`)
    return parts.length > 0 ? `Completed - ${parts.join(", ")}` : "Completed"
  }

  const suffix = output.toolCount > 0 ? ` - ${output.toolCount} tools` : ""
  const secs = Math.floor(elapsed / 1000)
  if (secs < 60) return `Running... ${secs}s${suffix}`
  const mins = Math.floor(secs / 60)
  const rem = secs % 60
  return `Running... ${mins}m ${rem}s${suffix}`
}

export function SubagentCard({ tool, className }: SubagentCardProps) {
  const [elapsed, setElapsed] = useState(0)

  const isRunning = tool.state === "streaming"
  const isDone = tool.state === "success"
  const isError = tool.state === "error"

  useEffect(() => {
    if (!isRunning) return
    const start = Date.now()
    setElapsed(0)
    const interval = setInterval(() => {
      setElapsed(Date.now() - start)
    }, 1000)
    return () => clearInterval(interval)
  }, [isRunning])

  const handlePress = useCallback(() => {
    subagentStreamStore.requestTabSwitch(tool.id)
  }, [tool.id])

  const agentLabel = getAgentLabel(tool)
  const agentType = getAgentType(tool)
  const fork = isForkMode(tool)
  const output = useMemo(() => parseOutputParts(tool.result), [tool.result])
  const statusText = getStatusText(tool, elapsed, output)

  const Icon = fork ? GitFork : Bot

  return (
    <Pressable
      onPress={handlePress}
      className={cn(
        "overflow-hidden rounded-lg border border-border/40 bg-muted/20",
        className,
      )}
    >
      <View className="px-3 py-3 gap-2">
        {/* Top row: agent identity + status icon */}
        <View className="flex-row items-center gap-2">
          <Icon className="w-4 h-4 text-muted-foreground" size={16} />
          <Text
            className="flex-1 text-xs font-semibold text-foreground"
            numberOfLines={1}
          >
            {agentLabel}
          </Text>
          <Text className="text-[10px] text-muted-foreground font-mono px-1.5 py-0.5 rounded bg-muted/60">
            {fork ? "fork" : agentType}
          </Text>
          {isRunning && <PulsingDot />}
          {isDone && <CheckCircle2 className="w-3.5 h-3.5 text-muted-foreground" size={14} />}
          {isError && <XCircle className="w-3.5 h-3.5 text-muted-foreground" size={14} />}
        </View>

        {/* Bottom row: status + navigate hint */}
        <View className="flex-row items-center gap-2">
          {isRunning && output.toolCount > 0 && (
            <Wrench className="w-3 h-3 text-muted-foreground/60" size={12} />
          )}
          <Text
            className="flex-1 text-[11px] text-muted-foreground"
            numberOfLines={1}
          >
            {statusText}
          </Text>
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/50" size={14} />
        </View>
      </View>
    </Pressable>
  )
}

export default SubagentCard
