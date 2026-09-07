// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Merges background shell processes (body lifted from `ProcessPanel`) and
 * live subagents (body lifted from `SubagentPanel` / `SubagentStats`) into
 * one dock panel, replacing both standalone slots. Subagent rows stay
 * informational (status, elapsed time, tool count) — the pre-dock
 * `SubagentPanel` never exposed a stop control either, only shell processes
 * did, so that parity carries over unchanged.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { View, Text, Pressable, ActivityIndicator } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { Terminal, Clock, X, Bot } from "lucide-react-native"
import type { RunningProcess } from "../../ProcessPanel"
import type { SubagentProgress } from "../../subagent/SubagentPanel"
import type { RecentTool } from "../../subagent/SubagentStats"
import { useDockPanel } from "../useDockPanel"
import type { DockPanelDescriptor } from "../../../../lib/chat-dock-store"

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export interface RunningDockPanelProps {
  processes: RunningProcess[]
  onKillProcess: (runId: string) => void | Promise<void>
  killingProcesses?: Set<string>
  subagents: SubagentProgress[]
  recentTools: RecentTool[]
}

function RunningBody({ processes, onKillProcess, killingProcesses, subagents, recentTools }: RunningDockPanelProps) {
  const [now, setNow] = useState(() => Date.now())
  const pendingKills = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (processes.length === 0) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [processes.length])

  function handleKill(runId: string) {
    if (pendingKills.current.has(runId)) return
    pendingKills.current.add(runId)
    Promise.resolve(onKillProcess(runId)).finally(() => {
      pendingKills.current.delete(runId)
    })
  }

  return (
    <View className="gap-2">
      {processes.map((proc) => {
        const isKilling = killingProcesses?.has(proc.runId) ?? false
        return (
          <View key={proc.runId} className="flex-row items-center gap-2">
            <Terminal size={11} className="text-muted-foreground shrink-0" />
            <Text className="flex-1 text-[11px] font-mono text-foreground" numberOfLines={1}>
              {proc.command}
            </Text>
            {proc.stale ? (
              <Text className="text-[9px] font-medium text-yellow-500/80">unverified</Text>
            ) : (
              <View className="flex-row items-center gap-1">
                <Clock size={10} className="text-muted-foreground/70" />
                <Text className="text-[10px] font-mono text-muted-foreground">
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
                "flex-row items-center gap-1 rounded px-1.5 py-0.5 bg-red-500/10 border border-red-500/20 active:opacity-60",
                isKilling && "opacity-40",
              )}
            >
              {isKilling ? <ActivityIndicator size="small" color="#ef4444" /> : <X size={10} className="text-red-400" />}
              <Text className="text-[10px] font-medium text-red-400">{proc.stale ? "Dismiss" : "Kill"}</Text>
            </Pressable>
          </View>
        )
      })}

      {subagents.map((subagent) => {
        const isRunning = subagent.status === "running"
        return (
          <View key={subagent.agentId} className={cn("pl-2 border-l-2", isRunning ? "border-primary/30" : "border-green-500/30")}>
            <View className="flex-row items-center gap-2">
              <Bot size={12} className={isRunning ? "text-primary" : "text-green-500"} />
              <Text
                className={cn(
                  "text-[11px] font-medium px-1.5 py-0.5 rounded",
                  isRunning ? "text-primary bg-primary/10" : "text-green-500 bg-green-500/10",
                )}
              >
                {subagent.agentType}
              </Text>
              <Text className="text-[10px] text-muted-foreground font-mono">{subagent.toolCount} tools</Text>
              {!isRunning && <Text className="text-[10px] text-muted-foreground">(complete)</Text>}
            </View>
          </View>
        )
      })}
    </View>
  )
}

export function RunningDockPanel(props: RunningDockPanelProps) {
  const { processes, subagents, recentTools } = props
  const runningSubagents = subagents.filter((s) => s.status === "running").length

  const descriptor = useMemo<DockPanelDescriptor | null>(() => {
    if (processes.length === 0 && subagents.length === 0) return null
    const parts: string[] = []
    if (processes.length > 0) parts.push(`${processes.length} command${processes.length === 1 ? "" : "s"}`)
    if (subagents.length > 0) parts.push(`${subagents.length} agent${subagents.length === 1 ? "" : "s"}`)
    return {
      id: "running",
      kind: "status",
      order: 60,
      title: "Running",
      icon: Terminal,
      accent: processes.length > 0 || runningSubagents > 0 ? "running" : "default",
      summary: parts.join(" · "),
      defaultExpanded: true,
      chip: { icon: Terminal, dot: processes.length > 0 || runningSubagents > 0 },
      render: () => <RunningBody {...props} />,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processes, subagents, recentTools, runningSubagents])

  useDockPanel(descriptor)
  return null
}
