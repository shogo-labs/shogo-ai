// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { UIMessage } from "@ai-sdk/react"
import type { PlanData } from "../chat/PlanCard"
import type { ProjectChatListItem } from "../../lib/project-chat-sessions"
import { islandSessionKey, type IslandSession } from "./types"

export type IslandSessionStatus = IslandSession["status"]

const STATUS_RANK: Record<IslandSessionStatus, number> = {
  needs_approval: 0,
  needs_answer: 0,
  running: 1,
  done: 2,
  idle: 3,
}

export function needsAttention(status: IslandSessionStatus): boolean {
  return status === "needs_approval" || status === "needs_answer"
}

/** Keep active sessions visible, plus the chat currently focused in Shogo. */
export function inboxSessions(sessions: readonly IslandSession[], focusedSessionKey?: string): IslandSession[] {
  return sessions.filter(
    (session) =>
      session.status !== "idle" || islandSessionKey(session.projectId, session.sessionId) === focusedSessionKey,
  )
}

/** Needs-you first, then running, then finished, each most recent first. */
export function orderIslandSessions<T extends Pick<IslandSession, "status" | "lastActivityAt">>(
  sessions: readonly T[],
): T[] {
  return [...sessions].sort(
    (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0),
  )
}

export interface IslandSessionRow {
  sessionId: string
  title: string
  status: IslandSessionStatus
  activity: number
  step?: string
  replyPreview?: string
  /** Open in a Shogo window right now. */
  live: boolean
}

/** API sessions for one project merged with live status from the snapshot.
 * Live sessions the API hasn't returned yet (a chat created seconds ago)
 * are kept. */
export function mergeSessionRows(
  projectId: string,
  apiSessions: readonly ProjectChatListItem[],
  liveSessions: readonly IslandSession[],
  label: (session: ProjectChatListItem) => string,
): IslandSessionRow[] {
  const live = new Map(liveSessions.filter((s) => s.projectId === projectId).map((s) => [s.sessionId, s]))
  const rows: IslandSessionRow[] = []
  for (const session of apiSessions) {
    if (session.isArchived) continue
    const snapshot = live.get(session.id)
    live.delete(session.id)
    rows.push({
      sessionId: session.id,
      title: snapshot?.title && snapshot.title !== "Untitled chat" ? snapshot.title : label(session),
      status: snapshot?.status ?? "idle",
      activity: Math.max(session.activity, snapshot?.lastActivityAt ?? 0),
      ...(snapshot?.step ? { step: snapshot.step } : {}),
      ...(snapshot?.replyPreview ? { replyPreview: snapshot.replyPreview } : {}),
      live: !!snapshot,
    })
  }
  for (const snapshot of live.values()) {
    rows.push({
      sessionId: snapshot.sessionId,
      title: snapshot.title,
      status: snapshot.status,
      activity: snapshot.lastActivityAt ?? 0,
      ...(snapshot.step ? { step: snapshot.step } : {}),
      ...(snapshot.replyPreview ? { replyPreview: snapshot.replyPreview } : {}),
      live: true,
    })
  }
  return rows.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.activity - a.activity)
}

export interface IslandProjectItem {
  id: string
  name: string
  thumbnailUrl?: string
  lastMessageAt?: number
  updatedAt?: number
}

function toMillis(value: unknown): number {
  if (typeof value === "number") return value
  if (value instanceof Date) return value.getTime()
  if (typeof value === "string") return new Date(value).getTime() || 0
  return 0
}

export function projectActivity(project: IslandProjectItem): number {
  return Math.max(toMillis(project.lastMessageAt), toMillis(project.updatedAt))
}

/** Projects with live sessions first, then most recently active; `query`
 * filters by name, case-insensitively. */
export function sortIslandProjects<T extends IslandProjectItem>(
  projects: readonly T[],
  liveSessions: readonly IslandSession[],
  query = "",
): T[] {
  const liveRank = new Map<string, number>()
  for (const session of liveSessions) {
    const rank = STATUS_RANK[session.status]
    liveRank.set(session.projectId, Math.min(rank, liveRank.get(session.projectId) ?? rank))
  }
  const needle = query.trim().toLowerCase()
  return projects
    .filter((project) => !needle || project.name.toLowerCase().includes(needle))
    .sort((a, b) => {
      const rankA = liveRank.get(a.id) ?? Number.POSITIVE_INFINITY
      const rankB = liveRank.get(b.id) ?? Number.POSITIVE_INFINITY
      if (rankA !== rankB) return rankA - rankB
      return projectActivity(b) - projectActivity(a)
    })
}

const PLAN_TOOLS = new Set(["create_plan", "update_plan"])

/** The plan awaiting Build in the last assistant message, if any. Mirrors
 * ChatPanel's restore-on-load logic so owned island sessions see the same
 * plan the chat panel would. */
export function derivePendingPlan(messages: readonly UIMessage[]): PlanData | null {
  const last = messages[messages.length - 1]
  if (!last || last.role !== "assistant") return null
  const parts = (last.parts ?? []) as any[]
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]
    const isLegacy =
      part.type === "tool-invocation" &&
      PLAN_TOOLS.has(part.toolInvocation?.toolName) &&
      part.toolInvocation?.state === "result"
    const isDynamic =
      part.type === "dynamic-tool" &&
      PLAN_TOOLS.has(part.toolName) &&
      (part.state === "output-available" || part.state === "result")
    if (!isLegacy && !isDynamic) continue
    const args = isLegacy ? part.toolInvocation?.args : (part.input ?? part.args)
    if (!args || typeof args !== "object") return null
    const plan = typeof args.plan === "string" ? args.plan : ""
    const overview = typeof args.overview === "string" ? args.overview : ""
    if (!plan && !overview) return null
    return {
      name: typeof args.name === "string" && args.name ? args.name : "Plan",
      overview,
      plan,
      todos: Array.isArray(args.todos) ? args.todos : [],
      filepath: typeof args.filepath === "string" ? args.filepath : undefined,
      toolCallId: part.toolCallId ?? part.toolInvocation?.toolCallId,
      isUpdate: (isLegacy ? part.toolInvocation?.toolName : part.toolName) === "update_plan",
    }
  }
  return null
}
