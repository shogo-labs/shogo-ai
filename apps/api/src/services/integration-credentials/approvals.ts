// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The `approve` chain step.
 *
 * When a turn reaches `approve`, a card goes up where the turn is happening:
 * the thread a chat turn is replying in, or the channel an event trigger
 * reports to. Whoever approves becomes the person for that one call, and the
 * chain is walked again with them (their own account, or a link to connect
 * it). Without a place to post, the step is skipped.
 *
 * The runtime polls `redeemApproval` while it waits, so nothing holds a
 * request open and any API instance can answer. An approval hands out the
 * approver's credential once.
 */

import { prisma } from '../../lib/prisma'
import type { RequesterTicket } from '../../lib/requester-ticket'
import type { CredentialOp } from './types'

const db = prisma as any

/** Names the approval a repeated tool call spends. */
export const CREDENTIAL_APPROVAL_HEADER = 'X-Credential-Approval'

export const APPROVAL_TTL_MS = 10 * 60 * 1000

export type ApprovalState = 'pending' | 'approved' | 'denied' | 'expired' | 'used'

export interface ApprovalPlace {
  workspaceId: string
  conversationId: string
  threadRootId: string | null
  sessionId: string
  agentName: string
}

function parseRef(value: unknown): { name?: string } | null {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }
  return value && typeof value === 'object' ? (value as { name?: string }) : null
}

/** Where a card for this turn would be seen, or null when there's nowhere to post. */
export async function approvalPlaceFor(projectId: string, ticket: RequesterTicket | null): Promise<ApprovalPlace | null> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { name: true, workspaceId: true } })
  if (!project) return null
  const origin = ticket?.origin
  if (origin?.kind === 'chat' && origin.chatSessionId) {
    const reply = await db.conversationMessage.findFirst({
      where: { agentSessionId: origin.chatSessionId, authorType: 'agent', deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { conversationId: true, threadRootId: true, authorAgentRef: true },
    })
    if (!reply) return null
    const conversation = await db.conversation.findUnique({ where: { id: reply.conversationId }, select: { workspaceId: true } })
    if (!conversation || conversation.workspaceId !== project.workspaceId) return null
    return {
      workspaceId: conversation.workspaceId,
      conversationId: reply.conversationId,
      threadRootId: reply.threadRootId ?? null,
      sessionId: origin.chatSessionId,
      agentName: parseRef(reply.authorAgentRef)?.name || project.name || 'The agent',
    }
  }
  if (origin?.kind === 'event' && origin.subscriptionId) {
    const sub = await db.eventSubscription.findUnique({
      where: { id: origin.subscriptionId },
      select: { workspaceId: true, notifyConversationId: true, notifyThreadRootId: true },
    })
    if (!sub?.notifyConversationId || sub.workspaceId !== project.workspaceId) return null
    return {
      workspaceId: sub.workspaceId,
      conversationId: sub.notifyConversationId,
      threadRootId: sub.notifyThreadRootId ?? null,
      sessionId: `event:${origin.subscriptionId}`,
      agentName: project.name || 'The agent',
    }
  }
  return null
}

/** Post the card and record the pending approval. Null when posting failed. */
export async function requestCredentialApproval(input: {
  projectId: string
  provider: string
  providerLabel: string
  op: CredentialOp
  toolName?: string | null
  ticket: RequesterTicket | null
  place: ApprovalPlace
}): Promise<{ approvalId: string; expiresAt: string } | null> {
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS)
  const action = input.toolName ? `\`${input.toolName}\`` : `a ${input.op} on ${input.providerLabel}`
  const summary = `Use your own ${input.providerLabel} account for ${action}`
  const row = await db.integrationCredentialApproval.create({
    data: {
      projectId: input.projectId,
      provider: input.provider,
      op: input.op,
      toolName: input.toolName ?? null,
      summary,
      requesterUserId: input.ticket?.userId ?? null,
      origin: input.ticket?.origin ?? null,
      conversationId: input.place.conversationId,
      expiresAt,
    },
  })
  try {
    const { postApprovalCard } = await import('../conversation-approvals')
    const messageId = await postApprovalCard({
      conversationId: input.place.conversationId,
      workspaceId: input.place.workspaceId,
      threadRootId: input.place.threadRootId,
      agent: { projectId: input.projectId, name: input.place.agentName },
      sessionId: input.place.sessionId,
      request: {
        id: row.id,
        kind: 'credential',
        toolName: input.toolName ?? input.provider,
        summary,
        reason: `Approving runs this once with your ${input.providerLabel} account (you'll get a link to connect it if you haven't). Denying stops it.`,
        timeout: Math.round(APPROVAL_TTL_MS / 1000),
      },
    })
    if (!messageId) throw new Error('duplicate card')
    await db.integrationCredentialApproval.update({ where: { id: row.id }, data: { messageId } })
  } catch (err: any) {
    console.warn('[IntegrationCredentials] Could not post the approval card:', err?.message ?? err)
    await db.integrationCredentialApproval.update({ where: { id: row.id }, data: { status: 'expired' } })
    return null
  }
  return { approvalId: row.id, expiresAt: expiresAt.toISOString() }
}

/**
 * Record a decision from the card. False when the approval is no longer
 * waiting, or the person deciding can't act in the project's workspace.
 */
export async function decideCredentialApproval(input: {
  approvalId: string
  decision: 'allow_once' | 'deny'
  userId: string | null
  now?: Date
}): Promise<boolean> {
  if (!input.userId) return false
  const approval = await db.integrationCredentialApproval.findUnique({
    where: { id: input.approvalId },
    select: { projectId: true, project: { select: { workspaceId: true } } },
  })
  if (!approval) return false
  const member = await db.member.findFirst({
    where: { userId: input.userId, workspaceId: approval.project.workspaceId },
    select: { role: true },
  })
  if (!member || member.role === 'viewer') return false
  const now = input.now ?? new Date()
  const updated = await db.integrationCredentialApproval.updateMany({
    where: { id: input.approvalId, status: 'pending', expiresAt: { gt: now } },
    data: {
      status: input.decision === 'allow_once' ? 'approved' : 'denied',
      decidedByUserId: input.userId,
      decidedAt: now,
    },
  })
  return updated.count > 0
}

export type RedeemOutcome =
  | { state: 'pending'; expiresAt: string }
  | { state: 'denied' | 'expired' | 'used' | 'unknown' }
  | { state: 'approved'; approverUserId: string; requesterUserId: string | null; origin: unknown; provider: string; op: CredentialOp }

/** Where an approval stands, for the runtime polling it from `projectId`. */
export async function approvalState(projectId: string, approvalId: string, now = new Date()): Promise<RedeemOutcome> {
  const row = await db.integrationCredentialApproval.findUnique({ where: { id: approvalId } })
  if (!row || row.projectId !== projectId) return { state: 'unknown' }
  if (row.status === 'pending') {
    if (new Date(row.expiresAt).getTime() > now.getTime()) {
      return { state: 'pending', expiresAt: new Date(row.expiresAt).toISOString() }
    }
    await expireApproval(row)
    return { state: 'expired' }
  }
  if (row.status === 'approved' && row.decidedByUserId) {
    return {
      state: 'approved',
      approverUserId: row.decidedByUserId,
      requesterUserId: row.requesterUserId ?? null,
      origin: row.origin ?? null,
      provider: row.provider,
      op: row.op === 'read' ? 'read' : 'write',
    }
  }
  return { state: row.status === 'denied' || row.status === 'used' ? row.status : 'expired' }
}

/** Mark an approved request as spent. False when someone else already redeemed it. */
export async function markApprovalUsed(approvalId: string): Promise<boolean> {
  const updated = await db.integrationCredentialApproval.updateMany({
    where: { id: approvalId, status: 'approved' },
    data: { status: 'used' },
  })
  return updated.count > 0
}

async function expireApproval(row: { id: string; messageId: string | null }): Promise<void> {
  await db.integrationCredentialApproval.updateMany({ where: { id: row.id, status: 'pending' }, data: { status: 'expired' } })
  if (row.messageId) {
    const { expirePendingApprovals } = await import('../conversation-approvals')
    await expirePendingApprovals([row.messageId])
  }
}
