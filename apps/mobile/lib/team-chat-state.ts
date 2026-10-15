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
  streaming: Record<string, { text: string; tool: string | null; tools?: Array<{ name: string; done: boolean }> }>
}

export const emptyTimeline: TimelineState = { messages: [], hasMoreOlder: false, streaming: {} }

export function belongsToScope(message: ChatMessage, scope: TimelineScope): boolean {
  if (message.conversationId !== scope.conversationId) return false
  if (scope.threadRootId) return message.id === scope.threadRootId || message.threadRootId === scope.threadRootId
  return !message.threadRootId || message.alsoSentToChannel
}

/**
 * The newest message seq that counts as "read" for the channel view, i.e. the
 * same rule `belongsToScope` uses to decide what renders in the main feed: a
 * thread reply only counts if it was also sent to the channel. Used to mark
 * the channel read while visible -- otherwise a thread reply that *is* on
 * screen in the channel never gets its seq marked read, and its badge can
 * never clear.
 */
export function newestReadableSeq(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (!m.pending && (!m.threadRootId || m.alsoSentToChannel)) return m.seq
  }
  return 0
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

/**
 * Drop the oldest confirmed messages so at most `keep` remain (pending sends
 * are always kept). Older history is reloaded on scroll via `hasMoreOlder`.
 */
export function trimToNewest(state: TimelineState, keep: number): TimelineState {
  const confirmed = state.messages.filter((m) => !m.pending)
  if (confirmed.length <= keep) return state
  const cutoff = confirmed[confirmed.length - keep]!.seq
  return { ...state, messages: state.messages.filter((m) => m.pending || m.seq >= cutoff), hasMoreOlder: true }
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
      return { ...state, streaming: { ...state.streaming, [event.messageId]: { text: event.text, tool: event.tool, tools: event.tools } } }
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

/**
 * Index of the first message in (afterSeq, upToSeq] that counts as unread
 * (someone else's, sent, not deleted); -1 if none.
 */
export function firstUnreadIndex(messages: ChatMessage[], afterSeq: number, me: string | null, upToSeq = Infinity): number {
  return messages.findIndex((m) => m.seq > afterSeq && m.seq <= upToSeq && !m.pending && !m.deletedAt && m.authorUserId !== me)
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
        lastMessage: visibleInChannel && (c.kind === 'dm' || c.kind === 'group_dm')
          ? { preview: inlinePreview(message.text, { users: new Map(), agents: new Map() }, 140), authorId: message.authorUserId, authorType: message.authorType, createdAt: message.createdAt }
          : c.lastMessage,
        lastReadSeq: caughtUp ? Math.max(c.lastReadSeq, message.seq) : c.lastReadSeq,
        unreadCount: caughtUp ? 0 : c.joined && visibleInChannel ? c.unreadCount + 1 : c.unreadCount,
        mentionCount: caughtUp ? 0 : mentioned ? c.mentionCount + 1 : c.mentionCount,
      }
      const copy = [...list]
      copy[idx] = next
      // A reply moved to the end was already counted when it started; the server knows the real count.
      if (event.moved && !caughtUp) copy[idx] = { ...next, unreadCount: c.unreadCount }
      return { list: copy, refetch: event.moved === true && !caughtUp }
    }
    case 'doc.updated': {
      const idx = list.findIndex((c) => c.id === event.conversationId)
      if (idx < 0 || list[idx].hasDoc) return { list, refetch: false }
      const copy = [...list]
      copy[idx] = { ...list[idx], hasDoc: true }
      return { list: copy, refetch: false }
    }
    case 'read': {
      if (event.userId !== me) return { list, refetch: false }
      return {
        list: list.map((c) => {
          if (c.id !== event.conversationId) return c
          if (event.unreadCount) return { ...c, lastReadSeq: event.seq, unreadCount: event.unreadCount }
          return { ...c, lastReadSeq: Math.max(c.lastReadSeq, event.seq), unreadCount: 0, mentionCount: 0 }
        }),
        refetch: false,
      }
    }
    case 'conversation.deleted':
      return { list: list.filter((c) => c.id !== event.conversationId), refetch: false }
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

/** Which conversation to move to from `currentId`, or null to stay. */
export function stepConversation(
  ordered: ConversationSummary[],
  currentId: string | null | undefined,
  direction: 1 | -1,
  unreadOnly: boolean,
): ConversationSummary | null {
  const n = ordered.length
  if (!n) return null
  const found = ordered.findIndex((c) => c.id === currentId)
  const base = found !== -1 ? found : direction === 1 ? -1 : n
  for (let i = 1; i <= n; i++) {
    const c = ordered[(((base + direction * i) % n) + n) % n]!
    if (c.id === currentId) continue
    if (!unreadOnly || (!c.muted && (c.unreadCount > 0 || c.mentionCount > 0))) return c
  }
  return null
}

// ─── Mentions ────────────────────────────────────────────────────────────────

export interface MentionCandidate {
  kind: 'user' | 'agent' | 'group' | 'special'
  display: string
  token: string
  subtitle?: string | null
  userId?: string
  /** For an agent: its project (null for the workspace agent). */
  projectId?: string | null
  /** For a user candidate, when the open conversation's membership is known: false if they are not in it. */
  inChannel?: boolean
}

/**
 * `channelMemberIds`, when given, marks each person candidate `inChannel`
 * so the composer can flag "Not in channel" and list members first —
 * only meaningful for a channel (public/private), so pass it only there.
 */
export function mentionCandidates(
  mentionables: Mentionables | null,
  meId: string | null,
  channelMemberIds?: Set<string> | null,
): MentionCandidate[] {
  if (!mentionables) return []
  const agents = mentionables.agents.map<MentionCandidate>((a) => ({
    kind: 'agent',
    display: a.name,
    token: a.projectId ? `<@a:p:${a.projectId}>` : '<@a:ws>',
    subtitle: a.projectId ? 'Project agent' : 'Workspace agent',
    projectId: a.projectId,
  }))
  const people = mentionables.people
    .filter((p) => p.id !== meId)
    .map<MentionCandidate>((p) => ({
      kind: 'user',
      display: p.name,
      token: `<@u:${p.id}>`,
      subtitle: p.email,
      userId: p.id,
      inChannel: channelMemberIds ? channelMemberIds.has(p.id) : undefined,
    }))
  const groups = (mentionables.groups ?? []).map<MentionCandidate>((g) => ({
    kind: 'group',
    display: g.handle,
    token: `<@g:${g.id}>`,
    subtitle: `${g.name} · ${g.memberIds.length} ${g.memberIds.length === 1 ? 'person' : 'people'}`,
  }))
  const special: MentionCandidate[] = [
    { kind: 'special', display: 'here', token: '<!here>', subtitle: 'Notify everyone online' },
    { kind: 'special', display: 'channel', token: '<!channel>', subtitle: 'Notify everyone in this channel' },
  ]
  return [...agents, ...people, ...groups, ...special]
}

/** The `@query` being typed at the cursor, if any. */
export function activeMentionQuery(text: string, cursor: number): { start: number; query: string } | null {
  const before = text.slice(0, cursor)
  const match = /(^|\s)@([^\s@]{0,40})$/.exec(before)
  if (!match) return null
  return { start: before.length - match[2].length - 1, query: match[2] }
}

/** Within equal relevance, a person not in the channel sorts after everyone else. */
function notInChannelRank(c: MentionCandidate): number {
  return c.inChannel === false ? 1 : 0
}

export function filterCandidates(candidates: MentionCandidate[], query: string, limit = 8): MentionCandidate[] {
  const q = query.toLowerCase()
  if (!q) return [...candidates].sort((a, b) => notInChannelRank(a) - notInChannelRank(b)).slice(0, limit)
  const scored = candidates
    .map((c) => {
      const name = c.display.toLowerCase()
      const score = name.startsWith(q) ? 0 : name.split(/[\s._-]+/).some((w) => w.startsWith(q)) ? 1 : name.includes(q) ? 2 : -1
      return { c, score }
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score || notInChannelRank(a.c) - notInChannelRank(b.c))
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
  groups?: Map<string, string>
}

export function mentionNames(mentionables: Mentionables | null): MentionNames {
  return {
    users: new Map((mentionables?.people ?? []).map((p) => [p.id, p.name])),
    agents: new Map((mentionables?.agents ?? []).map((a) => [a.key, a.name])),
    groups: new Map((mentionables?.groups ?? []).map((g) => [g.id, g.handle])),
  }
}

/** Render wire tokens as bold names for Markdown display. */
export function renderMentions(text: string, names: MentionNames): string {
  return text
    .replace(/<@u:([^>]+)>/g, (_m, id) => `**@${names.users.get(id) ?? 'someone'}**`)
    .replace(/<@a:(ws|p:[^>]+)>/g, (_m, key) => `**@${names.agents.get(key) ?? 'agent'}**`)
    .replace(/<!(here|channel)>/g, (_m, which) => `**@${which}**`)
    .replace(/<#c:([^>]+)>/g, (_m, id) => `**#${names.conversations?.get(id) ?? 'channel'}**`)
    .replace(/<@g:([^>]+)>/g, (_m, id) => `**@${names.groups?.get(id) ?? 'group'}**`)
}

/** Mention tokens as plain `@name` labels, leaving the message's own markdown alone. */
function renderMentionLabels(text: string, names: MentionNames): string {
  return text
    .replace(/<@u:([^>]+)>/g, (_m, id) => `@${names.users.get(id) ?? 'someone'}`)
    .replace(/<@a:(ws|p:[^>]+)>/g, (_m, key) => `@${names.agents.get(key) ?? 'agent'}`)
    .replace(/<!(here|channel)>/g, (_m, which) => `@${which}`)
    .replace(/<#c:([^>]+)>/g, (_m, id) => `#${names.conversations?.get(id) ?? 'channel'}`)
    .replace(/<@g:([^>]+)>/g, (_m, id) => `@${names.groups?.get(id) ?? 'group'}`)
}

export interface InlineSegment {
  text: string
  bold?: boolean
  italic?: boolean
  strike?: boolean
  code?: boolean
}

interface InlineStyle {
  bold?: boolean
  italic?: boolean
  strike?: boolean
  code?: boolean
}

/**
 * Drop block syntax and collapse to one line, keeping inline markers.
 * Mirrors `flattenMarkdownBlocks` in the API's `conversation-mentions`.
 */
export function flattenMarkdownBlocks(text: string): string {
  let source = text.replace(/\r\n/g, '\n')
  source = source.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code: string) => code.replace(/\n+$/, ''))
  source = source.replace(/~~~[^\n]*\n([\s\S]*?)~~~/g, (_m, code: string) => code.replace(/\n+$/, ''))
  source = source.replace(/^[ \t]*```[^\n]*$/gm, '')
  source = source.replace(/^[ \t]*~~~[^\n]*$/gm, '')
  source = source.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  const lines: string[] = []
  for (const raw of source.split('\n')) {
    let line = raw.trim()
    if (!line) continue
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) continue
    if (/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line)) continue
    while (/^#{1,6}\s+/.test(line)) line = line.replace(/^#{1,6}\s+/, '')
    while (/^>\s?/.test(line)) line = line.replace(/^>\s?/, '')
    line = line.replace(/^(?:[-*+]|\d+[.)])\s+/, '')
    const pipes = line.split('|').length - 1
    if (line.startsWith('|') || pipes >= 2) {
      line = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()).filter(Boolean).join(' ')
    }
    line = line.trim()
    if (line) lines.push(line)
  }
  return lines.join(' ').replace(/[ \t]+/g, ' ').trim()
}

function styleFlags(style: InlineStyle): InlineStyle {
  const out: InlineStyle = {}
  if (style.bold) out.bold = true
  if (style.italic) out.italic = true
  if (style.strike) out.strike = true
  if (style.code) out.code = true
  return out
}

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[\p{L}\p{N}_]/u.test(ch)
}

function markerAt(src: string, index: number): { token: string; style: InlineStyle } | null {
  const prev = src[index - 1]
  const rest = src.slice(index)
  const candidates: Array<{ token: string; style: InlineStyle; underscore: boolean }> = [
    { token: '***', style: { bold: true, italic: true }, underscore: false },
    { token: '___', style: { bold: true, italic: true }, underscore: true },
    { token: '**', style: { bold: true }, underscore: false },
    { token: '__', style: { bold: true }, underscore: true },
    { token: '~~', style: { strike: true }, underscore: false },
    { token: '*', style: { italic: true }, underscore: false },
    { token: '_', style: { italic: true }, underscore: true },
  ]
  for (const candidate of candidates) {
    if (!rest.startsWith(candidate.token)) continue
    const next = src[index + candidate.token.length]
    if (next === undefined || /\s/.test(next)) continue
    if ((candidate.token === '*' || candidate.token === '_') && next === candidate.token) continue
    if (candidate.underscore && (isWordChar(prev) || isWordChar(next))) continue
    return { token: candidate.token, style: candidate.style }
  }
  return null
}

function findClose(src: string, from: number, token: string): number {
  let index = from
  while (index < src.length) {
    const at = src.indexOf(token, index)
    if (at === -1) return -1
    const before = src[at - 1]
    if (before !== undefined && /\s/.test(before)) {
      index = at + token.length
      continue
    }
    if (token === '*' || token === '_') {
      if (src[at + 1] === token) {
        index = at + 2
        continue
      }
      if (token === '_' && isWordChar(src[at + 1])) {
        index = at + 1
        continue
      }
    }
    return at
  }
  return -1
}

function parseInline(src: string, style: InlineStyle, out: InlineSegment[]): void {
  let index = 0
  let plain = ''
  const flush = () => {
    if (!plain) return
    const flags = styleFlags(style)
    const last = out[out.length - 1]
    if (last && !last.code && !flags.code && last.bold === flags.bold && last.italic === flags.italic && last.strike === flags.strike) {
      last.text += plain
    } else {
      out.push({ text: plain, ...flags })
    }
    plain = ''
  }
  while (index < src.length) {
    if (src[index] === '\\' && index + 1 < src.length && /[*_~`\\[\]]/.test(src[index + 1]!)) {
      plain += src[index + 1]
      index += 2
      continue
    }
    if (src[index] === '`') {
      const close = src.indexOf('`', index + 1)
      if (close === -1) {
        index++
        continue
      }
      flush()
      const code = src.slice(index + 1, close)
      if (code) out.push({ text: code, code: true })
      index = close + 1
      continue
    }
    if (src[index] === '[') {
      const link = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(src.slice(index))
      if (link) {
        flush()
        parseInline(link[1]!, style, out)
        index += link[0].length
        continue
      }
      if (src.indexOf(']', index + 1) === -1) {
        index++
        continue
      }
    }
    const marker = markerAt(src, index)
    if (marker) {
      const close = findClose(src, index + marker.token.length, marker.token)
      if (close === -1) {
        index += marker.token.length
        continue
      }
      flush()
      parseInline(src.slice(index + marker.token.length, close), { ...style, ...marker.style }, out)
      index = close + marker.token.length
      continue
    }
    plain += src[index]
    index++
  }
  flush()
}

/** Inline formatting spans. An unclosed marker is dropped instead of shown. */
export function inlineMarkdownSegments(text: string): InlineSegment[] {
  const out: InlineSegment[] = []
  parseInline(text, {}, out)
  return out
}

/** Block syntax flattened, then inline markers removed. For plain-text surfaces. */
export function markdownToPlainText(text: string): string {
  return inlineMarkdownSegments(flattenMarkdownBlocks(text)).map((segment) => segment.text).join('').replace(/\s+/g, ' ').trim()
}

/** Plain-text preview for accessibility labels. */
export function plainPreview(text: string, names: MentionNames, max = 120): string {
  const flat = markdownToPlainText(renderMentions(text, names))
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * One-line preview that keeps inline markdown (`**bold**`, `code`) so the
 * DM row can render it. Block syntax is already gone. Matches the server's
 * `lastMessage.preview`, which slices rather than adding an ellipsis.
 */
export function inlinePreview(text: string, names: MentionNames, max = 140): string {
  const flat = flattenMarkdownBlocks(renderMentionLabels(text, names))
  return flat.length > max ? flat.slice(0, max) : flat
}

export interface HighlightSegment {
  text: string
  match: boolean
  bold?: boolean
  italic?: boolean
  strike?: boolean
  code?: boolean
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sliceSegments(segments: InlineSegment[], start: number, length: number): InlineSegment[] {
  const out: InlineSegment[] = []
  let pos = 0
  for (const segment of segments) {
    const segStart = pos
    const segEnd = pos + segment.text.length
    pos = segEnd
    if (segEnd <= start || segStart >= start + length) continue
    const from = Math.max(0, start - segStart)
    const to = Math.min(segment.text.length, start + length - segStart)
    const text = segment.text.slice(from, to)
    if (text) out.push({ ...segment, text })
  }
  return out
}

function windowSegments(segments: InlineSegment[], total: number, start: number, max: number): InlineSegment[] {
  const taken = sliceSegments(segments, start, max)
  if (start > 0) taken.unshift({ text: '…' })
  if (start + max < total) taken.push({ text: '…' })
  return taken
}

function asHighlight(segment: InlineSegment, match: boolean): HighlightSegment {
  const out: HighlightSegment = { text: segment.text, match }
  if (segment.bold) out.bold = true
  if (segment.italic) out.italic = true
  if (segment.strike) out.strike = true
  if (segment.code) out.code = true
  return out
}

function splitHighlights(segments: InlineSegment[], re: RegExp): HighlightSegment[] {
  const out: HighlightSegment[] = []
  for (const segment of segments) {
    re.lastIndex = 0
    let last = 0
    for (const match of segment.text.matchAll(re)) {
      const at = match.index ?? 0
      if (at > last) out.push(asHighlight({ ...segment, text: segment.text.slice(last, at) }, false))
      out.push(asHighlight({ ...segment, text: match[0] }, true))
      last = at + match[0].length
    }
    if (last < segment.text.length) out.push(asHighlight({ ...segment, text: segment.text.slice(last) }, false))
  }
  return out.length ? out : [{ text: '', match: false }]
}

/**
 * A search-result excerpt around the first matching term, split into
 * segments so matches can be emphasised. Inline markdown stays on the
 * segments. Terms match word prefixes, which approximates the server's
 * stemming ("ship" highlights "shipping").
 */
export function searchSnippet(text: string, terms: string[], names: MentionNames, max = 220): HighlightSegment[] {
  const segments = inlineMarkdownSegments(flattenMarkdownBlocks(renderMentions(text, names)))
  const flat = segments.map((segment) => segment.text).join('')
  if (!flat) return [{ text: '', match: false }]
  const words = terms.map((term) => term.trim()).filter(Boolean)
  if (!words.length) return splitHighlights(windowSegments(segments, flat.length, 0, max), /$^/g)
  const re = new RegExp(`\\b(${words.map(escapeRegExp).join('|')})\\w*`, 'gi')
  const first = flat.search(re)
  let start = 0
  if (first > max / 3) start = Math.max(0, flat.lastIndexOf(' ', first - Math.floor(max / 3)) + 1)
  return splitHighlights(windowSegments(segments, flat.length, start, max), re)
}

export type ClearAfter = number | 'today' | 'tomorrow' | null

/** When a status or DND choice ends: minutes from now, end of today, or 9am tomorrow. */
export function expiryFrom(choice: ClearAfter, now = new Date()): string | null {
  if (choice === null) return null
  if (choice === 'today') {
    const end = new Date(now)
    end.setHours(23, 59, 59, 0)
    return end.toISOString()
  }
  if (choice === 'tomorrow') {
    const t = new Date(now)
    t.setDate(t.getDate() + 1)
    t.setHours(9, 0, 0, 0)
    return t.toISOString()
  }
  return new Date(now.getTime() + choice * 60_000).toISOString()
}

/** Turn a stored draft's mention tokens back into `@Name` text plus the picks that re-encode it. */
export function decodeMentions(wire: string, candidates: MentionCandidate[]): { text: string; picked: MentionCandidate[] } {
  const byToken = new Map(candidates.map((c) => [c.token, c]))
  const picked: MentionCandidate[] = []
  const text = wire.replace(/<[@!][^>]+>/g, (token) => {
    const c = byToken.get(token)
    if (!c) return token
    picked.push(c)
    return `@${c.display}`
  })
  return { text, picked }
}

/** Quick "send later" choices, in local time. */
export function scheduleOptions(now = new Date()): Array<{ label: string; at: Date }> {
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)
  const monday = new Date(now)
  monday.setDate(monday.getDate() + (((8 - monday.getDay()) % 7) || 7))
  monday.setHours(9, 0, 0, 0)
  const options = [
    { label: 'In 30 minutes', at: new Date(now.getTime() + 30 * 60_000) },
    { label: 'In 1 hour', at: new Date(now.getTime() + 60 * 60_000) },
    { label: 'Tomorrow at 9:00 AM', at: tomorrow },
  ]
  if (monday.getTime() - tomorrow.getTime() > 86_400_000 / 2) options.push({ label: 'Monday at 9:00 AM', at: monday })
  return options
}

export function isRemindCommand(text: string): boolean {
  return /^\/remind\b/i.test(text.trim())
}
