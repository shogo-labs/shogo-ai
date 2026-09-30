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
 *
 * Clients render tokens as chips; the server resolves them to names when text
 * leaves the app (agent prompts, notifications, Slack).
 */

export type ParsedMention =
  | { targetType: 'user'; userId: string }
  | { targetType: 'agent'; projectId: string | null }
  | { targetType: 'here' }
  | { targetType: 'channel' }

export interface AgentTarget {
  projectId: string | null
}

const TOKEN_RE = /<@u:([A-Za-z0-9_-]+)>|<@a:ws>|<@a:p:([A-Za-z0-9_-]+)>|<!(here|channel)>/g
const ANY_TOKEN_RE = /<@u:([A-Za-z0-9_-]+)>|<@a:ws>|<@a:p:([A-Za-z0-9_-]+)>|<!(here|channel)>|<#c:([A-Za-z0-9_-]+)>/g

export function userMentionToken(userId: string): string {
  return `<@u:${userId}>`
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
    const [token, userId, projectId, broadcast] = match
    let mention: ParsedMention
    if (userId) mention = { targetType: 'user', userId }
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
  workspaceAgentName?: string
}

/** Replace tokens with readable `@Name` / `#channel` text. */
export function renderMentionsAsText(text: string, names: MentionNames = {}): string {
  return text.replace(ANY_TOKEN_RE, (token, userId, projectId, broadcast, conversationId) => {
    if (userId) return `@${names.users?.get(userId) ?? 'someone'}`
    if (projectId) return `@${names.projects?.get(projectId) ?? 'agent'}`
    if (broadcast) return `@${broadcast}`
    if (conversationId) return `#${names.conversations?.get(conversationId) ?? 'channel'}`
    if (token === '<@a:ws>') return `@${names.workspaceAgentName ?? 'Shogo'}`
    return token
  })
}

/** Ids referenced by tokens, for batch name lookups before rendering. */
export function collectMentionIds(texts: string[]): { userIds: string[]; projectIds: string[]; conversationIds: string[] } {
  const userIds = new Set<string>()
  const projectIds = new Set<string>()
  const conversationIds = new Set<string>()
  for (const text of texts) {
    for (const [, userId, projectId, , conversationId] of text.matchAll(ANY_TOKEN_RE)) {
      if (userId) userIds.add(userId)
      if (projectId) projectIds.add(projectId)
      if (conversationId) conversationIds.add(conversationId)
    }
  }
  return { userIds: [...userIds], projectIds: [...projectIds], conversationIds: [...conversationIds] }
}
