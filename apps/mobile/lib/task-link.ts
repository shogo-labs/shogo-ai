// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Where a background task's work is happening. The runtime attaches one of
 * these to every task it reports, so pressing a dock row can open the agent's
 * thread (channel thread, card, project session) instead of an empty log.
 */

export type TaskLink =
  | { kind: "log"; path?: string }
  | { kind: "project_session"; projectId: string; chatSessionId?: string; name?: string }
  | { kind: "subagent"; projectId?: string; chatSessionId?: string; toolCallId: string }
  | { kind: "channel_thread"; workspaceId?: string; conversationId: string; threadRootId: string; title?: string }
  | {
      kind: "card"
      workspaceId?: string
      conversationId: string
      threadRootId: string
      itemId: string
      itemKey: string
      board: string
    }

/** What the runtime's output route answers with. */
export interface TaskOutputInfo {
  taskId: string
  source?: string
  title?: string
  status?: string
  outputFile?: string
  output: string
  link?: TaskLink | null
}

/** Keep only links the client can actually render. */
export function asTaskLink(value: unknown): TaskLink | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  const kind = typeof raw.kind === "string" ? raw.kind : ""
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined)
  if (kind === "log") return { kind: "log", path: s(raw.path) }
  if (kind === "project_session" && s(raw.projectId)) {
    return {
      kind: "project_session",
      projectId: s(raw.projectId)!,
      chatSessionId: s(raw.chatSessionId),
      name: s(raw.name),
    }
  }
  if (kind === "subagent" && s(raw.toolCallId)) {
    return {
      kind: "subagent",
      toolCallId: s(raw.toolCallId)!,
      projectId: s(raw.projectId),
      chatSessionId: s(raw.chatSessionId),
    }
  }
  if (kind === "channel_thread" && s(raw.conversationId) && s(raw.threadRootId)) {
    return {
      kind: "channel_thread",
      conversationId: s(raw.conversationId)!,
      threadRootId: s(raw.threadRootId)!,
      workspaceId: s(raw.workspaceId),
      title: s(raw.title),
    }
  }
  if (kind === "card" && s(raw.conversationId) && s(raw.threadRootId) && s(raw.itemId)) {
    return {
      kind: "card",
      conversationId: s(raw.conversationId)!,
      threadRootId: s(raw.threadRootId)!,
      itemId: s(raw.itemId)!,
      itemKey: s(raw.itemKey) ?? s(raw.itemId)!,
      board: s(raw.board) ?? "",
      workspaceId: s(raw.workspaceId),
    }
  }
  return null
}

/** True when the link opens another agent's thread rather than a log. */
export function linkOpensThread(link: TaskLink | null | undefined): boolean {
  return !!link && link.kind !== "log"
}

/** Short label for the pane header. */
export function linkLabel(link: TaskLink | null | undefined, fallback?: string): string {
  if (!link) return fallback ?? "Task"
  if (link.kind === "card") return link.itemKey ? `${link.itemKey}` : fallback ?? "Card"
  if (link.kind === "project_session") return link.name ?? fallback ?? "Project"
  if (link.kind === "channel_thread") return link.title ?? fallback ?? "Thread"
  if (link.kind === "subagent") return fallback ?? "Sub-agent"
  return fallback ?? "Log"
}
