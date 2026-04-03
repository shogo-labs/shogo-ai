// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SubagentCard Component (React Native)
 *
 * Renders a 2-row card for task/Task tool calls, visually distinct from
 * regular tool widgets. Top row shows agent name/type, bottom row shows
 * live status. Pressable to navigate to the full sub-agent stream view.
 */

import { useState, useEffect, useCallback } from "react"
import { View, Text, Pressable } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { Bot, CheckCircle2, XCircle, ChevronRight } from "lucide-react-native"
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

  // Static mode: task tool uses description / subagent_type
  const desc = args?.description as string | undefined
  if (desc) return desc

  const subagentType = args?.subagent_type as string | undefined
  if (subagentType) return subagentType

  // Dynamic mode: agent_spawn uses type
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

function getStatusText(tool: ToolCallData, elapsed: number): string {
  if (tool.state === "error") {
    return tool.error ?? "Failed"
  }

  if (tool.state === "success") {
    const result = tool.result as Record<string, unknown> | undefined
    const summary = result?.summary as string | undefined
    if (summary) {
      return summary.length > 80 ? summary.slice(0, 77) + "..." : summary
    }
    return "Completed"
  }

  const secs = Math.floor(elapsed / 1000)
  if (secs < 60) return `Running... ${secs}s`
  const mins = Math.floor(secs / 60)
  const rem = secs % 60
  return `Running... ${mins}m ${rem}s`
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
  const statusText = getStatusText(tool, elapsed)

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
          <Bot className="w-4 h-4 text-muted-foreground" size={16} />
          <Text
            className="flex-1 text-xs font-semibold text-foreground"
            numberOfLines={1}
          >
            {agentLabel}
          </Text>
          <Text className="text-[10px] text-muted-foreground font-mono px-1.5 py-0.5 rounded bg-muted/60">
            {agentType}
          </Text>
          {isRunning && <PulsingDot />}
          {isDone && <CheckCircle2 className="w-3.5 h-3.5 text-muted-foreground" size={14} />}
          {isError && <XCircle className="w-3.5 h-3.5 text-muted-foreground" size={14} />}
        </View>

        {/* Bottom row: status + navigate hint */}
        <View className="flex-row items-center gap-2">
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
