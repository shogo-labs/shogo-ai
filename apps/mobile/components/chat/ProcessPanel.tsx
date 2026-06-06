// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ProcessPanel Component (React Native)
 *
 * Shows the background shell processes the agent has started in this thread
 * that are still running. Lets the user terminate one (or dismiss a stale
 * entry left over from a runtime restart). Seeded from the runtime's process
 * endpoint and kept live by `data-process-update` SSE frames.
 */

import { useState } from "react"
import { View, Text, Pressable, ActivityIndicator } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { ChevronDown, ChevronUp, Terminal, X } from "lucide-react-native"

export interface RunningProcess {
  runId: string
  command: string
  pid?: number
  sandboxed?: boolean
  containerName?: string
  startedAt: number
  elapsedMs: number
  stale?: boolean
}

export interface ProcessPanelProps {
  processes: RunningProcess[]
  /** Kill (or dismiss, for stale) a process by run id. */
  onKill: (runId: string) => void | Promise<void>
  /** Run ids currently being killed (shows a spinner, disables the button). */
  killing?: Set<string>
  defaultExpanded?: boolean
  className?: string
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export function ProcessPanel({
  processes,
  onKill,
  killing,
  defaultExpanded = true,
  className,
}: ProcessPanelProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)

  if (processes.length === 0) {
    return null
  }

  return (
    <View
      className={cn(
        "rounded-md border border-gray-200/50 dark:border-gray-700/50 bg-gray-50/40 dark:bg-gray-900/40",
        "overflow-hidden",
        className
      )}
    >
      {/* Header */}
      <Pressable
        onPress={() => setIsExpanded(!isExpanded)}
        className="w-full flex-row items-center justify-between px-3 py-2"
      >
        <View className="flex-row items-center gap-2">
          <View className="w-2 h-2 rounded-full bg-primary" />
          <Text className="text-xs font-semibold text-foreground/80">
            {`Running Command${processes.length > 1 ? "s" : ""}`}
          </Text>
          <Text className="text-xs text-gray-400">({processes.length})</Text>
        </View>

        {isExpanded ? (
          <ChevronUp className="w-3.5 h-3.5 text-gray-400" size={14} />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-gray-400" size={14} />
        )}
      </Pressable>

      {/* Expanded content */}
      {isExpanded && (
        <View className="px-3 pb-3 gap-2">
          {processes.map((proc) => {
            const isKilling = killing?.has(proc.runId) ?? false
            return (
              <View
                key={proc.runId}
                className="flex-row items-center gap-2 pl-3 border-l-2 border-primary/30"
              >
                <Terminal className="w-3.5 h-3.5 text-primary shrink-0" size={14} />
                <View className="flex-1">
                  <Text
                    className="text-xs font-mono text-foreground/90"
                    numberOfLines={1}
                  >
                    {proc.command}
                  </Text>
                  <View className="flex-row items-center gap-2 mt-0.5">
                    {proc.pid != null && (
                      <Text className="text-[10px] text-gray-400">pid {proc.pid}</Text>
                    )}
                    <Text className="text-[10px] text-gray-400">
                      {formatElapsed(proc.elapsedMs)}
                    </Text>
                    {proc.stale && (
                      <Text className="text-[10px] font-medium px-1.5 py-0.5 rounded text-yellow-600 bg-yellow-500/10">
                        unverified
                      </Text>
                    )}
                  </View>
                </View>

                <Pressable
                  onPress={() => onKill(proc.runId)}
                  disabled={isKilling}
                  accessibilityRole="button"
                  accessibilityLabel={proc.stale ? "Dismiss process" : "Kill process"}
                  hitSlop={8}
                  className={cn(
                    "flex-row items-center gap-1 rounded px-2 py-1",
                    "border border-red-400/40 active:opacity-70",
                    isKilling && "opacity-50"
                  )}
                >
                  {isKilling ? (
                    <ActivityIndicator size="small" />
                  ) : (
                    <X size={12} className="text-red-500" />
                  )}
                  <Text className="text-[10px] font-medium text-red-500">
                    {proc.stale ? "Dismiss" : "Kill"}
                  </Text>
                </Pressable>
              </View>
            )
          })}
        </View>
      )}
    </View>
  )
}

export default ProcessPanel
