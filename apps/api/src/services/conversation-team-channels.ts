// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Channels declared by an agent system (`teamChannels` in shogo-system.yaml):
 * a snapshot of every named channel with its members, and an idempotent
 * upsert that `system_apply` calls. People are only ever added, never removed
 * (they may have joined on their own); agent members are fully managed.
 */

import { prisma } from '../lib/prisma'
import { publishConversationEvent } from '../lib/conversation-bus'
import { conversationAudience, serializeConversation, slugify, DEFAULT_CHANNEL_SLUG } from './conversation.service'

const db = prisma as any

const TRIGGERS = new Set(['mention', 'all', 'keyword', 'auto'])
const CONTEXT_MODES = new Set(['shared', 'isolated'])

export interface TeamChannelAgent {
  projectId: string | null
  agentTrigger: string
  agentKeywords: string | null
  agentContextMode: string
}

export interface TeamChannelSnapshot {
  id: string
  name: string
  topic: string | null
  private: boolean
  agents: TeamChannelAgent[]
  userEmails: string[]
}

export interface TeamChannelState {
  channels: TeamChannelSnapshot[]
  /** Group handle → member emails, for membership diffs. */
  groups: Record<string, string[]>
}

export interface TeamChannelUpsert {
  name: string
  topic?: string | null
  private?: boolean
  agents?: Array<{ projectId: string | null; agentTrigger?: string; agentKeywords?: string | null; agentContextMode?: string }>
  removeAgentProjectIds?: Array<string | null>
  userEmails?: string[]
  groupHandles?: string[]
}

export class TeamChannelError extends Error {
  constructor(public status: 400 | 404, public code: string, message: string) {
    super(message)
  }
}

async function snapshot(conversation: any): Promise<TeamChannelSnapshot> {
  const members = await db.conversationMember.findMany({
    where: { conversationId: conversation.id },
    select: { memberType: true, projectId: true, agentTrigger: true, agentKeywords: true, agentContextMode: true, user: { select: { email: true } } },
  })
  return {
    id: conversation.id,
    name: conversation.slug ?? conversation.name,
    topic: conversation.topic ?? null,
    private: conversation.kind === 'private',
    agents: members
      .filter((m: any) => m.memberType === 'agent')
      .map((m: any) => ({ projectId: m.projectId ?? null, agentTrigger: m.agentTrigger ?? 'mention', agentKeywords: m.agentKeywords ?? null, agentContextMode: m.agentContextMode ?? 'shared' })),
    userEmails: members
      .filter((m: any) => m.memberType === 'user' && m.user?.email)
      .map((m: any) => m.user.email.toLowerCase()),
  }
}

export async function listTeamChannels(workspaceId: string): Promise<TeamChannelState> {
  const [conversations, groups] = await Promise.all([
    db.conversation.findMany({ where: { workspaceId, kind: { in: ['public', 'private'] }, archivedAt: null } }),
    db.userGroup.findMany({ where: { workspaceId }, select: { handle: true, members: { select: { userId: true } } } }),
  ])
  const userIds = [...new Set(groups.flatMap((g: any) => g.members.map((m: any) => m.userId)))]
  const users = userIds.length
    ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } })
    : []
  const emailById = new Map<string, string>(users.map((u: any) => [u.id, u.email.toLowerCase()]))
  return {
    channels: await Promise.all(conversations.map(snapshot)),
    groups: Object.fromEntries(groups.map((g: any) => [
      g.handle,
      g.members.map((m: any) => emailById.get(m.userId)).filter(Boolean),
    ])),
  }
}

async function workspaceUserIds(workspaceId: string, emails: string[], groupHandles: string[]): Promise<string[]> {
  const ids = new Set<string>()
  if (emails.length) {
    const members = await db.member.findMany({
      where: { workspaceId, user: { email: { in: emails.map((e) => e.toLowerCase()) } } },
      select: { userId: true },
    })
    for (const m of members) ids.add(m.userId)
  }
  if (groupHandles.length) {
    const rows = await db.userGroupMember.findMany({
      where: { group: { workspaceId, handle: { in: groupHandles } } },
      select: { userId: true },
    })
    const inWorkspace = await db.member.findMany({
      where: { workspaceId, userId: { in: rows.map((r: any) => r.userId) } },
      select: { userId: true },
    })
    for (const m of inWorkspace) ids.add(m.userId)
  }
  return [...ids]
}

/** Create or update one channel and its members. Returns what changed. */
export async function upsertTeamChannel(
  workspaceId: string,
  input: TeamChannelUpsert,
): Promise<{ channel: TeamChannelSnapshot; created: boolean; changes: string[] }> {
  const slug = slugify(input.name ?? '')
  if (!slug) throw new TeamChannelError(400, 'invalid_name', 'Channel name is required')
  const kind = input.private ? 'private' : 'public'
  const changes: string[] = []

  let conversation = await db.conversation.findFirst({ where: { workspaceId, slug, kind: { in: ['public', 'private'] } } })
  const created = !conversation
  if (!conversation) {
    conversation = await db.conversation.create({
      data: { workspaceId, kind, name: slug, slug, topic: input.topic?.trim() || null },
    })
    changes.push('created')
  } else {
    const data: Record<string, unknown> = {}
    if (conversation.archivedAt) data.archivedAt = null
    if (input.topic !== undefined && (input.topic?.trim() || null) !== conversation.topic) data.topic = input.topic?.trim() || null
    if (input.private !== undefined && kind !== conversation.kind && slug !== DEFAULT_CHANNEL_SLUG) data.kind = kind
    if (Object.keys(data).length) {
      conversation = await db.conversation.update({ where: { id: conversation.id }, data })
      changes.push(...Object.keys(data))
    }
  }

  const projectIds = [...new Set((input.agents ?? []).map((a) => a.projectId).filter((id): id is string => !!id))]
  if (projectIds.length) {
    const valid = await db.project.findMany({ where: { id: { in: projectIds }, workspaceId }, select: { id: true } })
    const ok = new Set(valid.map((p: any) => p.id))
    const bad = projectIds.filter((id) => !ok.has(id))
    if (bad.length) throw new TeamChannelError(400, 'invalid_agent', `Not projects in this workspace: ${bad.join(', ')}`)
  }

  for (const agent of input.agents ?? []) {
    const agentTrigger = TRIGGERS.has(agent.agentTrigger ?? '') ? agent.agentTrigger! : 'mention'
    const agentKeywords = agent.agentKeywords?.trim() || null
    const agentContextMode = CONTEXT_MODES.has(agent.agentContextMode ?? '') ? agent.agentContextMode! : 'shared'
    const existing = await db.conversationMember.findFirst({
      where: { conversationId: conversation.id, memberType: 'agent', projectId: agent.projectId ?? null },
    })
    if (!existing) {
      await db.conversationMember.create({
        data: { conversationId: conversation.id, memberType: 'agent', projectId: agent.projectId ?? null, agentTrigger, agentKeywords, agentContextMode },
      })
      changes.push(`agent+${agent.projectId ?? 'ws'}`)
    } else if (
      existing.agentTrigger !== agentTrigger ||
      (existing.agentKeywords ?? null) !== agentKeywords ||
      (existing.agentContextMode ?? 'shared') !== agentContextMode
    ) {
      await db.conversationMember.update({ where: { id: existing.id }, data: { agentTrigger, agentKeywords, agentContextMode } })
      changes.push(`agent~${agent.projectId ?? 'ws'}`)
    }
  }

  for (const projectId of input.removeAgentProjectIds ?? []) {
    const removed = await db.conversationMember.deleteMany({
      where: { conversationId: conversation.id, memberType: 'agent', projectId: projectId ?? null },
    })
    if (removed.count) changes.push(`agent-${projectId ?? 'ws'}`)
  }

  const userIds = await workspaceUserIds(workspaceId, input.userEmails ?? [], input.groupHandles ?? [])
  if (userIds.length) {
    const existing = await db.conversationMember.findMany({
      where: { conversationId: conversation.id, userId: { in: userIds } },
      select: { userId: true },
    })
    const have = new Set(existing.map((e: any) => e.userId))
    for (const userId of userIds) {
      if (have.has(userId)) continue
      await db.conversationMember.create({
        data: { conversationId: conversation.id, memberType: 'user', userId, lastReadSeq: conversation.lastSeq },
      })
      changes.push(`user+${userId}`)
    }
  }

  if (changes.length) {
    publishConversationEvent(workspaceId, {
      type: created ? 'conversation.created' : 'conversation.updated',
      conversationId: conversation.id,
      conversation: serializeConversation(conversation),
    } as any, await conversationAudience(conversation))
  }
  return { channel: await snapshot(conversation), created, changes }
}
