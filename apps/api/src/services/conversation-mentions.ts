// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Mention tokens embedded in channel message text.
 *
 *   <@u:USER_ID>       a person
 *   <@a:ws>            the workspace agent
 *   <@a:p:PROJECT_ID>  a project's agent
 *   <!here> <!channel> everyone active / everyone in the conversation
 *   <#c:CONVERSATION_ID> a channel reference
 *   <@g:GROUP_ID>      a user group (@team); expands to its members
 *   <@c:CHAT_ID>       another chat (the message is handed to it, SHO-52)
 *
 * Clients render tokens as chips; the server resolves them to names when text
 * leaves the app (agent prompts, notifications, Slack).
 */

export type ParsedMention =
  | { targetType: 'user'; userId: string }
  | { targetType: 'agent'; projectId: string | null }
  | { targetType: 'here' }
  | { targetType: 'channel' }
  | { targetType: 'group'; groupId: string }
  | { targetType: 'chat'; chatId: string }

export interface AgentTarget {
  projectId: string | null
}

const TOKEN_RE = /<@u:([A-Za-z0-9_-]+)>|<@a:ws>|<@a:p:([A-Za-z0-9_-]+)>|<!(here|channel)>|<@g:([A-Za-z0-9_-]+)>|<@c:([A-Za-z0-9_-]+)>/g
const ANY_TOKEN_RE = /<@u:([A-Za-z0-9_-]+)>|<@a:ws>|<@a:p:([A-Za-z0-9_-]+)>|<!(here|channel)>|<#c:([A-Za-z0-9_-]+)>|<@g:([A-Za-z0-9_-]+)>|<@c:([A-Za-z0-9_-]+)>/g

/** The `<@c:ID>` token that addresses another chat. */
export function chatMentionToken(chatSessionId: string): string {
  return `<@c:${chatSessionId}>`
}

/** Chat ids a message addresses, in first-seen order, deduped. */
export function mentionedChatIds(text: string): string[] {
  const ids: string[] = []
  for (const match of text.matchAll(ANY_TOKEN_RE)) {
    const chatId = match[6]
    if (chatId && !ids.includes(chatId)) ids.push(chatId)
  }
  return ids
}


export function userMentionToken(userId: string): string {
  return `<@u:${userId}>`
}

export function groupMentionToken(groupId: string): string {
  return `<@g:${groupId}>`
}

export function agentMentionToken(projectId: string | null): string {
  return projectId ? `<@a:p:${projectId}>` : '<@a:ws>'
}

export function agentKey(target: AgentTarget): string {
  return target.projectId ? `p:${target.projectId}` : 'ws'
}

export function parseMentions(text: string): ParsedMention[] {
  const seen = new Set<string>()
  const result: ParsedMention[] = []
  for (const match of text.matchAll(TOKEN_RE)) {
    const [token, userId, projectId, broadcast, groupId, chatId] = match
    let mention: ParsedMention
    if (userId) mention = { targetType: 'user', userId }
    else if (groupId) mention = { targetType: 'group', groupId }
    else if (chatId) mention = { targetType: 'chat', chatId }
    else if (projectId) mention = { targetType: 'agent', projectId }
    else if (broadcast === 'here' || broadcast === 'channel') mention = { targetType: broadcast }
    else if (token === '<@a:ws>') mention = { targetType: 'agent', projectId: null }
    else continue
    const key = token
    if (seen.has(key)) continue
    seen.add(key)
    result.push(mention)
  }
  return result
}

export function mentionedAgents(text: string): AgentTarget[] {
  return parseMentions(text)
    .filter((m): m is { targetType: 'agent'; projectId: string | null } => m.targetType === 'agent')
    .map((m) => ({ projectId: m.projectId }))
}

export interface MentionNames {
  users?: Map<string, string>
  projects?: Map<string, string>
  conversations?: Map<string, string>
  groups?: Map<string, string>
  chats?: Map<string, string>
  workspaceAgentName?: string
}

/** Replace tokens with readable `@Name` / `#channel` text. */
export function renderMentionsAsText(text: string, names: MentionNames = {}): string {
  return text.replace(ANY_TOKEN_RE, (token, userId, projectId, broadcast, conversationId, groupId, chatId) => {
    if (userId) return `@${names.users?.get(userId) ?? 'someone'}`
    if (groupId) return `@${names.groups?.get(groupId) ?? 'group'}`
    if (chatId) return `@${names.chats?.get(chatId) ?? 'chat'}`
    if (projectId) return `@${names.projects?.get(projectId) ?? 'agent'}`
    if (broadcast) return `@${broadcast}`
    if (conversationId) return `#${names.conversations?.get(conversationId) ?? 'channel'}`
    if (token === '<@a:ws>') return `@${names.workspaceAgentName ?? 'Shogo'}`
    return token
  })
}

/** Ids referenced by tokens, for batch name lookups before rendering. */
export function collectMentionIds(texts: string[]): {
  userIds: string[]
  projectIds: string[]
  conversationIds: string[]
  groupIds: string[]
  chatIds: string[]
} {
  const userIds = new Set<string>()
  const projectIds = new Set<string>()
  const conversationIds = new Set<string>()
  const groupIds = new Set<string>()
  const chatIds = new Set<string>()
  for (const text of texts) {
    for (const [, userId, projectId, , conversationId, groupId, chatId] of text.matchAll(ANY_TOKEN_RE)) {
      if (userId) userIds.add(userId)
      if (projectId) projectIds.add(projectId)
      if (conversationId) conversationIds.add(conversationId)
      if (groupId) groupIds.add(groupId)
      if (chatId) chatIds.add(chatId)
    }
  }
  return {
    userIds: [...userIds],
    projectIds: [...projectIds],
    conversationIds: [...conversationIds],
    groupIds: [...groupIds],
    chatIds: [...chatIds],
  }
}

export interface MentionDirectoryEntry {
  token: string
  /** Names this entry answers to after `@` (display name, email, handle…). */
  names: string[]
}

/** Lowercased name → token. Names claimed by more than one token are dropped. */
export function buildMentionLookup(entries: MentionDirectoryEntry[]): Map<string, string> {
  const claims = new Map<string, Set<string>>()
  for (const entry of entries) {
    for (const raw of entry.names) {
      const name = raw.trim().toLowerCase()
      if (!name) continue
      const tokens = claims.get(name) ?? new Set<string>()
      tokens.add(entry.token)
      claims.set(name, tokens)
    }
  }
  const lookup = new Map<string, string>()
  for (const [name, tokens] of claims) {
    if (tokens.size === 1) lookup.set(name, [...tokens][0])
  }
  return lookup
}

const CODE_RE = /```[\s\S]*?```|`[^`\n]*`/g
const NAME_CHAR_RE = /[\p{L}\p{N}_@-]/u

/**
 * Turn plain `@Name` / `@email` / `@handle` into mention tokens. Longest
 * unambiguous name wins; code spans and existing tokens are left alone.
 */
export function resolveFriendlyMentionsWith(text: string, lookup: Map<string, string>): string {
  if (!text.includes('@') || !lookup.size) return text
  const names = [...lookup.keys()].sort((a, b) => b.length - a.length)
  const resolveSegment = (segment: string): string => {
    let out = ''
    let i = 0
    while (i < segment.length) {
      const ch = segment[i]
      const prev = i > 0 ? segment[i - 1] : ''
      if (ch !== '@' || (prev && (NAME_CHAR_RE.test(prev) || prev === '<' || prev === '.'))) {
        out += ch
        i++
        continue
      }
      const rest = segment.slice(i + 1)
      const lower = rest.toLowerCase()
      const name = names.find((n) => lower.startsWith(n) && !NAME_CHAR_RE.test(rest.charAt(n.length)))
      if (!name) {
        out += ch
        i++
        continue
      }
      out += lookup.get(name)
      i += 1 + name.length
    }
    return out
  }
  let result = ''
  let last = 0
  for (const match of text.matchAll(CODE_RE)) {
    result += resolveSegment(text.slice(last, match.index)) + match[0]
    last = (match.index ?? 0) + match[0].length
  }
  return result + resolveSegment(text.slice(last))
}

const COLLAPSIBLE_TOKEN = '<(?:@[uagc]:[A-Za-z0-9_:-]+|@a:ws)>'
const REPEATED_TOKEN_RE = new RegExp(`(${COLLAPSIBLE_TOKEN})\\s*\\(\\s*\\1\\s*\\)`, 'g')
const TOKEN_THEN_NAME_RE = new RegExp(`(${COLLAPSIBLE_TOKEN})\\s*\\(([^()<>\\n]{1,80})\\)`, 'g')

/**
 * Agents read people as `Name (<@u:ID>)` and often write both back, which
 * renders the name twice: `<@u:ID> (<@u:ID>)` or `<@u:ID> (Name)` become one
 * mention. With a `lookup` (lowercased name → token), a name in parentheses
 * only goes when it is that same person.
 */
export function collapseRepeatedMentions(text: string, lookup?: Map<string, string>): string {
  let out = text.replace(REPEATED_TOKEN_RE, '$1')
  if (lookup?.size) {
    out = out.replace(TOKEN_THEN_NAME_RE, (whole, token: string, name: string) =>
      lookup.get(name.trim().replace(/^@/, '').toLowerCase()) === token ? token : whole)
  }
  return out
}

/** `@handle` names for group tokens, scoped to one workspace. */
export async function groupNames(db: any, workspaceId: string, groupIds: string[]): Promise<Map<string, string>> {
  if (!groupIds.length) return new Map()
  const rows = await db.userGroup.findMany({ where: { workspaceId, id: { in: groupIds } }, select: { id: true, handle: true } })
  return new Map(rows.map((g: any) => [g.id, g.handle]))
}

/**
 * Names for every token in `texts`, in one lookup per kind regardless of how
 * many texts are passed. Feed the result to `renderMentionsAsText`, or every
 * token renders as its fallback (`@someone`, `#channel`).
 *
 * `workspaceAgentName` is left to the caller: the agent is a workspace setting
 * rather than an id lookup, and callers already have their own way to read it.
 */
export async function loadNamesForTexts(db: any, workspaceId: string, texts: string[]): Promise<MentionNames> {
  const ids = collectMentionIds(texts)
  const [users, projects, conversations, groups, chats] = await Promise.all([
    ids.userIds.length ? db.user.findMany({ where: { id: { in: ids.userIds } }, select: { id: true, name: true, email: true } }) : [],
    ids.projectIds.length ? db.project.findMany({ where: { id: { in: ids.projectIds } }, select: { id: true, name: true } }) : [],
    ids.conversationIds.length ? db.conversation.findMany({ where: { id: { in: ids.conversationIds } }, select: { id: true, name: true } }) : [],
    groupNames(db, workspaceId, ids.groupIds),
    ids.chatIds.length ? db.chatSession.findMany({ where: { id: { in: ids.chatIds } }, select: { id: true, name: true, inferredName: true } }) : [],
  ])
  return {
    users: new Map<string, string>(users.map((u: any) => [u.id, u.name || u.email])),
    projects: new Map<string, string>(projects.map((p: any) => [p.id, p.name])),
    conversations: new Map<string, string>(conversations.map((c: any) => [c.id, c.name ?? 'channel'])),
    groups,
    chats: new Map<string, string>(chats.map((c: any) => [c.id, c.name?.trim() || c.inferredName || `chat ${String(c.id).slice(0, 8)}`])),
  }
}

/**
 * Preview markdown. Mirrors `flattenMarkdownBlocks`, `inlineMarkdownSegments`,
 * and `markdownToPlainText` in `apps/mobile/lib/team-chat-state.ts`. Direct
 * message rows keep inline markers; notifications strip them, because a push
 * notification can only show plain text.
 */
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

/** Drop block syntax and collapse to one line, keeping inline markers. */
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

/** Block syntax flattened, then inline markers removed. For push notifications. */
export function markdownToPlainText(text: string): string {
  return inlineMarkdownSegments(flattenMarkdownBlocks(text)).map((segment) => segment.text).join('').replace(/\s+/g, ' ').trim()
}
