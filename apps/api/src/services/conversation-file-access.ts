// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Who may see a conversation's files. Every file route (the Files list,
 * search, reading text, downloads) asks this module, for people and agents
 * alike, so the rules live in one place:
 *
 * - People: workspace members read public channels and #activity, plus any
 *   conversation they're a member of (private channels, DMs, group DMs).
 * - Agents: public channels and #activity, plus conversations where the agent
 *   is a member, never archived ones. An agent that reviews in isolation
 *   anywhere sees no files at all, like message search, since other channels
 *   may discuss the work it was kept out of.
 * - A file is visible only once it's attached to a message that still exists.
 *
 * Files the caller can't see are reported as not found, so ids can't be probed.
 */

import { prisma } from '../lib/prisma'
import { assertNativeChat } from './chat-mode'
import { ConversationError, getWorkspaceRole } from './conversation.service'

const db = prisma as any

export type FilePrincipal =
  | { kind: 'user'; userId: string }
  /** `projectId` null is the workspace agent. */
  | { kind: 'agent'; projectId: string | null }

/** Attachments that were sent with a message that hasn't been deleted. */
export const VISIBLE_FILE_WHERE = { messageId: { not: null }, message: { deletedAt: null } }

const OPEN_KINDS = ['public', 'activity']

export const fileNotFound = () => new ConversationError(404, 'not_found', 'File not found')

function conversationWhere(principal: FilePrincipal, workspaceId: string): Record<string, unknown> {
  if (principal.kind === 'user') {
    return { workspaceId, OR: [{ kind: { in: OPEN_KINDS } }, { members: { some: { memberType: 'user', userId: principal.userId } } }] }
  }
  const agent = { memberType: 'agent', projectId: principal.projectId }
  return { workspaceId, archivedAt: null, OR: [{ kind: { in: OPEN_KINDS } }, { members: { some: agent } }] }
}

async function isolatedAnywhere(principal: FilePrincipal): Promise<boolean> {
  if (principal.kind !== 'agent' || !principal.projectId) return false
  return !!(await db.conversationMember.findFirst({
    where: { memberType: 'agent', projectId: principal.projectId, agentContextMode: 'isolated' },
    select: { id: true },
  }))
}

/** Ids of every conversation in the workspace whose files the principal may see. */
export async function readableConversationIds(
  principal: FilePrincipal,
  workspaceId: string,
  opts: { conversationId?: string } = {},
): Promise<string[]> {
  if (principal.kind === 'user' && !(await getWorkspaceRole(workspaceId, principal.userId))) return []
  if (await isolatedAnywhere(principal)) return []
  const where = conversationWhere(principal, workspaceId)
  const rows = await db.conversation.findMany({
    where: opts.conversationId ? { AND: [where, { id: opts.conversationId }] } : where,
    select: { id: true },
  })
  return rows.map((r: any) => r.id)
}

export async function canReadConversationFiles(principal: FilePrincipal, conversation: { id: string; workspaceId: string }): Promise<boolean> {
  return (await readableConversationIds(principal, conversation.workspaceId, { conversationId: conversation.id })).length > 0
}

/**
 * The file and its conversation, or a 404 when it doesn't exist, isn't
 * visible yet, belongs to another workspace, or the principal can't read it.
 */
export async function loadVisibleFile(principal: FilePrincipal, workspaceId: string | null, fileId: string) {
  const attachment = await db.conversationAttachment.findFirst({
    where: { id: fileId, ...VISIBLE_FILE_WHERE },
    include: { conversation: true },
  })
  if (!attachment) throw fileNotFound()
  const conversation = attachment.conversation
  if (workspaceId && conversation.workspaceId !== workspaceId) throw fileNotFound()
  if (principal.kind === 'user') await assertNativeChat(conversation.workspaceId)
  if (!(await canReadConversationFiles(principal, conversation))) throw fileNotFound()
  return { attachment, conversation }
}
