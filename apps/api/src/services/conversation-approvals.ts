// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Approval cards: when an agent running for a channel hits an "ask first"
 * action, the question is posted in its thread as a `decision` message with
 * Approve and Deny. Whoever can post in the channel may answer, from the app,
 * the island, or Slack. The first answer wins, the card is edited to show who
 * decided, and the answer is forwarded to the runtime that is waiting on it.
 */

import { prisma } from '../lib/prisma'
import { AgentMessageError, postAgentMessage, rewriteMessage } from './chat-providers/outbound'
import type { OutboundAction } from './chat-providers/types'
import type { AgentChain } from './conversation-agent-chain'
import type { MessageBlocks } from './conversation-message-kind'

const db = prisma as any

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired'
export type ApprovalDecision = 'approve' | 'deny'

export interface ApprovalRequest {
  id: string
  toolName: string
  category?: string
  params?: Record<string, unknown>
  reason?: string
  /** Seconds the runtime waits before denying on its own. */
  timeout?: number
}

export interface ApprovalBlock {
  requestId: string
  projectId: string
  toolName: string
  summary: string
  reason?: string
  status: ApprovalStatus
  expiresAt?: string
  decidedBy?: { userId: string | null; name: string }
  decidedAt?: string
}

/** How an answer reaches the runtime waiting on it. Returns false when it couldn't be delivered. */
export type ApprovalResponder = (input: { projectId: string; requestId: string; decision: 'allow_once' | 'deny' }) => Promise<boolean>

const MAX_SUMMARY = 240
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

const TOOL_LABEL: Record<string, string> = {
  github_merge_pr: 'Merge pull request',
  exec: 'Run a command',
  shell: 'Run a command',
  write_file: 'Write a file',
  edit_file: 'Edit a file',
}

/** One line a person can decide on, from the request's tool and parameters. */
export function approvalSummary(request: ApprovalRequest): string {
  const params = request.params ?? {}
  const label = TOOL_LABEL[request.toolName] ?? request.toolName
  if (request.toolName === 'github_merge_pr') {
    const method = typeof params.method === 'string' ? ` (${params.method})` : ''
    const title = typeof params.commitTitle === 'string' && params.commitTitle ? ` — ${params.commitTitle}` : ''
    return clip(`${label} #${String(params.number ?? '?')}${method}${title}`, MAX_SUMMARY)
  }
  const detail = ['command', 'path', 'file_path', 'url', 'query']
    .map((k) => params[k])
    .find((v): v is string => typeof v === 'string' && v.length > 0)
  return clip(detail ? `${label}: ${detail}` : label, MAX_SUMMARY)
}

const STATUS_TEXT: Record<ApprovalStatus, string> = {
  pending: 'Waiting for a decision',
  approved: 'Approved',
  denied: 'Denied',
  expired: 'No answer in time, so it was not run',
}

export function approvalText(approval: ApprovalBlock, agentName: string): string {
  const lines = [`**${agentName} needs approval** — ${approval.summary}`]
  if (approval.reason) lines.push(approval.reason)
  const by = approval.decidedBy ? ` by ${approval.decidedBy.name}` : ''
  lines.push(`_${STATUS_TEXT[approval.status]}${approval.status === 'approved' || approval.status === 'denied' ? by : ''}._`)
  return lines.join('\n\n')
}

export function approvalActions(messageId: string): OutboundAction[] {
  return [
    { id: 'approve', label: 'Approve', style: 'primary', value: `${messageId}:approve` },
    { id: 'deny', label: 'Deny', style: 'danger', value: `${messageId}:deny` },
  ]
}

export function approvalOf(blocks: unknown): ApprovalBlock | null {
  const b = blocks as MessageBlocks | null | undefined
  return b?.type === 'approval_request' && b.approval && typeof (b.approval as any).requestId === 'string' ? (b.approval as ApprovalBlock) : null
}

const blocksFor = (approval: ApprovalBlock): MessageBlocks => ({ messageKind: 'decision', type: 'approval_request', approval })

/** Post the question into the thread the agent is working in. Returns the card's message id. */
export async function postApprovalCard(input: {
  conversationId: string
  workspaceId: string
  threadRootId: string | null
  agent: { projectId: string; name: string }
  sessionId: string
  chain?: AgentChain | null
  request: ApprovalRequest
}): Promise<string | null> {
  const approval: ApprovalBlock = {
    requestId: input.request.id,
    projectId: input.agent.projectId,
    toolName: input.request.toolName,
    summary: approvalSummary(input.request),
    ...(input.request.reason ? { reason: clip(input.request.reason, 400) } : {}),
    status: 'pending',
    ...(input.request.timeout ? { expiresAt: new Date(Date.now() + input.request.timeout * 1000).toISOString() } : {}),
  }
  const result = await postAgentMessage({
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    text: approvalText(approval, input.agent.name),
    agent: input.agent,
    threadRootId: input.threadRootId,
    agentSessionId: input.sessionId,
    agentChain: input.chain ?? null,
    blocks: blocksFor(approval),
    agentStatus: 'done',
    actions: (row) => approvalActions(row.id),
  })
  if (result.duplicate) return null
  // Decision cards notify the thread's followers; see conversation-notifications.
  void import('./conversation-pipeline')
    .then(({ afterMessagePosted }) => afterMessagePosted(result, { actorUserId: null, origin: 'agent' }))
    .catch((err) => console.warn('[Approvals] post hooks failed:', err.message))
  return result.row.id as string
}

async function settle(row: any, patch: Partial<ApprovalBlock>): Promise<{ message: any; approval: ApprovalBlock }> {
  const current = approvalOf(row.blocks)!
  const approval: ApprovalBlock = { ...current, ...patch }
  const name = (row.authorAgentRef?.name as string | undefined) ?? 'The agent'
  const { message } = await rewriteMessage({
    messageId: row.id,
    text: approvalText(approval, name),
    blocks: blocksFor(approval),
    actions: approval.status === 'pending' ? approvalActions(row.id) : [],
  })
  return { message, approval }
}

const deciding = new Set<string>()

/**
 * Record a person's answer and forward it to the runtime. The first answer
 * wins: a card that is no longer pending, or whose runtime has already given
 * up waiting, rejects the answer.
 */
export async function decideApproval(input: {
  messageId: string
  decision: ApprovalDecision
  by: { userId: string | null; name: string }
  respond: ApprovalResponder
  now?: Date
}): Promise<{ message: any; approval: ApprovalBlock }> {
  const row = await db.conversationMessage.findUnique({ where: { id: input.messageId } })
  const approval = row && !row.deletedAt ? approvalOf(row.blocks) : null
  if (!row || !approval) throw new AgentMessageError(404, 'not_found', 'Approval request not found')
  if (deciding.has(row.id)) throw new AgentMessageError(409, 'already_decided', 'Someone is already answering this')
  if (approval.status !== 'pending') {
    throw new AgentMessageError(409, 'already_decided', `Already ${approval.status}${approval.decidedBy ? ` by ${approval.decidedBy.name}` : ''}`)
  }
  const now = input.now ?? new Date()
  if (approval.expiresAt && Date.parse(approval.expiresAt) <= now.getTime()) {
    await settle(row, { status: 'expired' })
    throw new AgentMessageError(409, 'expired', 'This request timed out, so the action was not run')
  }

  deciding.add(row.id)
  try {
    const delivered = await input.respond({
      projectId: approval.projectId,
      requestId: approval.requestId,
      decision: input.decision === 'approve' ? 'allow_once' : 'deny',
    })
    if (!delivered) {
      await settle(row, { status: 'expired' })
      throw new AgentMessageError(409, 'expired', 'The agent is no longer waiting on this')
    }
    return await settle(row, {
      status: input.decision === 'approve' ? 'approved' : 'denied',
      decidedBy: input.by,
      decidedAt: now.toISOString(),
    })
  } finally {
    deciding.delete(row.id)
  }
}

/** The run is over: any card still waiting can no longer be acted on. */
export async function expirePendingApprovals(messageIds: string[]): Promise<void> {
  for (const id of messageIds) {
    try {
      const row = await db.conversationMessage.findUnique({ where: { id } })
      if (row && approvalOf(row.blocks)?.status === 'pending') await settle(row, { status: 'expired' })
    } catch (err) {
      console.warn('[Approvals] expire failed:', (err as Error).message)
    }
  }
}

export function _resetApprovalsForTests(): void {
  deciding.clear()
}
