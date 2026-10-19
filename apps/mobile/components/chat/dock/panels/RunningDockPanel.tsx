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

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { View, Text, Pressable, ActivityIndicator, type LayoutChangeEvent } from "react-native"
import { Motion, AnimatePresence } from "@legendapp/motion"
import { cn } from "@shogo/shared-ui/primitives"
import { AtSign, Ban, Bot, ChevronRight, CircleCheck, CircleX, Clock, Hourglass, KanbanSquare, Send, Terminal, X } from "lucide-react-native"
import type { RunningProcess } from "../../ProcessPanel"
import type { SubagentProgress } from "../../subagent/SubagentPanel"
import type { RecentTool } from "../../subagent/SubagentStats"
import { linkOpensThread, type TaskOutputInfo } from "../../../../lib/task-link"
import { useDockPanel } from "../useDockPanel"
import type { DockPanelDescriptor } from "../../../../lib/chat-dock-store"
import {
  DOCK_FINISHED_EXIT_MS,
  visibleLingerDelayMs,
  isFinishedProcess,
  processKey,
} from "../finished-rows"

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
  loadOutput?: (taskId: string) => Promise<TaskOutputInfo | null>
  /** Open a task's destination (thread, card, project session, log) in the side window. */
  onOpenTask?: (proc: RunningProcess) => void
}

const SOURCE_ICON: Record<string, typeof Terminal> = {
  shell: Terminal,
  subagent: Bot,
  project_call: Send,
  agent_reply: AtSign,
  work_item: KanbanSquare,
}

// A row's exit: Motion cannot animate `height: "auto"`, so the wrapper starts
// from the height measured on its last layout and collapses to 0.
const ROW_SHOWN = { opacity: 1 }
const ROW_EXIT = { opacity: 0, height: 0 }
const ROW_TRANSITION = {
  opacity: { type: "timing", duration: 0 },
}
const EXIT_TRANSITION = {
  opacity: { type: "timing", duration: DOCK_FINISHED_EXIT_MS, easing: "easeInOut" },
  height: { type: "timing", duration: DOCK_FINISHED_EXIT_MS, easing: "easeInOut" },
}
const ROW_STYLE = { overflow: "hidden" as const }

function finishedLabel(proc: RunningProcess): string {
  if (proc.status === "failed") return "failed"
  if (proc.status === "cancelled") return "cancelled"
  return "completed"
}

function StatusIcon({ proc }: { proc: RunningProcess }) {
  if (proc.status === "failed") return <CircleX size={11} className="shrink-0 text-red-400" />
  if (proc.status === "cancelled") return <Ban size={11} className="shrink-0 text-muted-foreground/70" />
  return <CircleCheck size={11} className="shrink-0 text-green-500" />
}

/** Running vs recently finished rows (the panel summary and the wake line). */
export function dockProcessCounts(processes: RunningProcess[]): {
  running: number
  finished: number
} {
  let running = 0
  let finished = 0
  for (const proc of processes) {
    if (isFinishedProcess(proc)) finished++
    else running++
  }
  return { running, finished }
}

function TaskRow({
  proc,
  now,
  waitedOn,
  killing,
  onKill,
  loadOutput,
  onOpen,
  onHoldChange,
}: {
  proc: RunningProcess
  now: number
  waitedOn: boolean
  killing: boolean
  onKill: () => void
  loadOutput?: (taskId: string) => Promise<TaskOutputInfo | null>
  onOpen?: () => void
  /** A row with its output viewer open is pinned: it must not retire underneath the reader. */
  onHoldChange?: (key: string, holding: boolean) => void
}) {
  const [output, setOutput] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const Icon = SOURCE_ICON[proc.source ?? "shell"] ?? Terminal
  const isShell = !proc.source || proc.source === "shell"
  const title = proc.title || proc.command
  const key = processKey(proc)
  const finished = isFinishedProcess(proc)
  const canShowOutput = !!loadOutput && !proc.stale
  const opensThread = linkOpensThread(proc.link)
  const frozenMs = proc.finishedAt
    ? Math.max(0, proc.finishedAt - (proc.startedAt ?? proc.finishedAt))
    : (proc.elapsedMs ?? 0)
  const holding = output !== null

  useEffect(() => {
    if (!holding) return
    onHoldChange?.(key, true)
    return () => onHoldChange?.(key, false)
  }, [holding, key, onHoldChange])

  async function toggleOutput() {
    if (output !== null) {
      setOutput(null)
      return
    }
    if (!loadOutput) return
    setLoading(true)
    try {
      const info = await loadOutput(key)
      const text = (info?.output ?? "").split("\n").slice(-20).join("\n")
      setOutput(text.trim() ? text : "No output yet")
    } finally {
      setLoading(false)
    }
  }

  const Title = (
    <>
      {finished ? (
        <StatusIcon proc={proc} />
      ) : (
        <Icon size={11} className={cn("shrink-0", waitedOn ? "text-primary" : "text-muted-foreground")} />
      )}
      <Text
        className={cn(
          "flex-1 text-[11px] text-foreground",
          isShell && "font-mono",
          finished && "text-muted-foreground",
        )}
        numberOfLines={1}
      >
        {title}
      </Text>
      {opensThread ? <ChevronRight size={11} className="shrink-0 text-muted-foreground/70" /> : null}
    </>
  )

  return (
    <View className="gap-1">
      <View className="flex-row items-center gap-2">
        {onOpen ? (
          <Pressable
            onPress={onOpen}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={`Open ${title}`}
            className="min-w-0 flex-1 flex-row items-center gap-2 active:opacity-60"
          >
            {Title}
          </Pressable>
        ) : (
          <View className="min-w-0 flex-1 flex-row items-center gap-2">{Title}</View>
        )}
        {waitedOn && !finished ? <Text className="text-[9px] font-medium text-primary">waiting</Text> : null}
        {finished ? (
          <View className="flex-row items-center gap-1">
            <Text className="text-[9px] font-medium text-muted-foreground/80">{finishedLabel(proc)}</Text>
            <Clock size={10} className="text-muted-foreground/70" />
            <Text className="text-[10px] font-mono text-muted-foreground">
              {formatElapsed(frozenMs)}
            </Text>
          </View>
        ) : proc.stale ? (
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
        {finished ? null : (
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
        )}
      </View>
      {output !== null ? (
        <Text className="ml-5 font-mono text-[10px] text-muted-foreground" selectable>
          {output}
        </Text>
      ) : null}
    </View>
  )
}

interface RunningBodyProps extends Omit<RunningDockPanelProps, "processes" | "recentTools"> {
  /** Rows still on screen — retired ones are filtered out by the panel. */
  processes: RunningProcess[]
  /** Rows playing their exit animation. */
  exiting: ReadonlySet<string>
  /** Rows that were pinned back open from inside their exit: full size again. */
  restored: ReadonlySet<string>
  onHoldChange: (key: string, holding: boolean) => void
}

function RunningBody({
  processes,
  onKillProcess,
  killingProcesses,
  subagents,
  waiting,
  agentIdle,
  loadOutput,
  onOpenTask,
  exiting,
  restored,
  onHoldChange,
}: RunningBodyProps) {
  const [now, setNow] = useState(() => Date.now())
  const pendingKills = useRef<Set<string>>(new Set())
  // Motion cannot animate `height: "auto"`: each row's last laid-out height is
  // the start of its exit. A row that is not exiting keeps no height at all,
  // so an open output viewer can grow it.
  const heights = useRef<Map<string, number>>(new Map())
  // A row pinned back out of its exit keeps an explicit height — once Motion has
  // animated it, style.height stays an animated value — so it is measured into
  // state and the row grows with its output instead of clipping it.
  const [restoredHeights, setRestoredHeights] = useState<Record<string, number>>({})

  useEffect(() => {
    const hasRunning = processes.some((p) => !isFinishedProcess(p))
    if (!hasRunning && !waiting) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [processes, waiting])

  function handleKill(runId: string) {
    if (pendingKills.current.has(runId)) return
    pendingKills.current.add(runId)
    Promise.resolve(onKillProcess(runId)).finally(() => {
      pendingKills.current.delete(runId)
    })
  }

  function handleRowLayout(key: string, e: LayoutChangeEvent) {
    const height = e.nativeEvent.layout.height
    if (height > 0) heights.current.set(key, height)
    if (height <= 0 || !restored.has(key)) return
    setRestoredHeights((prev) =>
      Math.abs((prev[key] ?? -1) - height) < 0.5 ? prev : { ...prev, [key]: height },
    )
  }

  const waitedOn = new Set(waiting?.taskIds ?? [])
  // Only a running task can wake the agent; a finished row just lingers.
  const notifying = processes.filter((p) => p.notify && !p.stale && !isFinishedProcess(p))
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

      <AnimatePresence initial={false}>
        {processes.map((proc) => {
          const key = processKey(proc)
          const isExiting = exiting.has(key)
          const isRestored = !isExiting && restored.has(key)
          const shownHeight = restoredHeights[key] ?? heights.current.get(key) ?? 0
          return (
            <Motion.View
              key={key}
              animate={
                isExiting ? ROW_EXIT : isRestored ? { opacity: 1, height: shownHeight } : ROW_SHOWN
              }
              initial={isExiting ? { opacity: 1, height: heights.current.get(key) ?? 0 } : undefined}
              transition={isExiting || isRestored ? EXIT_TRANSITION : ROW_TRANSITION}
              style={ROW_STYLE}
            >
              <View onLayout={(e) => handleRowLayout(key, e)}>
                <TaskRow
                  proc={proc}
                  now={now}
                  waitedOn={waitedOn.has(key)}
                  killing={killingProcesses?.has(proc.runId) ?? false}
                  onKill={() => handleKill(proc.runId)}
                  loadOutput={loadOutput}
                  onOpen={onOpenTask ? () => onOpenTask(proc) : undefined}
                  onHoldChange={onHoldChange}
                />
              </View>
            </Motion.View>
          )
        })}
      </AnimatePresence>

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

interface Retirement {
  /** Rows playing their exit animation — still mounted, on their way out. */
  exiting: Set<string>
  /** Rows removed from the dock. The poll keeps listing them for ten minutes; this set is the authority. */
  gone: Set<string>
  /** Rows pinned back open from inside their exit — on screen again, still to be retired. */
  restored: Set<string>
  /** Bumped on every change so the dock re-renders its body even when the header text is unchanged. */
  revision: number
}

const EMPTY_RETIREMENT: Retirement = { exiting: new Set(), gone: new Set(), restored: new Set(), revision: 0 }

function without(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set)
  next.delete(key)
  return next
}

export function RunningDockPanel(props: RunningDockPanelProps) {
  const { processes, subagents, recentTools, waiting, agentIdle } = props
  const runningSubagents = subagents.filter((s) => s.status === "running").length

  // A settled row is readable for DOCK_FINISHED_LINGER_MS, then animates out.
  // Retirement lives here, above the descriptor's body, so a poll that
  // re-sends the row cannot restart the countdown.
  const [retirement, setRetirement] = useState<Retirement>(EMPTY_RETIREMENT)
  // Rows with their output viewer open are pinned until it closes.
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set())
  // The same set, readable inside a timer: a click and the exit timeout can
  // land in the same tick, and a row must never retire under its reader.
  const heldRef = useRef<Set<string>>(new Set())
  const timers = useRef(
    new Map<string, { linger: ReturnType<typeof setTimeout>; exit?: ReturnType<typeof setTimeout> }>(),
  )
  // When the dock first rendered each row as settled — the anchor for the
  // readable window. Written once per task, so a poll cannot restart it.
  const firstSettledAt = useRef<Map<string, number>>(new Map())

  const clearTimers = useCallback(() => {
    for (const timer of timers.current.values()) {
      clearTimeout(timer.linger)
      if (timer.exit) clearTimeout(timer.exit)
    }
    timers.current.clear()
  }, [])

  useEffect(() => clearTimers, [clearTimers])

  // Nothing left to retire: drop the bookkeeping so a later session starts
  // clean instead of remembering task ids that will never come back.
  useEffect(() => {
    if (processes.length > 0) return
    clearTimers()
    firstSettledAt.current.clear()
    setRetirement((prev) =>
      prev.gone.size === 0 && prev.exiting.size === 0 && prev.restored.size === 0
        ? prev
        : { exiting: new Set(), gone: new Set(), restored: new Set(), revision: prev.revision + 1 },
    )
  }, [processes.length, clearTimers])

  const handleHoldChange = useCallback((key: string, holding: boolean) => {
    if (holding) heldRef.current.add(key)
    else heldRef.current.delete(key)
    setHeld((prev) => {
      if (prev.has(key) === holding) return prev
      const next = new Set(prev)
      if (holding) next.add(key)
      else next.delete(key)
      return next
    })
    if (!holding) return
    // Pinned from inside its exit: the row goes back to full size instead of
    // staying mounted at height 0, where nothing would ever bring it back.
    setRetirement((prev) =>
      prev.exiting.has(key)
        ? {
            exiting: without(prev.exiting, key),
            gone: prev.gone,
            restored: new Set(prev.restored).add(key),
            revision: prev.revision + 1,
          }
        : prev,
    )
  }, [])

  useEffect(() => {
    const now = Date.now()
    const present = new Map<string, RunningProcess>()
    for (const proc of processes) present.set(processKey(proc), proc)

    // Anchor the readable window at first sight, including for a row that is
    // held: once its Output closes it is long past it and leaves immediately.
    for (const proc of processes) {
      if (!isFinishedProcess(proc)) continue
      const key = processKey(proc)
      if (!firstSettledAt.current.has(key)) firstSettledAt.current.set(key, now)
    }

    for (const [key, timer] of timers.current) {
      const proc = present.get(key)
      const eligible =
        !!proc && isFinishedProcess(proc) && !retirement.gone.has(key) && !held.has(key)
      if (eligible) continue
      clearTimeout(timer.linger)
      if (timer.exit) clearTimeout(timer.exit)
      timers.current.delete(key)
    }

    for (const proc of processes) {
      if (!isFinishedProcess(proc)) continue
      const key = processKey(proc)
      if (retirement.gone.has(key) || retirement.exiting.has(key) || held.has(key)) continue
      if (timers.current.has(key)) continue

      const timer: { linger: ReturnType<typeof setTimeout>; exit?: ReturnType<typeof setTimeout> } = {
        linger: setTimeout(() => {
          setRetirement((prev) =>
            prev.gone.has(key) || prev.exiting.has(key)
              ? prev
              : {
                  exiting: new Set(prev.exiting).add(key),
                  gone: prev.gone,
                  restored: prev.restored,
                  revision: prev.revision + 1,
                },
          )
          timer.exit = setTimeout(() => {
            timers.current.delete(key)
            // Held again while the exit was running: the row is being read, so
            // it goes back on screen instead of vanishing underneath the reader.
            if (heldRef.current.has(key)) {
              setRetirement((prev) =>
                prev.exiting.has(key)
                  ? {
                      exiting: without(prev.exiting, key),
                      gone: prev.gone,
                      restored: new Set(prev.restored).add(key),
                      revision: prev.revision + 1,
                    }
                  : prev,
              )
              return
            }
            setRetirement((prev) => {
              if (prev.gone.has(key)) return prev
              return {
                exiting: without(prev.exiting, key),
                gone: new Set(prev.gone).add(key),
                restored: prev.restored,
                revision: prev.revision + 1,
              }
            })
          }, DOCK_FINISHED_EXIT_MS)
        }, visibleLingerDelayMs(proc, now, firstSettledAt.current.get(key) ?? now)),
      }
      timers.current.set(key, timer)
    }
  }, [processes, held, retirement])

  const visible = useMemo(
    () => processes.filter((proc) => !retirement.gone.has(processKey(proc))),
    [processes, retirement.gone],
  )

  const descriptor = useMemo<DockPanelDescriptor | null>(() => {
    if (visible.length === 0 && subagents.length === 0 && !waiting) return null
    const counts = dockProcessCounts(visible)
    const parts: string[] = []
    if (waiting) parts.push("agent waiting")
    if (counts.running > 0) {
      parts.push(`${counts.running} running`)
    }
    if (counts.finished > 0) {
      parts.push(`${counts.finished} finished`)
    }
    if (subagents.length > 0 && !visible.some((p) => p.source === "subagent")) {
      parts.push(`${subagents.length} agent${subagents.length === 1 ? "" : "s"}`)
    }
    const onlyFinished = counts.running === 0 && counts.finished > 0
    return {
      id: "running",
      kind: "status",
      order: 60,
      revision: retirement.revision,
      title: waiting ? "Waiting" : onlyFinished ? "Finished" : "Running",
      icon: waiting ? Hourglass : Terminal,
      accent: waiting || counts.running > 0 || runningSubagents > 0 ? "running" : "default",
      summary: parts.join(" · "),
      defaultExpanded: true,
      render: () => (
        <RunningBody
          {...props}
          processes={visible}
          exiting={retirement.exiting}
          restored={retirement.restored}
          onHoldChange={handleHoldChange}
        />
      ),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    visible,
    subagents,
    recentTools,
    runningSubagents,
    waiting,
    agentIdle,
    retirement.exiting,
    retirement.restored,
    retirement.revision,
    handleHoldChange,
    props.onOpenTask,
    props.loadOutput,
    props.onKillProcess,
    props.killingProcesses,
  ])

  useDockPanel(descriptor)
  return null
}
