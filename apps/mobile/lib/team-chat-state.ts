// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure state helpers for team chat: timelines (a channel or one thread),
 * the conversation list's unread badges, and mention encoding for the
 * composer / display.
 */
import type { ChatMessage, ConversationSummary, Mentionables, TeamChatEvent } from './team-chat-api'

// ─── Timeline ────────────────────────────────────────────────────────────────

export interface TimelineScope {
  conversationId: string
  /** null = the channel view; otherwise the root id of the open thread. */
  threadRootId: string | null
}

export interface TimelineState {
  messages: ChatMessage[]
  hasMoreOlder: boolean
  /** Live text for agent replies that are still running, by message id. */
  streaming: Record<string, { text: string; tool: string | null }>
}

export const emptyTimeline: TimelineState = { messages: [], hasMoreOlder: false, streaming: {} }

export function belongsToScope(message: ChatMessage, scope: TimelineScope): boolean {
  if (message.conversationId !== scope.conversationId) return false
  if (scope.threadRootId) return message.id === scope.threadRootId || message.threadRootId === scope.threadRootId
  return !message.threadRootId || message.alsoSentToChannel
}

function sortMessages(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort((a, b) => {
    if (a.pending && !b.pending) return 1
    if (!a.pending && b.pending) return -1
    return a.seq - b.seq
  })
}

/** Insert or replace by id, and drop an optimistic twin with the same clientMsgId. */
export function upsertMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (!incoming.length) return existing
  const byId = new Map(existing.map((m) => [m.id, m]))
  const clientIds = new Set(incoming.map((m) => m.clientMsgId).filter(Boolean) as string[])
  for (const [id, m] of byId) {
    if (m.pending && m.clientMsgId && clientIds.has(m.clientMsgId)) byId.delete(id)
  }
  for (const m of incoming) byId.set(m.id, m)
  return sortMessages(Array.from(byId.values()))
}

export function mergePage(
  state: TimelineState,
  page: { messages: ChatMessage[]; hasMore: boolean; root?: ChatMessage },
  direction: 'initial' | 'older' | 'newer',
): TimelineState {
  const incoming = page.root ? [page.root, ...page.messages] : page.messages
  if (direction === 'initial') {
    const pending = state.messages.filter((m) => m.pending)
    return { ...state, messages: upsertMessages(pending, incoming), hasMoreOlder: page.hasMore }
  }
  return {
    ...state,
    messages: upsertMessages(state.messages, incoming),
    hasMoreOlder: direction === 'older' ? page.hasMore : state.hasMoreOlder,
  }
}

export function applyTimelineEvent(state: TimelineState, event: TeamChatEvent, scope: TimelineScope): TimelineState {
  switch (event.type) {
    case 'message.created':
    case 'message.updated': {
      const message = event.message
      const inScope = belongsToScope(message, scope)
      const known = state.messages.some((m) => m.id === message.id)
      let messages = state.messages
      if (event.type === 'message.created' && !known && message.threadRootId) {
        messages = messages.map((m) =>
          m.id === message.threadRootId ? { ...m, replyCount: m.replyCount + 1, lastReplyAt: message.createdAt } : m,
        )
      }
      if (!inScope && !known) return messages === state.messages ? state : { ...state, messages }
      const streaming = { ...state.streaming }
      if (message.agentStatus !== 'running') delete streaming[message.id]
      return { ...state, messages: upsertMessages(messages, [message]), streaming }
    }
    case 'reaction.changed': {
      if (!state.messages.some((m) => m.id === event.messageId)) return state
      return {
        ...state,
        messages: state.messages.map((m) => (m.id === event.messageId ? { ...m, reactions: event.reactions } : m)),
      }
    }
    case 'agent.delta': {
      if (!state.messages.some((m) => m.id === event.messageId)) return state
      return { ...state, streaming: { ...state.streaming, [event.messageId]: { text: event.text, tool: event.tool } } }
    }
    default:
      return state
  }
}

export function addOptimistic(state: TimelineState, message: ChatMessage): TimelineState {
  return { ...state, messages: sortMessages([...state.messages, { ...message, pending: 'sending' }]) }
}

export function failOptimistic(state: TimelineState, clientMsgId: string): TimelineState {
  return {
    ...state,
    messages: state.messages.map((m) => (m.pending && m.clientMsgId === clientMsgId ? { ...m, pending: 'failed' } : m)),
  }
}

export function removeOptimistic(state: TimelineState, clientMsgId: string): TimelineState {
  return { ...state, messages: state.messages.filter((m) => !(m.pending && m.clientMsgId === clientMsgId)) }
}

export function lastConfirmedSeq(state: TimelineState): number {
  let max = 0
  for (const m of state.messages) if (!m.pending && m.seq > max) max = m.seq
  return max
}

/** Show the author/avatar header only when the author or a 5-minute gap changes. */
export function startsGroup(prev: ChatMessage | undefined, message: ChatMessage): boolean {
  if (!prev) return true
  if (prev.authorType !== message.authorType) return true
  if (message.authorType === 'agent' || message.authorType === 'system') return true
  if (prev.authorUserId !== message.authorUserId) return true
  if (prev.replyCount > 0) return true
  return new Date(message.createdAt).getTime() - new Date(prev.createdAt).getTime() > 5 * 60_000
}

// ─── Conversation list ───────────────────────────────────────────────────────

export interface ListUpdate {
  list: ConversationSummary[]
  /** The event changed membership or metadata; refetch to get the full picture. */
  refetch: boolean
}

export function applyListEvent(
  list: ConversationSummary[],
  event: TeamChatEvent,
  me: string,
  activeConversationId: string | null,
): ListUpdate {
  switch (event.type) {
    case 'message.created': {
      const message = event.message
      const idx = list.findIndex((c) => c.id === message.conversationId)
      if (idx < 0) return { list, refetch: message.authorUserId !== me }
      const c = list[idx]
      const mine = message.authorUserId === me
      const viewing = activeConversationId === c.id
      const mentioned = !mine && message.text.includes(`<@u:${me}>`)
      const caughtUp = mine || viewing
      const visibleInChannel = !message.threadRootId || message.alsoSentToChannel
      const next: ConversationSummary = {
        ...c,
        lastSeq: Math.max(c.lastSeq, message.seq),
        lastMessageAt: visibleInChannel ? message.createdAt : c.lastMessageAt,
        lastReadSeq: caughtUp ? Math.max(c.lastReadSeq, message.seq) : c.lastReadSeq,
        unreadCount: caughtUp ? 0 : c.joined && visibleInChannel ? c.unreadCount + 1 : c.unreadCount,
        mentionCount: caughtUp ? 0 : mentioned ? c.mentionCount + 1 : c.mentionCount,
      }
      const copy = [...list]
      copy[idx] = next
      return { list: copy, refetch: false }
    }
    case 'read': {
      if (event.userId !== me) return { list, refetch: false }
      return {
        list: list.map((c) => {
          if (c.id !== event.conversationId) return c
          return { ...c, lastReadSeq: Math.max(c.lastReadSeq, event.seq), unreadCount: 0, mentionCount: 0 }
        }),
        refetch: false,
      }
    }
    case 'conversation.created':
    case 'conversation.updated':
    case 'member.joined':
    case 'member.left':
      return { list, refetch: true }
    default:
      return { list, refetch: false }
  }
}

export interface SidebarGroups {
  starred: ConversationSummary[]
  channels: ConversationSummary[]
  directMessages: ConversationSummary[]
  agents: ConversationSummary[]
}

export function groupForSidebar(list: ConversationSummary[]): SidebarGroups {
  const groups: SidebarGroups = { starred: [], channels: [], directMessages: [], agents: [] }
  const byActivity = (a: ConversationSummary, b: ConversationSummary) =>
    (b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0) - (a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0)
  for (const c of list) {
    if (c.archivedAt) continue
    if (c.starred) groups.starred.push(c)
    else if (c.kind === 'dm' && (c.participants ?? []).some((p) => p.type === 'agent')) groups.agents.push(c)
    else if (c.kind === 'dm' || c.kind === 'group_dm') groups.directMessages.push(c)
    else if (c.joined || c.kind === 'activity') groups.channels.push(c)
  }
  groups.channels.sort((a, b) => {
    if (a.kind === 'activity' && b.kind !== 'activity') return 1
    if (b.kind === 'activity' && a.kind !== 'activity') return -1
    return (a.name ?? '').localeCompare(b.name ?? '')
  })
  groups.directMessages.sort(byActivity)
  groups.agents.sort(byActivity)
  return groups
}

// ─── Mentions ────────────────────────────────────────────────────────────────

export interface MentionCandidate {
  kind: 'user' | 'agent' | 'special'
  display: string
  token: string
  subtitle?: string | null
}

export function mentionCandidates(mentionables: Mentionables | null, meId: string | null): MentionCandidate[] {
  if (!mentionables) return []
  const agents = mentionables.agents.map<MentionCandidate>((a) => ({
    kind: 'agent',
    display: a.name,
    token: a.projectId ? `<@a:p:${a.projectId}>` : '<@a:ws>',
    subtitle: a.projectId ? 'Project agent' : 'Workspace agent',
  }))
  const people = mentionables.people
    .filter((p) => p.id !== meId)
    .map<MentionCandidate>((p) => ({ kind: 'user', display: p.name, token: `<@u:${p.id}>`, subtitle: p.email }))
  const special: MentionCandidate[] = [
    { kind: 'special', display: 'here', token: '<!here>', subtitle: 'Notify everyone online' },
    { kind: 'special', display: 'channel', token: '<!channel>', subtitle: 'Notify everyone in this channel' },
  ]
  return [...agents, ...people, ...special]
}

/** The `@query` being typed at the cursor, if any. */
export function activeMentionQuery(text: string, cursor: number): { start: number; query: string } | null {
  const before = text.slice(0, cursor)
  const match = /(^|\s)@([^\s@]{0,40})$/.exec(before)
  if (!match) return null
  return { start: before.length - match[2].length - 1, query: match[2] }
}

export function filterCandidates(candidates: MentionCandidate[], query: string, limit = 8): MentionCandidate[] {
  const q = query.toLowerCase()
  if (!q) return candidates.slice(0, limit)
  const scored = candidates
    .map((c) => {
      const name = c.display.toLowerCase()
      const score = name.startsWith(q) ? 0 : name.split(/[\s._-]+/).some((w) => w.startsWith(q)) ? 1 : name.includes(q) ? 2 : -1
      return { c, score }
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score)
  return scored.slice(0, limit).map((x) => x.c)
}

/** Replace `@query` at the cursor with `@Display ` and return the new text/cursor. */
export function insertMention(text: string, at: { start: number; query: string }, candidate: MentionCandidate) {
  const insert = `@${candidate.display} `
  const next = text.slice(0, at.start) + insert + text.slice(at.start + 1 + at.query.length)
  return { text: next, cursor: at.start + insert.length }
}

/** Turn the `@Display` names the user picked back into wire tokens. */
export function encodeMentions(text: string, picked: MentionCandidate[]): string {
  const unique = Array.from(new Map(picked.map((p) => [p.display, p])).values()).sort(
    (a, b) => b.display.length - a.display.length,
  )
  let out = text
  for (const p of unique) {
    const escaped = p.display.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`(^|[\\s(])@${escaped}(?=$|[\\s.,!?:;)])`, 'g'), `$1${p.token}`)
  }
  return out
}

export interface MentionNames {
  users: Map<string, string>
  agents: Map<string, string>
  conversations?: Map<string, string>
}

export function mentionNames(mentionables: Mentionables | null): MentionNames {
  return {
    users: new Map((mentionables?.people ?? []).map((p) => [p.id, p.name])),
    agents: new Map((mentionables?.agents ?? []).map((a) => [a.key, a.name])),
  }
}

/** Render wire tokens as bold names for Markdown display. */
export function renderMentions(text: string, names: MentionNames): string {
  return text
    .replace(/<@u:([^>]+)>/g, (_m, id) => `**@${names.users.get(id) ?? 'someone'}**`)
    .replace(/<@a:(ws|p:[^>]+)>/g, (_m, key) => `**@${names.agents.get(key) ?? 'agent'}**`)
    .replace(/<!(here|channel)>/g, (_m, which) => `**@${which}**`)
    .replace(/<#c:([^>]+)>/g, (_m, id) => `**#${names.conversations?.get(id) ?? 'channel'}**`)
}

/** Plain-text preview for notifications/sidebars. */
export function plainPreview(text: string, names: MentionNames, max = 120): string {
  const flat = renderMentions(text, names).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
