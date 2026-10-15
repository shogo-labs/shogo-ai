// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Everything the agent has running in this thread, in one dock panel: shell
 * commands, background subagents, calls to other projects, agents it tagged,
 * cards it waits on. Every kind is a task with the same row (icon, title,
 * elapsed, cancel, output), so new task sources need no new UI.
 *
 * Also shows when the agent is blocked in `wait`, and, once the turn has
 * ended, that it will pick up again when its tasks finish.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { View, Text, Pressable, ActivityIndicator } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { AtSign, Bot, Clock, Hourglass, KanbanSquare, Send, Terminal, X } from "lucide-react-native"
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

/** The agent is blocked in `wait` (from `data-task-wait`). */
export interface TaskWaitState {
  taskIds: string[]
  until?: string
  timeoutMs: number
  startedAt: number
}

export interface RunningDockPanelProps {
  processes: RunningProcess[]
  onKillProcess: (runId: string) => void | Promise<void>
  killingProcesses?: Set<string>
  subagents: SubagentProgress[]
  recentTools: RecentTool[]
  waiting?: TaskWaitState | null
  /** No turn is running: tasks that notify will start the next one. */
  agentIdle?: boolean
  /** Last part of a task's output, for the inline viewer. */
  loadOutput?: (taskId: string) => Promise<string | null>
}

const SOURCE_ICON: Record<string, typeof Terminal> = {
  shell: Terminal,
  subagent: Bot,
  project_call: Send,
  agent_reply: AtSign,
  work_item: KanbanSquare,
}

function taskId(proc: RunningProcess): string {
  return proc.id ?? proc.runId
}

function TaskRow({
  proc,
  now,
  waitedOn,
  killing,
  onKill,
  loadOutput,
}: {
  proc: RunningProcess
  now: number
  waitedOn: boolean
  killing: boolean
  onKill: () => void
  loadOutput?: (taskId: string) => Promise<string | null>
}) {
  const [output, setOutput] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const Icon = SOURCE_ICON[proc.source ?? "shell"] ?? Terminal
  const isShell = !proc.source || proc.source === "shell"
  const title = proc.title || proc.command
  const canShowOutput = !!loadOutput && !proc.stale

  async function toggleOutput() {
    if (output !== null) {
      setOutput(null)
      return
    }
    if (!loadOutput) return
    setLoading(true)
    try {
      const text = await loadOutput(taskId(proc))
      setOutput((text ?? "").split("\n").slice(-20).join("\n") || "(no output yet)")
    } finally {
      setLoading(false)
    }
  }

  return (
    <View className="gap-1">
      <View className="flex-row items-center gap-2">
        <Icon size={11} className={cn("shrink-0", waitedOn ? "text-primary" : "text-muted-foreground")} />
        <Text
          className={cn("flex-1 text-[11px] text-foreground", isShell && "font-mono")}
          numberOfLines={1}
        >
          {title}
        </Text>
        {waitedOn ? <Text className="text-[9px] font-medium text-primary">waiting</Text> : null}
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
        {canShowOutput ? (
          <Pressable
            onPress={toggleOutput}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={output !== null ? "Hide output" : "Show output"}
            className="rounded px-1.5 py-0.5 active:opacity-60"
          >
            {loading ? (
              <ActivityIndicator size="small" />
            ) : (
              <Text className="text-[10px] text-muted-foreground">{output !== null ? "Hide" : "Output"}</Text>
            )}
          </Pressable>
        ) : null}
        <Pressable
          onPress={onKill}
          disabled={killing}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={proc.stale ? "Dismiss" : isShell ? "Kill process" : "Cancel task"}
          className={cn(
            "flex-row items-center gap-1 rounded px-1.5 py-0.5 bg-red-500/10 border border-red-500/20 active:opacity-60",
            killing && "opacity-40",
          )}
        >
          {killing ? <ActivityIndicator size="small" color="#ef4444" /> : <X size={10} className="text-red-400" />}
          <Text className="text-[10px] font-medium text-red-400">
            {proc.stale ? "Dismiss" : isShell ? "Kill" : "Cancel"}
          </Text>
        </Pressable>
      </View>
      {output !== null ? (
        <Text className="ml-5 font-mono text-[10px] text-muted-foreground" selectable>
          {output}
        </Text>
      ) : null}
    </View>
  )
}

function RunningBody({
  processes,
  onKillProcess,
  killingProcesses,
  subagents,
  waiting,
  agentIdle,
  loadOutput,
}: RunningDockPanelProps) {
  const [now, setNow] = useState(() => Date.now())
  const pendingKills = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (processes.length === 0 && !waiting) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [processes.length, waiting])

  function handleKill(runId: string) {
    if (pendingKills.current.has(runId)) return
    pendingKills.current.add(runId)
    Promise.resolve(onKillProcess(runId)).finally(() => {
      pendingKills.current.delete(runId)
    })
  }

  const waitedOn = new Set(waiting?.taskIds ?? [])
  const notifying = processes.filter((p) => p.notify && !p.stale)
  // Background subagents are listed as tasks; the live progress rows only add
  // to that when no subagent task is shown.
  const showSubagentRows = !processes.some((p) => p.source === "subagent")

  return (
    <View className="gap-2">
      {waiting ? (
        <View className="flex-row items-center gap-2 rounded-md bg-primary/10 px-2 py-1">
          <Hourglass size={11} className="text-primary" />
          <Text className="flex-1 text-[11px] text-primary" numberOfLines={1}>
            {waiting.taskIds.length === 0
              ? "Agent is pausing"
              : `Agent is waiting on ${waiting.taskIds.length === 1 ? "a task" : `${waiting.taskIds.length} tasks`}`}
            {waiting.until ? ` until "${waiting.until}"` : ""}
          </Text>
          <Text className="text-[10px] font-mono text-primary/80">
            {formatElapsed(now - waiting.startedAt)} / {formatElapsed(waiting.timeoutMs)}
          </Text>
        </View>
      ) : null}

      {processes.map((proc) => (
        <TaskRow
          key={proc.runId}
          proc={proc}
          now={now}
          waitedOn={waitedOn.has(taskId(proc))}
          killing={killingProcesses?.has(proc.runId) ?? false}
          onKill={() => handleKill(proc.runId)}
          loadOutput={loadOutput}
        />
      ))}

      {showSubagentRows
        ? subagents.map((subagent) => {
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
          })
        : null}

      {agentIdle && !waiting && notifying.length > 0 ? (
        <View className="flex-row items-center gap-2 rounded-md border border-border/50 px-2 py-1">
          <Hourglass size={11} className="text-muted-foreground" />
          <Text className="flex-1 text-[10px] text-muted-foreground">
            {`Waiting on ${notifying.length === 1 ? "1 task" : `${notifying.length} tasks`} · the agent will continue when ${notifying.length === 1 ? "it finishes" : "they finish"}`}
          </Text>
        </View>
      ) : null}
    </View>
  )
}

export function RunningDockPanel(props: RunningDockPanelProps) {
  const { processes, subagents, recentTools, waiting, agentIdle } = props
  const runningSubagents = subagents.filter((s) => s.status === "running").length

  const descriptor = useMemo<DockPanelDescriptor | null>(() => {
    if (processes.length === 0 && subagents.length === 0 && !waiting) return null
    const parts: string[] = []
    if (waiting) parts.push("agent waiting")
    const tasks = processes.length
    if (tasks > 0) parts.push(`${tasks} task${tasks === 1 ? "" : "s"}`)
    if (subagents.length > 0 && !processes.some((p) => p.source === "subagent")) {
      parts.push(`${subagents.length} agent${subagents.length === 1 ? "" : "s"}`)
    }
    return {
      id: "running",
      kind: "status",
      order: 60,
      title: waiting ? "Waiting" : "Running",
      icon: waiting ? Hourglass : Terminal,
      accent: waiting || processes.length > 0 || runningSubagents > 0 ? "running" : "default",
      summary: parts.join(" · "),
      defaultExpanded: true,
      render: () => <RunningBody {...props} />,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processes, subagents, recentTools, runningSubagents, waiting, agentIdle])

  useDockPanel(descriptor)
  return null
}
