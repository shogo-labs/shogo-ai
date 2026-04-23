// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useMemo, useSyncExternalStore, useState, useCallback } from "react"
import { View, Text, ScrollView, Pressable } from "react-native"
import {
  Bot,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Wrench,
  Zap,
  Users,
  ListTodo,
  BookOpen,
  MessageSquare,
  Clock,
  GitFork,
  TrendingUp,
  AlertTriangle,
  Square,
} from "lucide-react-native"
import { Motion } from "@legendapp/motion"
import { cn } from "@shogo/shared-ui/primitives"
import { subagentStreamStore, type SubagentStreamData } from "../../../lib/subagent-stream-store"
import { stopSubagent } from "../../../lib/subagent-stop"
import { teamStore, type TeamData, type MemberData, type TaskData, type MessageData, type ActivityEvent, type AgentTypeInfo } from "../../../lib/team-store"
import { MarkdownText } from "../../chat/MarkdownText"
import { ThinkingWidget } from "../../chat/turns/ThinkingWidget"
import { InlineToolWidget } from "../../chat/turns/InlineToolWidget"
import { LiveBrowserView } from "../../chat/LiveBrowserView"
import type { MessagePart } from "../../chat/turns/types"

// ---------------------------------------------------------------------------
// Props + shared helpers
// ---------------------------------------------------------------------------

interface AgentsPanelProps {
  visible: boolean
  selectedToolId?: string | null
  /** Agent runtime base URL — threaded through to the Live browser screencast
   *  subscription under each running subagent card. */
  agentUrl?: string | null
}

type SubTab = "activity" | "tasks" | "team" | "registry"

const PULSE_DURATION = 1200

function PulsingDot() {
  return (
    <Motion.View
      initial={{ opacity: 0.4, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{
        type: "timing",
        duration: PULSE_DURATION,
        easing: "easeInOut",
        repeat: Infinity,
        repeatReverse: true,
      }}
      className="w-2 h-2 rounded-full bg-primary"
    />
  )
}

function StreamPartsRenderer({ parts }: { parts: MessagePart[] }) {
  if (parts.length === 0) return null
  return (
    <View className="gap-2">
      {parts.map((part) => {
        if (part.type === "text") {
          return (
            <View key={part.id}>
              <MarkdownText className="text-foreground text-xs prose-sm">
                {part.text}
              </MarkdownText>
            </View>
          )
        }
        if (part.type === "reasoning") {
          return (
            <ThinkingWidget
              key={part.id}
              text={part.text}
              isStreaming={part.isStreaming}
              durationSeconds={part.durationSeconds}
            />
          )
        }
        if (part.type === "tool") {
          return <InlineToolWidget key={part.id} tool={part.tool} />
        }
        return null
      })}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Activity Sub-tab
// ---------------------------------------------------------------------------

function AgentEntry({
  toolId,
  data,
  isExpanded,
  onToggle,
  agentUrl,
}: {
  toolId: string
  data: SubagentStreamData
  isExpanded: boolean
  onToggle: () => void
  agentUrl?: string | null
}) {
  const isRunning = data.status === "running"
  const isDone = data.status === "completed"
  const isError = data.status === "error"
  const label = data.description || data.agentType || "Sub-agent"

  const canStop = isRunning && !!data.instanceId
  const handleStop = (e: any) => {
    if (e?.stopPropagation) e.stopPropagation()
    if (!data.instanceId) return
    stopSubagent(data.instanceId, toolId)
  }

  return (
    <View className="rounded-lg border border-border/40 bg-muted/20 overflow-hidden">
      <Pressable onPress={onToggle} className="px-3 py-3 flex-row items-center gap-2">
        <Bot className="text-muted-foreground" size={16} />
        <Text className="flex-1 text-xs font-semibold text-foreground" numberOfLines={1}>
          {label}
        </Text>
        {data.model && (
          <Text className="text-[10px] text-muted-foreground font-mono px-1.5 py-0.5 rounded bg-muted/60" numberOfLines={1}>
            {data.model}
          </Text>
        )}
        <Text className="text-[10px] text-muted-foreground font-mono px-1.5 py-0.5 rounded bg-muted/60">
          {data.agentType}
        </Text>
        {canStop ? (
          <Pressable
            onPress={handleStop}
            accessibilityLabel="Stop subagent"
            testID={`stop-subagent-${data.instanceId}`}
            hitSlop={6}
            className="h-5 w-5 rounded-full bg-destructive items-center justify-center active:opacity-70"
          >
            <Square className="text-destructive-foreground m-auto" size={10} />
          </Pressable>
        ) : (
          isRunning && <PulsingDot />
        )}
        {isDone && <CheckCircle2 className="text-muted-foreground" size={14} />}
        {isError && <XCircle className="text-muted-foreground" size={14} />}
        {isExpanded ? (
          <ChevronDown className="text-muted-foreground/50" size={14} />
        ) : (
          <ChevronRight className="text-muted-foreground/50" size={14} />
        )}
      </Pressable>

      {isExpanded && (
        <View className="px-3 pb-3 gap-2 border-t border-border/30">
          {data.instanceId && isRunning && (
            <View className="pt-2">
              <LiveBrowserView instanceId={data.instanceId} active={isRunning} agentUrl={agentUrl} />
            </View>
          )}
          {data.parts.length > 0 && (
            <View className="flex-row items-center gap-4 pt-1">
              {(() => {
                const toolCount = data.parts.filter((p) => p.type === "tool").length
                return toolCount > 0 ? (
                  <View className="flex-row items-center gap-1.5">
                    <Wrench className="text-muted-foreground" size={12} />
                    <Text className="text-xs text-muted-foreground">
                      {toolCount} tool{toolCount !== 1 ? "s" : ""}
                    </Text>
                  </View>
                ) : null
              })()}
            </View>
          )}
          {data.parts.length > 0 ? (
            <View className="pt-1">
              <StreamPartsRenderer parts={data.parts} />
            </View>
          ) : isRunning ? (
            <View className="items-center justify-center py-4 gap-2">
              <View className="flex-row items-center gap-1.5">
                <View className="w-1.5 h-1.5 rounded-full bg-muted-foreground opacity-50" />
                <View className="w-1.5 h-1.5 rounded-full bg-muted-foreground opacity-50" />
                <View className="w-1.5 h-1.5 rounded-full bg-muted-foreground opacity-50" />
              </View>
              <Text className="text-xs text-muted-foreground">Working...</Text>
            </View>
          ) : null}
        </View>
      )}
    </View>
  )
}

function ActivitySubTab({ expandedIds, toggleExpanded, agentUrl }: {
  expandedIds: Set<string>
  toggleExpanded: (id: string) => void
  agentUrl?: string | null
}) {
  const subagentVersion = useSyncExternalStore(
    subagentStreamStore.subscribe,
    () => subagentStreamStore.getVersion(),
    () => subagentStreamStore.getVersion(),
  )

  const teamVersion = useSyncExternalStore(
    teamStore.subscribe,
    () => teamStore.getVersion(),
    () => teamStore.getVersion(),
  )

  // Partition subagent entries by status so we can show running runs ("Live")
  // above finished ones ("History"). Map iteration preserves insertion order,
  // and we reverse each bucket so the most recent entry is at the top.
  const { liveEntries, historyEntries } = useMemo(() => {
    const live: { toolId: string; data: SubagentStreamData }[] = []
    const history: { toolId: string; data: SubagentStreamData }[] = []
    for (const [toolId, data] of subagentStreamStore.getAll()) {
      if (data.status === "running") live.push({ toolId, data })
      else history.push({ toolId, data })
    }
    live.reverse()
    history.reverse()
    return { liveEntries: live, historyEntries: history }
  }, [subagentVersion])

  // Activity log — reversed so newest events are at the top, capped for the UI.
  const activityEvents = useMemo(
    () => [...teamStore.getActivity()].reverse().slice(0, 30),
    [teamVersion],
  )

  const hasLive = liveEntries.length > 0
  const hasHistory = historyEntries.length > 0 || activityEvents.length > 0

  if (!hasLive && !hasHistory) {
    return (
      <View className="flex-1 items-center justify-center px-6 gap-3">
        <Bot className="text-muted-foreground/30" size={40} />
        <Text className="text-sm text-muted-foreground text-center">
          No activity yet
        </Text>
        <Text className="text-xs text-muted-foreground/60 text-center">
          Sub-agents and team events will appear here.
        </Text>
      </View>
    )
  }

  return (
    <ScrollView className="flex-1" contentContainerClassName="px-4 py-3 gap-3 pb-8">
      {hasLive && (
        <View className="flex-row items-center gap-2 pt-1">
          <View className="w-1.5 h-1.5 rounded-full bg-primary" />
          <Text className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Live
          </Text>
          <View className="flex-1 h-px bg-border/40" />
        </View>
      )}
      {liveEntries.map(({ toolId, data }) => (
        <AgentEntry
          key={toolId}
          toolId={toolId}
          data={data}
          isExpanded={expandedIds.has(toolId)}
          onToggle={() => toggleExpanded(toolId)}
          agentUrl={agentUrl}
        />
      ))}

      {hasHistory && (
        <View className="flex-row items-center gap-2 pt-2">
          <Clock className="text-muted-foreground/60" size={10} />
          <Text className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            History
          </Text>
          <View className="flex-1 h-px bg-border/40" />
        </View>
      )}
      {historyEntries.map(({ toolId, data }) => (
        <AgentEntry
          key={toolId}
          toolId={toolId}
          data={data}
          isExpanded={expandedIds.has(toolId)}
          onToggle={() => toggleExpanded(toolId)}
          agentUrl={agentUrl}
        />
      ))}

      {activityEvents.length > 0 && historyEntries.length > 0 && (
        <View className="border-t border-border/30 my-1" />
      )}

      {activityEvents.map((ev) => (
        <View key={ev.id} className="flex-row items-center gap-2 px-1 py-1">
          <Clock className="text-muted-foreground/40" size={10} />
          <Text className="text-[10px] text-muted-foreground flex-1" numberOfLines={1}>
            {ev.type.replace(/-/g, " ")}{ev.detail ? `: ${ev.detail}` : ""}
          </Text>
          <Text className="text-[9px] text-muted-foreground/40">
            {new Date(ev.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </Text>
        </View>
      ))}
    </ScrollView>
  )
}

// ---------------------------------------------------------------------------
// Tasks Sub-tab
// ---------------------------------------------------------------------------

function TaskRow({ task }: { task: TaskData }) {
  return (
    <View className="flex-row items-center gap-2 px-3 py-2 rounded-md bg-muted/10">
      <View className="flex-1 gap-0.5">
        <Text className="text-xs font-medium text-foreground" numberOfLines={1}>
          {task.subject}
        </Text>
        {task.owner && (
          <Text className="text-[10px] text-muted-foreground" numberOfLines={1}>
            {task.owner}
          </Text>
        )}
      </View>
      {task.blockedBy.length > 0 && (
        <Text className="text-[9px] text-muted-foreground font-mono px-1 py-0.5 rounded bg-muted/40">
          blocked by #{task.blockedBy.join(", #")}
        </Text>
      )}
    </View>
  )
}

function TaskGroup({ title, tasks }: { title: string; tasks: TaskData[] }) {
  const [collapsed, setCollapsed] = useState(false)
  if (tasks.length === 0) return null
  return (
    <View className="gap-1.5">
      <Pressable onPress={() => setCollapsed(!collapsed)} className="flex-row items-center gap-1.5 px-1">
        {collapsed ? (
          <ChevronRight className="text-muted-foreground/50" size={12} />
        ) : (
          <ChevronDown className="text-muted-foreground/50" size={12} />
        )}
        <Text className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
          {title}
        </Text>
        <Text className="text-[10px] text-muted-foreground/50">{tasks.length}</Text>
      </Pressable>
      {!collapsed && (
        <View className="gap-1">
          {tasks.map((t) => <TaskRow key={t.id} task={t} />)}
        </View>
      )}
    </View>
  )
}

function TasksSubTab() {
  const teamVersion = useSyncExternalStore(
    teamStore.subscribe,
    () => teamStore.getVersion(),
    () => teamStore.getVersion(),
  )

  const allTasks = useMemo(() => {
    const result: TaskData[] = []
    for (const team of teamStore.getAllTeams().values()) {
      for (const task of team.tasks.values()) {
        if (task.status !== "deleted") result.push(task)
      }
    }
    return result
  }, [teamVersion])

  const pending = allTasks.filter((t) => t.status === "pending")
  const inProgress = allTasks.filter((t) => t.status === "in_progress")
  const completed = allTasks.filter((t) => t.status === "completed")

  if (allTasks.length === 0) {
    return (
      <View className="flex-1 items-center justify-center px-6 gap-3">
        <ListTodo className="text-muted-foreground/30" size={40} />
        <Text className="text-sm text-muted-foreground text-center">No tasks yet</Text>
        <Text className="text-xs text-muted-foreground/60 text-center">
          Tasks will appear when a team is created and work is assigned.
        </Text>
      </View>
    )
  }

  return (
    <ScrollView className="flex-1" contentContainerClassName="px-4 py-3 gap-4 pb-8">
      <TaskGroup title="In Progress" tasks={inProgress} />
      <TaskGroup title="Pending" tasks={pending} />
      <TaskGroup title="Completed" tasks={completed} />
    </ScrollView>
  )
}

// ---------------------------------------------------------------------------
// Team Sub-tab (members + messages)
// ---------------------------------------------------------------------------

function MemberCard({
  member,
  isExpanded,
  onToggle,
}: {
  member: MemberData
  isExpanded: boolean
  onToggle: () => void
}) {
  const isActive = member.status === "active"
  const isIdle = member.status === "idle"

  return (
    <View className="rounded-lg border border-border/40 bg-muted/20 overflow-hidden">
      <Pressable onPress={onToggle} className="px-3 py-2.5 flex-row items-center gap-2">
        {member.color ? (
          <View className="w-3 h-3 rounded-full" style={{ backgroundColor: member.color }} />
        ) : (
          <Bot className="text-muted-foreground" size={14} />
        )}
        <Text className="flex-1 text-xs font-semibold text-foreground" numberOfLines={1}>
          {member.name}
        </Text>
        {isActive && <PulsingDot />}
        {isIdle && <View className="w-2 h-2 rounded-full bg-muted-foreground/30" />}
        {member.status === "shutdown" && <XCircle className="text-muted-foreground/40" size={12} />}
        {isExpanded ? (
          <ChevronDown className="text-muted-foreground/50" size={14} />
        ) : (
          <ChevronRight className="text-muted-foreground/50" size={14} />
        )}
      </Pressable>

      {isExpanded && member.streamParts.length > 0 && (
        <View className="px-3 pb-3 border-t border-border/30 pt-2">
          <StreamPartsRenderer parts={member.streamParts} />
        </View>
      )}
    </View>
  )
}

function TeamMessageRow({ msg }: { msg: MessageData }) {
  return (
    <View className="flex-row gap-2 px-1 py-1">
      <Text className="text-[10px] font-mono text-muted-foreground/60 w-16" numberOfLines={1}>
        {msg.from.split("@")[0]}
      </Text>
      <Text className="text-[10px] text-foreground flex-1" numberOfLines={2}>
        {msg.summary || msg.message.slice(0, 120)}
      </Text>
    </View>
  )
}

function TeamSubTab({ expandedMemberIds, toggleMemberExpanded }: {
  expandedMemberIds: Set<string>
  toggleMemberExpanded: (id: string) => void
}) {
  const teamVersion = useSyncExternalStore(
    teamStore.subscribe,
    () => teamStore.getVersion(),
    () => teamStore.getVersion(),
  )

  const allTeams = useMemo(() => {
    const result: TeamData[] = []
    for (const team of teamStore.getAllTeams().values()) {
      result.push(team)
    }
    return result
  }, [teamVersion])

  if (allTeams.length === 0) {
    return (
      <View className="flex-1 items-center justify-center px-6 gap-3">
        <Users className="text-muted-foreground/30" size={40} />
        <Text className="text-sm text-muted-foreground text-center">No teams yet</Text>
        <Text className="text-xs text-muted-foreground/60 text-center">
          Teams will appear when the agent creates one for coordination.
        </Text>
      </View>
    )
  }

  return (
    <ScrollView className="flex-1" contentContainerClassName="px-4 py-3 gap-4 pb-8">
      {allTeams.map((team) => {
        const members = [...team.members.values()]
        const messages = team.messages.slice(-30)

        return (
          <View key={team.teamId} className="gap-3">
            <View className="gap-0.5">
              <Text className="text-sm font-semibold text-foreground">{team.name}</Text>
              {team.description && (
                <Text className="text-xs text-muted-foreground">{team.description}</Text>
              )}
            </View>

            {members.length > 0 && (
              <View className="gap-2">
                <Text className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide px-1">
                  Members ({members.length})
                </Text>
                {members.map((m) => (
                  <MemberCard
                    key={m.agentId}
                    member={m}
                    isExpanded={expandedMemberIds.has(m.agentId)}
                    onToggle={() => toggleMemberExpanded(m.agentId)}
                  />
                ))}
              </View>
            )}

            {messages.length > 0 && (
              <View className="gap-1.5">
                <View className="flex-row items-center gap-1.5 px-1">
                  <MessageSquare className="text-muted-foreground/50" size={12} />
                  <Text className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                    Messages
                  </Text>
                </View>
                <View className="rounded-md border border-border/30 bg-muted/10 px-2 py-1 gap-0.5">
                  {messages.map((msg, i) => (
                    <TeamMessageRow key={i} msg={msg} />
                  ))}
                </View>
              </View>
            )}
          </View>
        )
      })}
    </ScrollView>
  )
}

// ---------------------------------------------------------------------------
// Registry Sub-tab
// ---------------------------------------------------------------------------

function AgentDetailView({ agent, onBack }: { agent: AgentTypeInfo; onBack: () => void }) {
  const [promptExpanded, setPromptExpanded] = useState(false)
  const toolNames = agent.toolNames ?? []
  const m = agent.metrics

  return (
    <ScrollView className="flex-1" contentContainerClassName="pb-8">
      {/* Header */}
      <View className="px-4 py-3 border-b border-border/30 gap-2">
        <Pressable onPress={onBack} className="flex-row items-center gap-1 -ml-1">
          <ChevronLeft className="text-primary" size={16} />
          <Text className="text-xs text-primary font-medium">Registry</Text>
        </Pressable>
        <View className="flex-row items-center gap-2">
          <Bot className="text-foreground" size={18} />
          <Text className="flex-1 text-sm font-bold text-foreground">{agent.name}</Text>
          {agent.builtin && (
            <Text className="text-[9px] text-muted-foreground font-mono px-1.5 py-0.5 rounded bg-muted/40">
              built-in
            </Text>
          )}
        </View>
        {agent.description && (
          <Text className="text-xs text-muted-foreground">{agent.description}</Text>
        )}
      </View>

      <View className="px-4 py-3 gap-4">
        {/* Metrics */}
        {m && m.totalRuns > 0 && (
          <View className="gap-2">
            <Text className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
              Stats
            </Text>
            <View className="flex-row gap-2">
              <View className="flex-1 rounded-md border border-border/30 bg-muted/10 px-2.5 py-2 items-center gap-1">
                <TrendingUp className="text-muted-foreground" size={12} />
                <Text className="text-sm font-bold text-foreground">{m.totalRuns}</Text>
                <Text className="text-[9px] text-muted-foreground">Runs</Text>
              </View>
              <View className="flex-1 rounded-md border border-border/30 bg-muted/10 px-2.5 py-2 items-center gap-1">
                <CheckCircle2 className="text-muted-foreground" size={12} />
                <Text className="text-sm font-bold text-foreground">{m.successes}</Text>
                <Text className="text-[9px] text-muted-foreground">Success</Text>
              </View>
              <View className="flex-1 rounded-md border border-border/30 bg-muted/10 px-2.5 py-2 items-center gap-1">
                <AlertTriangle className="text-muted-foreground" size={12} />
                <Text className="text-sm font-bold text-foreground">{m.failures}</Text>
                <Text className="text-[9px] text-muted-foreground">Failed</Text>
              </View>
              <View className="flex-1 rounded-md border border-border/30 bg-muted/10 px-2.5 py-2 items-center gap-1">
                <Wrench className="text-muted-foreground" size={12} />
                <Text className="text-sm font-bold text-foreground">{m.totalToolCalls}</Text>
                <Text className="text-[9px] text-muted-foreground">Tool calls</Text>
              </View>
            </View>
          </View>
        )}

        {/* Tools */}
        {toolNames.length > 0 && (
          <View className="gap-2">
            <View className="flex-row items-center gap-1.5">
              <Text className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                Tools
              </Text>
              <Text className="text-[10px] text-muted-foreground/50">{toolNames.length}</Text>
            </View>
            <View className="flex-row flex-wrap gap-1.5">
              {toolNames.map((tool) => (
                <Text
                  key={tool}
                  className="text-[10px] font-mono text-foreground bg-muted/40 border border-border/30 px-1.5 py-0.5 rounded"
                >
                  {tool}
                </Text>
              ))}
            </View>
          </View>
        )}

        {/* System Prompt */}
        {agent.systemPrompt && (
          <View className="gap-2">
            <Pressable
              onPress={() => setPromptExpanded(!promptExpanded)}
              className="flex-row items-center gap-1.5"
            >
              {promptExpanded ? (
                <ChevronDown className="text-muted-foreground/50" size={12} />
              ) : (
                <ChevronRight className="text-muted-foreground/50" size={12} />
              )}
              <Text className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                System Prompt
              </Text>
            </Pressable>
            {promptExpanded && (
              <View className="rounded-md border border-border/30 bg-muted/10 px-3 py-2">
                <Text className="text-[10px] font-mono text-muted-foreground leading-4">
                  {agent.systemPrompt}
                </Text>
              </View>
            )}
          </View>
        )}
      </View>
    </ScrollView>
  )
}

function RegistrySubTab() {
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)

  const teamVersion = useSyncExternalStore(
    teamStore.subscribe,
    () => teamStore.getVersion(),
    () => teamStore.getVersion(),
  )

  const types = useMemo(() => {
    const result: AgentTypeInfo[] = []
    for (const t of teamStore.getAgentTypes().values()) {
      result.push(t)
    }
    return result
  }, [teamVersion])

  const selected = selectedAgent
    ? types.find((t) => t.name === selectedAgent)
    : null

  if (selected) {
    return <AgentDetailView agent={selected} onBack={() => setSelectedAgent(null)} />
  }

  const hasCustom = types.some((t) => !t.builtin)

  return (
    <ScrollView className="flex-1" contentContainerClassName="px-4 py-3 gap-2 pb-8">
      {types.map((t) => (
        <Pressable
          key={t.name}
          onPress={() => setSelectedAgent(t.name)}
          className="rounded-lg border border-border/40 bg-muted/20 px-3 py-2.5 gap-1 active:bg-muted/40"
        >
          <View className="flex-row items-center gap-2">
            <Bot className="text-muted-foreground" size={14} />
            <Text className="flex-1 text-xs font-semibold text-foreground">{t.name}</Text>
            {t.builtin && (
              <Text className="text-[9px] text-muted-foreground font-mono px-1 py-0.5 rounded bg-muted/40">
                built-in
              </Text>
            )}
            <ChevronRight className="text-muted-foreground/40" size={14} />
          </View>
          {t.description && (
            <Text className="text-[10px] text-muted-foreground" numberOfLines={2}>
              {t.description}
            </Text>
          )}
          {t.toolNames && t.toolNames.length > 0 && (
            <View className="flex-row items-center gap-1 mt-0.5">
              <Wrench className="text-muted-foreground/40" size={10} />
              <Text className="text-[9px] text-muted-foreground/50">
                {t.toolNames.length} tool{t.toolNames.length !== 1 ? "s" : ""}
              </Text>
            </View>
          )}
        </Pressable>
      ))}

      {!hasCustom && (
        <View className="rounded-lg border border-dashed border-border/40 px-3 py-4 items-center gap-2 mt-2">
          <Zap className="text-muted-foreground/30" size={20} />
          <Text className="text-xs text-muted-foreground/60 text-center">
            Ask Shogo to create a custom agent for specialized tasks
          </Text>
        </View>
      )}
    </ScrollView>
  )
}

// ---------------------------------------------------------------------------
// Main AgentsPanel
// ---------------------------------------------------------------------------

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: "activity", label: "Activity" },
  { id: "tasks", label: "Tasks" },
  { id: "team", label: "Team" },
  { id: "registry", label: "Registry" },
]

export function AgentsPanel({ visible, selectedToolId, agentUrl }: AgentsPanelProps) {
  const [subTab, setSubTab] = useState<SubTab>("activity")
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [expandedMemberIds, setExpandedMemberIds] = useState<Set<string>>(new Set())

  useMemo(() => {
    if (selectedToolId && !expandedIds.has(selectedToolId)) {
      setExpandedIds((prev) => new Set(prev).add(selectedToolId))
    }
  }, [selectedToolId])

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleMemberExpanded = useCallback((id: string) => {
    setExpandedMemberIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  if (!visible) return null

  return (
    <View className="absolute inset-0 flex-col" style={{ display: visible ? "flex" : "none" }}>
      {/* Sub-tab toggle */}
      <View className="px-4 py-2 border-b border-border flex-row items-center gap-2">
        <View className="flex-row rounded-md border border-border" role="tablist">
          {SUB_TABS.map((tab) => (
            <Pressable
              key={tab.id}
              onPress={() => setSubTab(tab.id)}
              role="tab"
              accessibilityLabel={tab.label}
              accessibilityState={{ selected: subTab === tab.id }}
              className={cn(
                "px-3 py-1.5 rounded-md",
                subTab === tab.id ? "bg-primary" : "active:bg-muted",
              )}
            >
              <Text
                className={cn(
                  "text-xs font-medium",
                  subTab === tab.id ? "text-primary-foreground" : "text-muted-foreground",
                )}
              >
                {tab.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* Sub-tab content */}
      <View className="flex-1 relative">
        {subTab === "activity" && (
          <ActivitySubTab expandedIds={expandedIds} toggleExpanded={toggleExpanded} agentUrl={agentUrl} />
        )}
        {subTab === "tasks" && <TasksSubTab />}
        {subTab === "team" && (
          <TeamSubTab
            expandedMemberIds={expandedMemberIds}
            toggleMemberExpanded={toggleMemberExpanded}
          />
        )}
        {subTab === "registry" && <RegistrySubTab />}
      </View>
    </View>
  )
}
