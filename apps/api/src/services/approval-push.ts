// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The phone push for an approval card: who is asking and for what, with the
 * `agent-approval` category so the phone shows Approve and Deny on the
 * notification itself. The buttons call the same approval route as the app,
 * which only accepts the first answer to a card that is still open.
 */

/** Notification categories the mobile app registers with `setNotificationCategoryAsync`. */
export const APPROVAL_CATEGORY = 'agent-approval'

export interface ApprovalPush {
  /** Who is asking, without the sentence around it. */
  agentName: string
  title: string
  body: string
  categoryId: typeof APPROVAL_CATEGORY
  data: { approvalMessageId: string; approvalRequestId: string; projectId: string | null }
}

const MAX_BODY = 180

/** The push for an open approval card, or null for any other message. */
export function approvalPushFor(row: { id: string; blocks?: unknown; authorAgentRef?: { name?: string } | null }): ApprovalPush | null {
  const blocks = row.blocks as { type?: unknown; approval?: Record<string, unknown> } | null | undefined
  const approval = blocks?.type === 'approval_request' ? blocks.approval : undefined
  if (!approval || approval.status !== 'pending' || typeof approval.requestId !== 'string') return null
  const summary = typeof approval.summary === 'string' ? approval.summary.trim() : ''
  const name = row.authorAgentRef?.name?.trim() || 'An agent'
  return {
    agentName: name,
    title: `${name} needs approval`,
    body: (summary || 'Waiting for your OK').slice(0, MAX_BODY),
    categoryId: APPROVAL_CATEGORY,
    data: {
      approvalMessageId: row.id,
      approvalRequestId: approval.requestId,
      projectId: typeof approval.projectId === 'string' ? approval.projectId : null,
    },
  }
}
