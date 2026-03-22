// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SubagentStats Component (React Native)
 *
 * Shows running time, tool count, and mini activity timeline for a subagent.
 */

import { useState, useEffect } from "react"
import { View, Text } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { Clock, Wrench } from "lucide-react-native"
import { formatToolName, getToolCategory, GRADIENT_CONFIG, getGradientOpacity } from "../tools/types"

export interface RecentTool {
  id: string
  toolName: string
  timestamp: number
}

export interface SubagentStatsProps {
  status: "running" | "completed"
  startTime: number
  toolCount: number
  recentTools: RecentTool[]
  className?: string
}

export function SubagentStats({
  status,
  startTime,
  toolCount,
  recentTools,
  className,
}: SubagentStatsProps) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  useEffect(() => {
    setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000))

    if (status !== "running") return

    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000))
    }, 1000)

    return () => clearInterval(interval)
  }, [status, startTime])

  const formatElapsed = (seconds: number): string => {
    if (seconds < 60) return `${seconds}s`
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}m ${secs}s`
  }

  return (
    <View className={cn("gap-2", className)}>
      {/* Stats row */}
      <View className="flex-row items-center gap-4">
        <View className="flex-row items-center gap-1.5">
          <Clock className="w-3 h-3 text-gray-400" size={12} />
          <Text
            className={cn(
              "font-mono text-xs",
              status === "running" ? "text-blue-400" : "text-gray-400"
            )}
          >
            {formatElapsed(elapsedSeconds)}
          </Text>
        </View>

        <View className="flex-row items-center gap-1.5">
          <Wrench className="w-3 h-3 text-gray-400" size={12} />
          <Text className="font-medium text-xs text-gray-400">{toolCount}</Text>
          <Text className="text-xs text-gray-400">
            tool{toolCount !== 1 ? "s" : ""}
          </Text>
        </View>
      </View>

      {/* Mini activity timeline */}
      {recentTools.length > 0 && (
        <View className="gap-0.5">
          {recentTools.slice(0, GRADIENT_CONFIG.maxItems).map((tool, index) => {
            const category = getToolCategory(tool.toolName)
            const displayName = formatToolName(tool.toolName)
            const opacity = getGradientOpacity(index)

            return (
              <View
                key={`subagent-${tool.id}`}
                className="flex-row items-center gap-1.5"
                style={{ opacity }}
              >
                <View
                  className={cn(
                    "w-1 h-1 rounded-full shrink-0",
                    category === "mcp" && "bg-violet-500",
                    category === "file" && "bg-blue-500",
                    category === "skill" && "bg-amber-500",
                    category === "bash" && "bg-emerald-500",
                    category === "other" && "bg-gray-400"
                  )}
                />
                <Text
                  className="font-mono text-[10px] text-gray-400"
                  numberOfLines={1}
                >
                  {displayName}
                </Text>
              </View>
            )
          })}
        </View>
      )}
    </View>
  )
}

export default SubagentStats
