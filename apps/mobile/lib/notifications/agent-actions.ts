// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Approve and Deny on the notification itself, for an agent waiting on a
 * person. Pure helpers: the category the phone registers, and how a tap on one
 * of its buttons is read. The native notifier does the registering and sending.
 *
 * The API sends these pushes with `categoryId: 'agent-approval'` and the
 * card's message id in `data.approvalMessageId` (see `approval-push.ts`).
 */
import type { ApprovalAnswer } from '../approval-decision'

export const APPROVAL_CATEGORY = 'agent-approval'
export const ACTION_APPROVE = 'approve'
export const ACTION_DENY = 'deny'

export interface ApprovalCategoryAction {
  identifier: string
  buttonTitle: string
  options: { opensAppToForeground: boolean; isDestructive?: boolean; isAuthenticationRequired?: boolean }
}

/**
 * The buttons. iOS asks for the phone to be unlocked before Approve (the
 * notification button cannot show Face ID itself). When the Face ID setting is
 * on, Approve opens the app instead, where the real prompt can appear.
 */
export function approvalCategoryActions(opts: { requireBiometric: boolean }): ApprovalCategoryAction[] {
  return [
    {
      identifier: ACTION_APPROVE,
      buttonTitle: 'Approve',
      options: { opensAppToForeground: opts.requireBiometric, isAuthenticationRequired: true },
    },
    {
      identifier: ACTION_DENY,
      buttonTitle: 'Deny',
      options: { opensAppToForeground: false, isDestructive: true },
    },
  ]
}

export interface ResponseLike {
  actionIdentifier?: string
  notification?: { request?: { identifier?: string; content?: { data?: unknown } } }
}

export interface ApprovalAction {
  messageId: string
  decision: ApprovalAnswer
  /** The notification to clear once answered. */
  notificationId: string | null
}

/** A tap on Approve or Deny of an approval notification, or null for any other response. */
export function approvalActionFrom(response: ResponseLike | null | undefined): ApprovalAction | null {
  if (!response) return null
  const decision = response.actionIdentifier === ACTION_APPROVE ? 'approve' : response.actionIdentifier === ACTION_DENY ? 'deny' : null
  if (!decision) return null
  const data = (response.notification?.request?.content?.data ?? {}) as Record<string, unknown>
  if (typeof data.approvalMessageId !== 'string' || !data.approvalMessageId) return null
  return { messageId: data.approvalMessageId, decision, notificationId: response.notification?.request?.identifier ?? null }
}

/** What the phone says when an answer sent from a notification did not go through. */
export function failedAnswerBody(decision: ApprovalAnswer, message: string): string {
  return `${decision === 'approve' ? 'Approval' : 'Denial'} not sent: ${message}`
}
