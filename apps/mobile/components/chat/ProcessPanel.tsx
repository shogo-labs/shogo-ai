// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ProcessPanel — shows background shell processes started by the agent in this
 * thread that are still running. Lets the user terminate a process or dismiss
 * a stale entry left over from a runtime restart.
 *
 * Data is seeded from the runtime's process endpoint and kept live via
 * `data-process-update` SSE frames in ChatPanel. Elapsed time is computed
 * locally using `Date.now() - proc.startedAt` so the display ticks even when
 * no SSE frames arrive.
 */
import { useState, useEffect, useRef } from "react"
import { View, Text, Pressable, ActivityIndicator } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { ChevronDown, ChevronUp, Terminal, X, Clock } from "lucide-react-native"

export interface RunningProcess {
  runId: string
  command: string
  pid?: number
  sandboxed?: boolean
  containerName?: string
  startedAt: number
  stale?: boolean
}

export interface ProcessPanelProps {
  processes: RunningProcess[]
  onKill: (runId: string) => void | Promise<void>
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

function truncateCommand(cmd: string, maxLen = 60): string {
  return cmd.length > maxLen ? cmd.slice(0, maxLen) + "…" : cmd
}

export function ProcessPanel({
  processes,
  onKill,
  killing,
  defaultExpanded = true,
  className,
}: ProcessPanelProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)
  const [now, setNow] = useState(() => Date.now())
  const pendingKills = useRef<Set<string>>(new Set())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  function handleKill(runId: string) {
    if (pendingKills.current.has(runId)) return
    pendingKills.current.add(runId)
    Promise.resolve(onKill(runId)).finally(() => {
      pendingKills.current.delete(runId)
    })
  }

  if (processes.length === 0) return null

  return (
    <View className={cn("max-w-3xl w-full self-center", className)}>
      {/* Header pill */}
      <Pressable
        onPress={() => setIsExpanded(!isExpanded)}
        className={cn(
          "flex-row items-center gap-2 px-3 py-1.5",
          "bg-zinc-900/90 dark:bg-zinc-800/90",
          "border border-zinc-700/60",
          isExpanded ? "rounded-t-lg" : "rounded-lg"
        )}
      >
        {/* Pulsing dot */}
        <View className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        <Terminal size={11} className="text-zinc-400" />
        <Text className="flex-1 text-[11px] font-medium text-zinc-300">
          {processes.length === 1
            ? truncateCommand(processes[0].command)
            : `${processes.length} running commands`}
        </Text>
        {processes.length === 1 && (
          <View className="flex-row items-center gap-1">
            <Clock size={10} className="text-zinc-500" />
            <Text className="text-[10px] font-mono text-zinc-500">
              {processes[0].startedAt ? formatElapsed(now - processes[0].startedAt) : "…"}
            </Text>
          </View>
        )}
        {isExpanded ? (
          <ChevronUp size={12} className="text-zinc-500" />
        ) : (
          <ChevronDown size={12} className="text-zinc-500" />
        )}
      </Pressable>

      {/* Expanded rows */}
      {isExpanded && (
        <View
          className={cn(
            "bg-zinc-900/70 dark:bg-zinc-800/70",
            "border-x border-b border-zinc-700/60",
            "rounded-b-lg overflow-hidden"
          )}
        >
          {processes.map((proc, idx) => {
            const isKilling = killing?.has(proc.runId) ?? false
            return (
              <View
                key={proc.runId}
                className={cn(
                  "flex-row items-center gap-2.5 px-3 py-2",
                  idx < processes.length - 1 && "border-b border-zinc-700/40"
                )}
              >
                <Text
                  className="flex-1 text-[11px] font-mono text-zinc-300"
                  numberOfLines={1}
                >
                  {proc.command}
                </Text>

                <View className="flex-row items-center gap-2">
                  {proc.stale ? (
                    <Text className="text-[9px] font-medium text-yellow-500/80">
                      unverified
                    </Text>
                  ) : (
                    <View className="flex-row items-center gap-1">
                      <Clock size={10} className="text-zinc-600" />
                      <Text className="text-[10px] font-mono text-zinc-500">
                        {proc.startedAt ? formatElapsed(now - proc.startedAt) : "…"}
                      </Text>
                    </View>
                  )}

                  <Pressable
                    onPress={() => handleKill(proc.runId)}
                    disabled={isKilling}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={proc.stale ? "Dismiss" : "Kill process"}
                    className={cn(
                      "flex-row items-center gap-1 rounded px-1.5 py-0.5",
                      "bg-red-500/10 border border-red-500/20 active:opacity-60",
                      isKilling && "opacity-40"
                    )}
                  >
                    {isKilling ? (
                      <ActivityIndicator size="small" color="#ef4444" />
                    ) : (
                      <X size={10} className="text-red-400" />
                    )}
                    <Text className="text-[10px] font-medium text-red-400">
                      {proc.stale ? "Dismiss" : "Kill"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            )
          })}
        </View>
      )}
    </View>
  )
}

export default ProcessPanel
