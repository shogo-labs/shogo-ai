// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Inbox rows for the workspace agent: the API's recent chats with whatever
 * live status the snapshot has for them. Kept free of hooks and network so the
 * ordering can be tested on its own.
 */

import { isWorkspaceAgentProjectId } from "../../lib/desktop-island"
import { ISLAND_STATUS_RANK, type IslandSessionRow } from "./island-inbox"
import type { IslandSession } from "./types"

export const WORKSPACE_AGENT_CHAT_LIMIT = 8

export interface WorkspaceAgentChat {
  id: string
  title: string
  activity: number
}

export function workspaceAgentChatRows(
  chats: readonly WorkspaceAgentChat[],
  liveSessions: readonly IslandSession[],
  limit = WORKSPACE_AGENT_CHAT_LIMIT,
): IslandSessionRow[] {
  const live = new Map(
    liveSessions
      .filter((session) => isWorkspaceAgentProjectId(session.projectId))
      .map((session) => [session.sessionId, session]),
  )
  const rows: IslandSessionRow[] = []
  for (const chat of chats) {
    const snapshot = live.get(chat.id)
    live.delete(chat.id)
    rows.push({
      sessionId: chat.id,
      title: snapshot?.title && snapshot.title !== "Untitled chat" ? snapshot.title : chat.title,
      status: snapshot?.status ?? "idle",
      activity: Math.max(chat.activity, snapshot?.lastActivityAt ?? 0),
      ...(snapshot?.step ? { step: snapshot.step } : {}),
      ...(snapshot?.replyPreview ? { replyPreview: snapshot.replyPreview } : {}),
      live: !!snapshot,
    })
  }
  // A chat created seconds ago has a live snapshot before the API lists it.
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
  return rows
    .sort(
      (a, b) => ISLAND_STATUS_RANK[a.status] - ISLAND_STATUS_RANK[b.status] || b.activity - a.activity,
    )
    .slice(0, limit)
}
