// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ToolPill Component (React Native)
 *
 * Compact summary pill for collapsed tool timeline.
 * Shows tool count, total duration, and success/error indicator.
 */

import { View, Text, Pressable } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { Wrench, CheckCircle2, XCircle, ChevronDown } from "lucide-react-native"
import { type ToolCallData } from "./types"
import { TransportBadge } from "../TransportBadge"

export interface ToolPillProps {
  tools: ToolCallData[]
  onPress?: () => void
  className?: string
}

export function ToolPill({ tools, onPress, className }: ToolPillProps) {
  if (tools.length === 0) {
    return null
  }

  const totalDuration = tools.reduce((sum, t) => sum + (t.duration || 0), 0)
  const hasErrors = tools.some((t) => t.state === "error")
  const hasStreaming = tools.some((t) => t.state === "streaming")
  const allSuccess = !hasErrors && !hasStreaming && tools.every((t) => t.state === "success")

  const formatDuration = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(1)}s`
  }

  return (
    <Pressable
      onPress={onPress}
      className={cn(
        "flex-row items-center gap-1.5 px-2 py-1 rounded-md",
        "bg-gray-100 dark:bg-gray-800",
        className
      )}
    >
      <Wrench className="w-3 h-3 text-gray-400" size={12} />

      <Text className="font-medium text-foreground text-xs">{tools.length}</Text>
      <Text className="text-xs text-gray-400">
        tool{tools.length !== 1 ? "s" : ""}
      </Text>

      {totalDuration > 0 && (
        <>
          <Text className="text-gray-300 text-xs">·</Text>
          <Text className="text-xs text-gray-400">{formatDuration(totalDuration)}</Text>
        </>
      )}

      {hasErrors && <XCircle className="w-3 h-3 text-red-500" size={12} />}
      {allSuccess && <CheckCircle2 className="w-3 h-3 text-green-500" size={12} />}

      <TransportBadge size="xs" className="ml-0.5" />

      {onPress && <ChevronDown className="w-3 h-3 ml-0.5 text-gray-400" size={12} />}
    </Pressable>
  )
}

export default ToolPill
