// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reactive store for team coordination state.
 *
 * Accumulates SSE events (data-team-*, data-teammate-*, data-agent-types)
 * into in-memory Maps for the AgentsPanel to consume via useSyncExternalStore.
 * Hydrated on reload via data-team-snapshot events emitted at stream start.
 */

import type { MessagePart } from "../components/chat/turns/types"

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface MemberData {
  agentId: string
  teamId: string
  name: string
  color?: string
  status: "active" | "idle" | "shutdown"
  currentTaskId?: number
  joinedAt: number
  streamParts: MessagePart[]
}

export interface TaskData {
  id: number
  teamId: string
  subject: string
  description?: string
  status: "pending" | "in_progress" | "completed" | "deleted"
  owner?: string
  blockedBy: number[]
}

export interface MessageData {
  from: string
  to: string
  messageType: string
  message: string
  summary?: string
  timestamp: number
}

export interface TeamData {
  teamId: string
  name: string
  description?: string
  leaderId: string
  members: Map<string, MemberData>
  tasks: Map<number, TaskData>
  messages: MessageData[]
}

export interface AgentTypeMetrics {
  totalRuns: number
  successes: number
  failures: number
  totalToolCalls: number
}

export interface AgentTypeInfo {
  name: string
  builtin: boolean
  description?: string
  toolCount?: number
  toolNames?: string[]
  systemPrompt?: string
  metrics?: AgentTypeMetrics
}

export interface ActivityEvent {
  id: string
  timestamp: number
  type:
    | "team-created"
    | "team-deleted"
    | "member-joined"
    | "member-idle"
    | "member-wake"
    | "member-shutdown"
    | "turn-complete"
    | "task-created"
    | "task-updated"
    | "message-sent"
  teamId: string
  agentId?: string
  detail?: string
}

// ---------------------------------------------------------------------------
// Store internals
// ---------------------------------------------------------------------------

const BUILTIN_DEFAULTS: AgentTypeInfo[] = [
  { name: "explore", builtin: true, description: "Fast read-only codebase exploration agent" },
  { name: "general-purpose", builtin: true, description: "Full-capability subagent for complex multi-step tasks" },
]

function seedBuiltinDefaults(map: Map<string, AgentTypeInfo>) {
  for (const d of BUILTIN_DEFAULTS) {
    if (!map.has(d.name)) map.set(d.name, d)
  }
}

const teams = new Map<string, TeamData>()
const agentTypes = new Map<string, AgentTypeInfo>()
seedBuiltinDefaults(agentTypes)
const activityLog: ActivityEvent[] = []
const listeners = new Set<() => void>()
let version = 0

function notify() {
  version++
  listeners.forEach((fn) => fn())
}

function pushActivity(event: Omit<ActivityEvent, "id" | "timestamp">) {
  activityLog.push({
    ...event,
    id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const teamStore = {
  getVersion(): number {
    return version
  },

  // -- Teams ----------------------------------------------------------------

  getTeam(teamId: string): TeamData | undefined {
    return teams.get(teamId)
  },

  getAllTeams(): Map<string, TeamData> {
    return teams
  },

  initTeam(teamId: string, name: string, description?: string, leaderId?: string) {
    if (!teams.has(teamId)) {
      teams.set(teamId, {
        teamId,
        name,
        description,
        leaderId: leaderId ?? `team-lead@${teamId}`,
        members: new Map(),
        tasks: new Map(),
        messages: [],
      })
    }
    pushActivity({ type: "team-created", teamId, detail: name })
    notify()
  },

  deleteTeam(teamId: string) {
    teams.delete(teamId)
    pushActivity({ type: "team-deleted", teamId })
    notify()
  },

  // -- Members --------------------------------------------------------------

  upsertMember(teamId: string, member: Omit<MemberData, "streamParts"> & { streamParts?: MessagePart[] }) {
    const team = teams.get(teamId)
    if (!team) return
    const existing = team.members.get(member.agentId)
    team.members.set(member.agentId, {
      ...member,
      streamParts: existing?.streamParts ?? member.streamParts ?? [],
    })
    notify()
  },

  updateMemberStatus(agentId: string, teamId: string, status: MemberData["status"]) {
    const team = teams.get(teamId)
    if (!team) return
    const member = team.members.get(agentId)
    if (!member) return
    team.members.set(agentId, { ...member, status })

    const eventType = status === "idle"
      ? "member-idle" as const
      : status === "shutdown"
        ? "member-shutdown" as const
        : "member-wake" as const
    pushActivity({ type: eventType, teamId, agentId })
    notify()
  },

  appendMemberStreamPart(agentId: string, teamId: string, part: MessagePart) {
    const team = teams.get(teamId)
    if (!team) return
    const member = team.members.get(agentId)
    if (!member) return
    team.members.set(agentId, { ...member, streamParts: [...member.streamParts, part] })
    notify()
  },

  updateMemberStreamPart(agentId: string, teamId: string, partId: string, updater: (p: MessagePart) => MessagePart) {
    const team = teams.get(teamId)
    if (!team) return
    const member = team.members.get(agentId)
    if (!member) return
    const parts = member.streamParts.map((p) => (p.id === partId ? updater(p) : p))
    team.members.set(agentId, { ...member, streamParts: parts })
    notify()
  },

  // -- Tasks ----------------------------------------------------------------

  upsertTask(teamId: string, task: TaskData) {
    const team = teams.get(teamId)
    if (!team) return
    const isNew = !team.tasks.has(task.id)
    team.tasks.set(task.id, task)
    pushActivity({
      type: isNew ? "task-created" : "task-updated",
      teamId,
      detail: `${task.subject} → ${task.status}`,
    })
    notify()
  },

  // -- Messages -------------------------------------------------------------

  addMessage(teamId: string, msg: MessageData) {
    const team = teams.get(teamId)
    if (!team) return
    team.messages.push(msg)
    pushActivity({
      type: "message-sent",
      teamId,
      agentId: msg.from,
      detail: msg.summary || msg.message.slice(0, 60),
    })
    notify()
  },

  // -- Activity log ---------------------------------------------------------

  getActivity(): readonly ActivityEvent[] {
    return activityLog
  },

  // -- Agent types ----------------------------------------------------------

  getAgentTypes(): Map<string, AgentTypeInfo> {
    return agentTypes
  },

  setAgentTypes(types: AgentTypeInfo[]) {
    agentTypes.clear()
    for (const t of types) {
      agentTypes.set(t.name, t)
    }
    notify()
  },

  // -- Hydration ------------------------------------------------------------

  hydrate(data: {
    team: { id: string; name: string; description?: string; leaderAgentId: string }
    members: Array<{ agentId: string; teamId: string; name: string; color?: string; isActive: boolean; joinedAt: number }>
    tasks: Array<{ id: number; teamId: string; subject: string; description?: string; status: string; owner?: string; blockedBy: number[] }>
    messages: Array<{ fromAgent: string; toAgent: string; messageType: string; message: string; summary?: string; createdAt: number }>
  }) {
    const { team, members, tasks, messages } = data
    const teamData: TeamData = {
      teamId: team.id,
      name: team.name,
      description: team.description,
      leaderId: team.leaderAgentId,
      members: new Map(),
      tasks: new Map(),
      messages: [],
    }
    for (const m of members) {
      teamData.members.set(m.agentId, {
        agentId: m.agentId,
        teamId: m.teamId,
        name: m.name,
        color: m.color,
        status: m.isActive ? "active" : "idle",
        joinedAt: m.joinedAt,
        streamParts: [],
      })
    }
    for (const t of tasks) {
      teamData.tasks.set(t.id, {
        id: t.id,
        teamId: t.teamId,
        subject: t.subject,
        description: t.description,
        status: t.status as TaskData["status"],
        owner: t.owner,
        blockedBy: t.blockedBy ?? [],
      })
    }
    for (const m of messages) {
      teamData.messages.push({
        from: m.fromAgent,
        to: m.toAgent,
        messageType: m.messageType,
        message: m.message,
        summary: m.summary,
        timestamp: m.createdAt * 1000,
      })
    }
    teams.set(team.id, teamData)
    notify()
  },

  // -- Lifecycle ------------------------------------------------------------

  clear() {
    teams.clear()
    agentTypes.clear()
    seedBuiltinDefaults(agentTypes)
    activityLog.length = 0
    notify()
  },

  subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
}
