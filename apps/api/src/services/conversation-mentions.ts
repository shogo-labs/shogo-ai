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

export interface AgentTarget {
  projectId: string | null
}

const TOKEN_RE = /<@u:([A-Za-z0-9_-]+)>|<@a:ws>|<@a:p:([A-Za-z0-9_-]+)>|<!(here|channel)>|<@g:([A-Za-z0-9_-]+)>/g
const ANY_TOKEN_RE = /<@u:([A-Za-z0-9_-]+)>|<@a:ws>|<@a:p:([A-Za-z0-9_-]+)>|<!(here|channel)>|<#c:([A-Za-z0-9_-]+)>|<@g:([A-Za-z0-9_-]+)>/g

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
    const [token, userId, projectId, broadcast, groupId] = match
    let mention: ParsedMention
    if (userId) mention = { targetType: 'user', userId }
    else if (groupId) mention = { targetType: 'group', groupId }
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
  workspaceAgentName?: string
}

/** Replace tokens with readable `@Name` / `#channel` text. */
export function renderMentionsAsText(text: string, names: MentionNames = {}): string {
  return text.replace(ANY_TOKEN_RE, (token, userId, projectId, broadcast, conversationId, groupId) => {
    if (userId) return `@${names.users?.get(userId) ?? 'someone'}`
    if (groupId) return `@${names.groups?.get(groupId) ?? 'group'}`
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
} {
  const userIds = new Set<string>()
  const projectIds = new Set<string>()
  const conversationIds = new Set<string>()
  const groupIds = new Set<string>()
  for (const text of texts) {
    for (const [, userId, projectId, , conversationId, groupId] of text.matchAll(ANY_TOKEN_RE)) {
      if (userId) userIds.add(userId)
      if (projectId) projectIds.add(projectId)
      if (conversationId) conversationIds.add(conversationId)
      if (groupId) groupIds.add(groupId)
    }
  }
  return { userIds: [...userIds], projectIds: [...projectIds], conversationIds: [...conversationIds], groupIds: [...groupIds] }
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

/** `@handle` names for group tokens, scoped to one workspace. */
export async function groupNames(db: any, workspaceId: string, groupIds: string[]): Promise<Map<string, string>> {
  if (!groupIds.length) return new Map()
  const rows = await db.userGroup.findMany({ where: { workspaceId, id: { in: groupIds } }, select: { id: true, handle: true } })
  return new Map(rows.map((g: any) => [g.id, g.handle]))
}
