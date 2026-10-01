// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Activity feed: what people did (the team chat inbox) and what agents are
 * doing (tasks and running chats), as one list in one order.
 *
 * Everything here is pure. `useActivityFeed` feeds it, `ActivityFeed` renders
 * it.
 */
import type { ActiveChatTurn, AgentTask } from './api'
import { readableAgentTaskError, taskStatusLabel } from './agent-task-ui'
import { conversationLabel } from './team-chat-nav'
import type { InboxItem } from './team-chat-api'

export type ActivityFilter = 'all' | 'dms' | 'mentions' | 'threads' | 'agents'

export const ACTIVITY_FILTERS: Array<{ id: ActivityFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'dms', label: 'DMs' },
  { id: 'mentions', label: 'Mentions' },
  { id: 'threads', label: 'Threads' },
  { id: 'agents', label: 'Agents' },
]

export type AgentRunState = 'running' | 'queued' | 'done' | 'failed'

export interface ActivityEntry {
  id: string
  source: 'inbox' | 'agent'
  /** The inbox kind, or `task` / `chat` for agent work. */
  kind: InboxItem['kind'] | 'task' | 'chat'
  title: string
  /** "Direct Message", "Thread in #eng", "Agent task in Billing". */
  context: string
  preview: string
  at: number
  unread: boolean
  private?: boolean
  inbox?: InboxItem
  agent?: { state: AgentRunState; task?: AgentTask; chat?: ActiveChatTurn }
}

/** Tasks have no "seen" state yet, so only a recent failure asks for attention. */
export const RECENT_FAILURE_MS = 24 * 60 * 60 * 1000

const time = (value: string | null | undefined): number => {
  const parsed = Date.parse(value ?? '')
  return Number.isNaN(parsed) ? 0 : parsed
}

function inboxContext(item: InboxItem): { context: string; private: boolean } {
  const c = item.conversation
  const isPrivate = c?.kind === 'private'
  if (!c) return { context: item.kind === 'reminder' ? 'Reminder' : 'Message', private: false }
  const where = c.kind === 'dm' || c.kind === 'group_dm' ? null : conversationLabel({ kind: 'channel', label: c.name ?? c.slug ?? 'channel' })
  if (item.kind === 'thread') return { context: where ? `Thread in ${where}` : 'Thread', private: isPrivate }
  if (item.kind === 'dm' || !where) return { context: 'Direct Message', private: false }
  if (item.kind === 'mention' || item.kind === 'keyword') return { context: `Mention in ${where}`, private: isPrivate }
  if (item.kind === 'reaction') return { context: `Reaction in ${where}`, private: isPrivate }
  if (item.kind === 'reminder') return { context: 'Reminder', private: false }
  return { context: where, private: isPrivate }
}

export function inboxEntry(item: InboxItem): ActivityEntry {
  const { context, private: isPrivate } = inboxContext(item)
  return {
    id: `inbox:${item.id}`,
    source: 'inbox',
    kind: item.kind,
    title: item.title,
    context,
    preview: item.preview,
    at: time(item.createdAt),
    unread: !item.readAt,
    private: isPrivate,
    inbox: item,
  }
}

export function taskState(task: Pick<AgentTask, 'status'>): AgentRunState {
  if (task.status === 'running') return 'running'
  if (task.status === 'queued' || task.status === 'draft') return 'queued'
  if (task.status === 'failed' || task.status === 'cancelled') return 'failed'
  return 'done'
}

export function taskEntry(task: AgentTask, now = Date.now()): ActivityEntry {
  const state = taskState(task)
  const at = time(task.updatedAt || task.completedAt || task.startedAt || task.createdAt)
  const preview =
    state === 'failed'
      ? readableAgentTaskError(task.errorMessage, 'This task did not complete.')
      : state === 'done'
        ? task.resultSummary?.trim() || taskStatusLabel(task.status)
        : task.currentStep?.trim() || taskStatusLabel(task.status)
  return {
    id: `task:${task.id}`,
    source: 'agent',
    kind: 'task',
    title: task.title,
    context: `Agent task in ${task.projectName || 'Home'}`,
    preview,
    at,
    unread: state === 'failed' && now - at < RECENT_FAILURE_MS,
    agent: { state, task },
  }
}

export function chatEntry(chat: ActiveChatTurn): ActivityEntry {
  return {
    id: `chat:${chat.chatSessionId}:${chat.turnId}`,
    source: 'agent',
    kind: 'chat',
    title: chat.sessionName,
    context: chat.projectHidden ? 'Companion' : chat.projectName || 'Workspace chat',
    preview: 'An agent is responding in this chat.',
    at: time(chat.startedAt),
    unread: false,
    agent: { state: 'running', chat },
  }
}

/** Whether an entry belongs under a filter chip. "All" shows everything. */
export function matchesFilter(entry: ActivityEntry, filter: ActivityFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'dms':
      return entry.kind === 'dm'
    case 'mentions':
      return entry.kind === 'mention' || entry.kind === 'keyword'
    case 'threads':
      return entry.kind === 'thread'
    case 'agents':
      return entry.source === 'agent'
  }
}

export interface FeedInput {
  inbox: InboxItem[]
  tasks: AgentTask[]
  activeChats: ActiveChatTurn[]
  filter?: ActivityFilter
  unreadOnly?: boolean
  now?: number
}

export interface Feed {
  /** Agents working right now, shown in their own strip. */
  running: ActivityEntry[]
  /** Everything else, newest first. */
  entries: ActivityEntry[]
}

export function buildFeed({ inbox, tasks, activeChats, filter = 'all', unreadOnly = false, now = Date.now() }: FeedInput): Feed {
  const all = [...inbox.map(inboxEntry), ...tasks.map((t) => taskEntry(t, now)), ...activeChats.map(chatEntry)]
  const shown = all.filter((e) => matchesFilter(e, filter) && (!unreadOnly || e.unread))
  const isRunning = (e: ActivityEntry) => e.agent?.state === 'running' || e.agent?.state === 'queued'
  const byTime = (a: ActivityEntry, b: ActivityEntry) => b.at - a.at
  return {
    // Work in progress is a status, not an event, so it never sits among the
    // history. Unread-only hides it too: running work has nothing to read.
    running: unreadOnly ? [] : shown.filter(isRunning).sort(byTime),
    entries: shown.filter((e) => !isRunning(e)).sort(byTime),
  }
}

/** The Activity badge: unread inbox items plus agent work that recently failed. */
export function activityBadge(inboxUnread: number, tasks: AgentTask[], now = Date.now()): number {
  return inboxUnread + tasks.filter((t) => taskEntry(t, now).unread).length
}

/** "now", "5m", "3h", "2d" — short enough for a list row. */
export function relativeTime(at: number, now = Date.now()): string {
  if (!at) return ''
  const minutes = Math.max(0, Math.floor((now - at) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
