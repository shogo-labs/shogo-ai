// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The island's view stack. Opening the notch lands on a blank workspace-agent
 * chat; the inbox is a secondary view reached from the header, and projects
 * and project chats hang off it.
 */

import { isWorkspaceAgentId, type IslandFileRef, type IslandSession } from "./types"
import type { IslandInitialSend } from "./IslandChatHost"

export type IslandView =
  /** Blank workspace-agent chat: no session until the first send. */
  | { name: "agent" }
  | { name: "inbox" }
  | {
      name: "project"
      projectId: string
      projectName: string
      initialFiles?: IslandFileRef[]
    }
  | {
      name: "chat"
      projectId: string
      projectName: string
      sessionId: string
      title: string
      initialSend?: IslandInitialSend
      initialFiles?: IslandFileRef[]
    }
  | { name: "drop"; files: IslandFileRef[]; returnTo: IslandView }

/** The view the card shows when it opens, or undefined for today's inbox
 * behaviour when the workspace runtime is off. */
export function initialIslandView(workspaceAgentEnabled: boolean): IslandView {
  return workspaceAgentEnabled ? { name: "agent" } : { name: "inbox" }
}

/** True for a chat that belongs to the workspace agent rather than a project. */
export function isWorkspaceAgentChat(view: IslandView): boolean {
  return view.name === "chat" && isWorkspaceAgentId(view.projectId)
}

/** The chat a session is shown in. */
export function chatViewFor(session: IslandSession): IslandView {
  return {
    name: "chat",
    projectId: session.projectId,
    projectName: session.projectName,
    sessionId: session.sessionId,
    title: session.title,
  }
}

/** A session the user has to act on before it can continue. */
export function awaitingSession(sessions: readonly IslandSession[]): IslandSession | undefined {
  return (
    sessions.find((session) => session.pending) ??
    sessions.find((session) => session.status === "needs_approval" || session.status === "needs_answer")
  )
}

/**
 * The view a freshly opened card shows: the blank agent chat, unless something
 * is waiting on the user — then that session takes over the card, which is how
 * a permission raised while the notch was closed still gets seen.
 */
export function viewForOpen(
  workspaceAgentEnabled: boolean,
  sessions: readonly IslandSession[],
): IslandView {
  const awaiting = awaitingSession(sessions)
  return awaiting ? chatViewFor(awaiting) : initialIslandView(workspaceAgentEnabled)
}

/** Where Back goes from `view`; null means collapse the card. */
export function parentView(view: IslandView, workspaceAgentEnabled: boolean): IslandView | null {
  switch (view.name) {
    case "agent":
      return null
    case "inbox":
      return workspaceAgentEnabled ? { name: "agent" } : null
    case "drop":
      return view.returnTo
    case "project":
      return { name: "inbox" }
    case "chat":
      return isWorkspaceAgentChat(view)
        ? { name: "inbox" }
        : {
            name: "project",
            projectId: view.projectId,
            projectName: view.projectName,
          }
  }
}

/** Shown when the workspace agent has no profile name yet. */
export const DEFAULT_AGENT_NAME = "Shogo"
