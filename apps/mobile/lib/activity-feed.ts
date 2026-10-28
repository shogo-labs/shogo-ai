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
import type { InboxItem, SentMessage } from './team-chat-api'

export type ActivityFilter = 'all' | 'dms' | 'mentions' | 'threads' | 'agents' | 'questions' | 'sent'

export const ACTIVITY_FILTERS: Array<{ id: ActivityFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'agents', label: 'Agents' },
  { id: 'questions', label: 'Questions' },
  { id: 'dms', label: 'DMs' },
  { id: 'mentions', label: 'Mentions' },
  { id: 'threads', label: 'Threads' },
  // Sent is a view of its own, not a slice of the inbound feed: everything in
  // it is outbound, so no other chip may show it and it shows nothing else.
  { id: 'sent', label: 'Sent' },
]

export type AgentRunState = 'running' | 'queued' | 'done' | 'failed'

export interface ActivityEntry {
  id: string
  source: 'inbox' | 'agent' | 'sent'
  /** The inbox kind, `message` for a sent message, or `task` / `chat` for agent work. */
  kind: InboxItem['kind'] | 'task' | 'chat' | 'message'
  title: string
  /** "Direct Message", "Thread in #eng", "Agent task in Billing". */
  context: string
  preview: string
  at: number
  unread: boolean
  private?: boolean
  inbox?: InboxItem
  sent?: SentMessage
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
  if (item.kind === 'question') return { context: `Question in ${where}`, private: isPrivate }
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

/**
 * One message the viewer sent. The title is the conversation it went to, so a
 * run of replies in the same channel reads as one place, and the context says
 * whether it was a thread reply.
 */
export function sentEntry(message: SentMessage): ActivityEntry {
  const c = message.conversation
  const where = c && c.kind !== 'dm' && c.kind !== 'group_dm'
    ? conversationLabel({ kind: 'channel', label: c.name ?? c.slug ?? 'channel' })
    : null
  const context = where ? (message.threadRootId ? `Thread in ${where}` : where) : 'Direct Message'
  return {
    id: `sent:${message.id}`,
    source: 'sent',
    kind: 'message',
    title: where ?? 'Direct Message',
    context,
    preview: message.text,
    at: time(message.createdAt),
    // Nothing outbound is unread, and nothing outbound counts toward the badge.
    unread: false,
    private: c?.kind === 'private',
    sent: message,
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

/**
 * Whether an entry belongs under a filter chip. "All" means what happened to
 * you, so the messages you sent stay out of it; "Sent" is the mirror image.
 */
export function matchesFilter(entry: ActivityEntry, filter: ActivityFilter): boolean {
  switch (filter) {
    case 'all':
      return entry.source !== 'sent'
    case 'dms':
      return entry.kind === 'dm'
    case 'mentions':
      return entry.kind === 'mention' || entry.kind === 'keyword'
    case 'threads':
      return entry.kind === 'thread'
    case 'agents':
      return entry.source === 'agent'
    case 'questions':
      return entry.kind === 'question'
    case 'sent':
      return entry.source === 'sent'
  }
}

export interface FeedInput {
  inbox: InboxItem[]
  tasks: AgentTask[]
  activeChats: ActiveChatTurn[]
  /** Your own messages, loaded only while the Sent view is open. */
  sent?: SentMessage[]
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

export function buildFeed({ inbox, tasks, activeChats, sent = [], filter = 'all', unreadOnly = false, now = Date.now() }: FeedInput): Feed {
  const all = [
    ...inbox.map(inboxEntry),
    ...tasks.map((t) => taskEntry(t, now)),
    ...activeChats.map(chatEntry),
    ...sent.map(sentEntry),
  ]
  const shown = all.filter((e) => matchesFilter(e, filter) && (!unreadOnly || e.unread))
  const isRunning = (e: ActivityEntry) => e.agent?.state === 'running' || e.agent?.state === 'queued'
  const byTime = (a: ActivityEntry, b: ActivityEntry) => b.at - a.at
  return {
    // Work in progress is a status, not an event, so it never sits among the
    // history. Unread-only hides it too: running work has nothing to read. Sent
    // is not mail either — what you sent is the whole list.
    running: unreadOnly || filter === 'sent' ? [] : shown.filter(isRunning).sort(byTime),
    entries: shown.filter((e) => !isRunning(e)).sort(byTime),
  }
}

/** Slack groups Activity by day; so do we. */
export type FeedSection = 'today' | 'yesterday' | 'earlier'

export const SECTION_LABEL: Record<FeedSection, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  earlier: 'Earlier',
}

export type FeedHeaderRow = { type: 'header'; key: string; section: FeedSection; label: string; count: number }
export type FeedRow = FeedHeaderRow | { type: 'entry'; key: string; entry: ActivityEntry }

const startOfDay = (at: number): number => {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Calendar days, not 24-hour blocks: 23:00 and 01:00 are different days. */
export function sectionFor(at: number, now = Date.now()): FeedSection {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return 'earlier'
}

/**
 * Turns the flat, newest-first list into header + entry rows. Each header
 * carries its section's count, so the reader can see what they are skipping.
 */
export function groupFeed(entries: ActivityEntry[], now = Date.now()): FeedRow[] {
  if (!entries.length) return []
  const sections = entries.map((entry) => sectionFor(entry.at, now))
  const counts = new Map<FeedSection, number>()
  for (const section of sections) counts.set(section, (counts.get(section) ?? 0) + 1)

  const rows: FeedRow[] = []
  let current: FeedSection | null = null
  entries.forEach((entry, i) => {
    const section = sections[i]
    if (section !== current) {
      current = section
      rows.push({
        type: 'header',
        key: `h:${section}`,
        section,
        label: SECTION_LABEL[section],
        count: counts.get(section) ?? 0,
      })
    }
    rows.push({ type: 'entry', key: `e:${entry.id}`, entry })
  })
  return rows
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
