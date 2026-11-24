// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The menu-bar dropdown's model: which chats to list, in which section, and
 * which of them carry a dot.
 *
 * Pure on purpose. The desktop main process re-validates and re-derives the
 * count from the rows (apps/desktop/src/tray-protocol.ts), so anything wrong
 * here is a wrong dot, never a wrong click. Wire shapes mirror that file.
 */

import { agentChatRoute } from './team-chat-nav'
import { sideChatLabel, type SideChatItem } from './side-chats'
import type { DesktopIslandSession } from './desktop-island'

export type TrayRowStatus = 'running' | 'needs_you' | 'new'

export interface TrayRow {
  sessionId: string
  projectId: string | null
  title: string
  status: TrayRowStatus | null
  /** In-app route that opens this chat (`agentChatRoute`, serialised). */
  path: string
}

export interface TrayGroup {
  title: string
  rows: TrayRow[]
}

export interface TrayModel {
  pinned: TrayRow[]
  groups: TrayGroup[]
  recent: TrayRow[]
  attentionCount: number
  canClear: boolean
}

/** A row of `GET /workspaces/:id/agent-chats/recent`. */
export interface TrayRecentChat {
  chatSessionId: string
  title: string
  projectId: string | null
  agentKey: string
  agentName: string | null
  lastActiveAt: string
  isPinned?: boolean
  running?: boolean
}

/** Sessions open in this window, as the island publishes them. */
export type TrayIslandSession = Pick<DesktopIslandSession, 'sessionId' | 'projectId' | 'title' | 'status'> &
  Partial<Pick<DesktopIslandSession, 'projectName'>>

export interface TrayModelInput {
  /** `useWorkspaceChats().sessions` — the person's workspace-agent chats. */
  workspaceChats: Array<SideChatItem & { id: string }>
  recentChats: TrayRecentChat[]
  islandSessions: TrayIslandSession[]
  /** Chat ids with a turn running right now (workspace chats). */
  streamingIds: string[]
  /** Chat ids with a reply the person has not opened (workspace chats). */
  completedIds: string[]
  /** Project chats with an unopened finished reply (the island's activity). */
  completedProjectSessionIds?: string[]
  /** The workspace agent's own name; "Shogo" until the profile loads. */
  workspaceAgentName?: string
  /** Wide window: which of the two project routes a row opens. */
  wide: boolean
}

export const EMPTY_TRAY_MODEL: TrayModel = {
  pinned: [],
  groups: [],
  recent: [],
  attentionCount: 0,
  canClear: false,
}

export const TRAY_MAX_GROUPS = 6
export const TRAY_MAX_ROWS_PER_GROUP = 5
export const TRAY_MAX_PINNED = 5
export const TRAY_MAX_RECENT = 5
export const TRAY_MAX_TITLE_CHARS = 80
export const TRAY_MAX_GROUP_TITLE_CHARS = 60
export const TRAY_MAX_ATTENTION_COUNT = 999

/** `/(app)/projects/<id>?chatSessionId=<id>` from the app's own route builder. */
export function trayRowPath(input: { projectId: string | null; sessionId: string; wide: boolean }): string {
  const route = agentChatRoute(input)
  const params: Record<string, string> = { ...route.params }
  const pathname = (route.pathname as string).replace(/\[(\w+)\]/g, (_match, key: string) => {
    const value = params[key] ?? ''
    delete params[key]
    return encodeURIComponent(value)
  })
  const query = new URLSearchParams(params).toString()
  return query ? `${pathname}?${query}` : pathname
}

function trimTitle(value: string | null | undefined, maxChars: number): string | null {
  const text = value?.trim()
  if (!text) return null
  return text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text
}

function activityOf(item: { lastActiveAt?: string | null; createdAt?: string | null }): number {
  const raw = item.lastActiveAt || item.createdAt
  const at = raw ? new Date(raw).getTime() : 0
  return Number.isFinite(at) ? at : 0
}

interface Draft {
  sessionId: string
  projectId: string | null
  title: string
  agentName: string
  lastActiveAt: number
  isPinned: boolean
}

function islandStatusOf(
  session: TrayIslandSession | undefined,
  isRunning: boolean,
  isNew: boolean,
): TrayRowStatus | null {
  // A chat waiting on a person outranks anything else it is doing.
  if (session?.status === 'needs_approval' || session?.status === 'needs_answer') return 'needs_you'
  if (session?.status === 'running' || isRunning) return 'running'
  if (isNew || session?.status === 'done') return 'new'
  return null
}

/**
 * Turns the app's three chat sources into the dropdown: pinned chats first,
 * then one section per agent for the chats that have something to say, and the
 * 5 newest whenever nothing does.
 */
export function buildTrayModel(input: TrayModelInput): TrayModel {
  const workspaceAgentName = trimTitle(input.workspaceAgentName, TRAY_MAX_GROUP_TITLE_CHARS) ?? 'Shogo'
  const streaming = new Set(input.streamingIds)
  const completed = new Set(input.completedIds)
  for (const id of input.completedProjectSessionIds ?? []) completed.add(id)
  const islandById = new Map<string, TrayIslandSession>()
  for (const session of input.islandSessions) {
    if (!session?.sessionId) continue
    islandById.set(session.sessionId, session)
  }
  const recentById = new Map<string, TrayRecentChat>()
  for (const chat of input.recentChats) recentById.set(chat.chatSessionId, chat)

  const drafts = new Map<string, Draft>()
  const upsert = (draft: Draft): void => {
    const existing = drafts.get(draft.sessionId)
    if (!existing) {
      drafts.set(draft.sessionId, draft)
      return
    }
    // The fuller of the two wins per field, so a chat known from one source
    // (a pin, a title, an agent name) keeps everything the other knows too.
    existing.title = existing.title || draft.title
    existing.projectId = existing.projectId ?? draft.projectId
    existing.agentName = existing.agentName || draft.agentName
    existing.lastActiveAt = Math.max(existing.lastActiveAt, draft.lastActiveAt)
    existing.isPinned = existing.isPinned || draft.isPinned
  }

  for (const chat of input.workspaceChats) {
    if (chat.isArchived === true) continue
    const recent = recentById.get(chat.id)
    const island = islandById.get(chat.id)
    upsert({
      sessionId: chat.id,
      projectId: null,
      title: trimTitle(island?.title, TRAY_MAX_TITLE_CHARS) ?? sideChatLabel(chat),
      agentName: workspaceAgentName,
      lastActiveAt: activityOf(chat),
      isPinned: chat.isPinned === true || recent?.isPinned === true,
    })
  }

  for (const chat of input.recentChats) {
    const island = islandById.get(chat.chatSessionId)
    const isWorkspaceChat = chat.projectId === null
    upsert({
      sessionId: chat.chatSessionId,
      projectId: chat.projectId,
      title:
        trimTitle(island?.title, TRAY_MAX_TITLE_CHARS) ??
        trimTitle(chat.title, TRAY_MAX_TITLE_CHARS) ??
        'Untitled chat',
      agentName: isWorkspaceChat
        ? workspaceAgentName
        : trimTitle(chat.agentName, TRAY_MAX_GROUP_TITLE_CHARS) ?? 'Project',
      lastActiveAt: new Date(chat.lastActiveAt).getTime() || 0,
      isPinned: chat.isPinned === true,
    })
  }

  // A chat open in this window but missing from both lists (a brand-new chat,
  // or a list that has not polled yet) still belongs in the menu.
  for (const session of islandById.values()) {
    const isWorkspaceChat = session.projectId === 'ws'
    upsert({
      sessionId: session.sessionId,
      projectId: isWorkspaceChat ? null : session.projectId,
      title: trimTitle(session.title, TRAY_MAX_TITLE_CHARS) ?? 'Untitled chat',
      agentName: isWorkspaceChat
        ? workspaceAgentName
        : trimTitle(session.projectName, TRAY_MAX_GROUP_TITLE_CHARS) ?? 'Project',
      lastActiveAt: 0,
      isPinned: false,
    })
  }

  const rowsById = new Map<string, TrayRow>()
  for (const draft of drafts.values()) {
    const recent = recentById.get(draft.sessionId)
    rowsById.set(draft.sessionId, {
      sessionId: draft.sessionId,
      projectId: draft.projectId,
      title: trimTitle(draft.title, TRAY_MAX_TITLE_CHARS) ?? 'Untitled chat',
      status: islandStatusOf(
        islandById.get(draft.sessionId),
        streaming.has(draft.sessionId) || recent?.running === true,
        completed.has(draft.sessionId),
      ),
      path: trayRowPath({ projectId: draft.projectId, sessionId: draft.sessionId, wide: input.wide }),
    })
  }

  const byActivity = [...drafts.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  const pinned: TrayRow[] = []
  for (const draft of byActivity) {
    if (!draft.isPinned) continue
    const row = rowsById.get(draft.sessionId)
    if (!row) continue
    pinned.push(row)
    if (pinned.length >= TRAY_MAX_PINNED) break
  }
  const pinnedIds = new Set(pinned.map((row) => row.sessionId))

  const byAgent = new Map<string, { title: string; drafts: Draft[]; lastActiveAt: number }>()
  for (const draft of byActivity) {
    if (pinnedIds.has(draft.sessionId)) continue
    const row = rowsById.get(draft.sessionId)
    if (!row || row.status === null) continue
    const key = draft.projectId ?? 'ws'
    const group = byAgent.get(key) ?? { title: draft.agentName, drafts: [], lastActiveAt: 0 }
    group.drafts.push(draft)
    group.lastActiveAt = Math.max(group.lastActiveAt, draft.lastActiveAt)
    byAgent.set(key, group)
  }

  const statusRank: Record<TrayRowStatus, number> = { needs_you: 0, running: 1, new: 2 }
  const groups: TrayGroup[] = [...byAgent.values()]
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, TRAY_MAX_GROUPS)
    .map((group) => ({
      title: trimTitle(group.title, TRAY_MAX_GROUP_TITLE_CHARS) ?? 'Chats',
      rows: group.drafts
        .sort((a, b) => {
          const rankA = statusRank[rowsById.get(a.sessionId)?.status ?? 'new']
          const rankB = statusRank[rowsById.get(b.sessionId)?.status ?? 'new']
          return rankA - rankB || b.lastActiveAt - a.lastActiveAt
        })
        .slice(0, TRAY_MAX_ROWS_PER_GROUP)
        .flatMap((draft) => {
          const row = rowsById.get(draft.sessionId)
          return row ? [row] : []
        }),
    }))

  // No dots anywhere -> the 5 newest, so the menu is never just actions.
  const recent: TrayRow[] =
    groups.length > 0
      ? []
      : byActivity
          .slice(0, TRAY_MAX_RECENT)
          .flatMap((draft) => {
            const row = rowsById.get(draft.sessionId)
            return row ? [{ ...row, status: null }] : []
          })

  const attention = new Set(
    [...pinned, ...groups.flatMap((group) => group.rows), ...recent]
      .filter((row) => row.status === 'needs_you' || row.status === 'new')
      .map((row) => row.sessionId),
  )

  return {
    pinned,
    groups,
    recent,
    attentionCount: Math.min(attention.size, TRAY_MAX_ATTENTION_COUNT),
    canClear: [...pinned, ...groups.flatMap((group) => group.rows), ...recent].some((row) => row.status === 'new'),
  }
}
