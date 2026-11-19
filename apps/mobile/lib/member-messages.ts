// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The `from` key a "Messages from <member>" pane is opened with (SHO-419):
 * `user:<userId>`, `agent:<projectId>`, or `agent:ws` for the workspace agent,
 * which has no project. The API parses the same three shapes, so the format
 * lives here once instead of in every entry point that opens the pane.
 */
import type { ConversationMember } from './team-chat-api'

export const WORKSPACE_AGENT_FROM = 'agent:ws'

export type MemberFrom =
  | { type: 'user'; userId: string }
  | { type: 'agent'; projectId: string | null }

/** The key for a channel member, person or agent. */
export function memberFromKey(member: ConversationMember): string {
  if (member.type === 'user') return `user:${member.userId}`
  return member.projectId ? `agent:${member.projectId}` : WORKSPACE_AGENT_FROM
}

/** The key for a person, by id — a profile pane knows the id, not the member row. */
export function userFromKey(userId: string): string {
  return `user:${userId}`
}

export function parseFromKey(key: string | null | undefined): MemberFrom | null {
  const value = (key ?? '').trim()
  if (value === WORKSPACE_AGENT_FROM) return { type: 'agent', projectId: null }
  if (value.startsWith('user:') && value.length > 'user:'.length) {
    return { type: 'user', userId: value.slice('user:'.length) }
  }
  if (value.startsWith('agent:') && value.length > 'agent:'.length) {
    return { type: 'agent', projectId: value.slice('agent:'.length) }
  }
  return null
}

/** The member a key names, when the channel still has them. */
export function memberForKey(members: ConversationMember[], key: string | null | undefined): ConversationMember | null {
  const parsed = parseFromKey(key)
  if (!parsed) return null
  return (
    members.find((m) =>
      parsed.type === 'user'
        ? m.type === 'user' && m.userId === parsed.userId
        : m.type === 'agent' && (m.projectId ?? null) === parsed.projectId,
    ) ?? null
  )
}

/** Whether a message was written by the member a key names. */
export function isFromMember(
  message: { authorType: string; authorUserId: string | null; authorAgent: { projectId: string | null } | null },
  key: string | null | undefined,
): boolean {
  const parsed = parseFromKey(key)
  if (!parsed) return false
  if (parsed.type === 'user') return message.authorType === 'user' && message.authorUserId === parsed.userId
  return message.authorType === 'agent' && (message.authorAgent?.projectId ?? null) === parsed.projectId
}
