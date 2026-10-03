// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A person pressing Approve or Deny on a mirrored approval card.
 *
 * The press is only honored for someone who linked their chat account to a
 * Shogo user in the workspace the card belongs to, and who is not a viewer;
 * then it takes the same path as an answer from the app.
 */

import { prisma } from '../../lib/prisma'
import type { ExternalChatProvider } from '../chat-mode'
import { respondToPermission } from '../conversation-agent-dispatcher'
import { approvalOf, decideApproval, type ApprovalDecision, type ApprovalResponder } from '../conversation-approvals'
import { getWorkspaceRole } from '../conversation.service'
import { AgentMessageError } from './outbound'
import { installationForTenant, linkedUserId } from './installations'

const db = prisma as any

export interface ApprovalPress {
  provider: ExternalChatProvider
  tenantId: string
  externalUserId: string
  /** `<messageId>:<approve|deny>`, as set on the button. */
  value: string
}

export interface ApprovalPressResult {
  ok: boolean
  /** Shown to the person who pressed, privately. */
  message: string
}

export function parseApprovalValue(value: string): { messageId: string; decision: ApprovalDecision } | null {
  const at = value.lastIndexOf(':')
  if (at <= 0) return null
  const decision = value.slice(at + 1)
  if (decision !== 'approve' && decision !== 'deny') return null
  return { messageId: value.slice(0, at), decision }
}

export async function handleApprovalPress(
  press: ApprovalPress,
  respond: ApprovalResponder = respondToPermission,
  /** Fallback lookup for accounts linked before the shared identity table (Slack's own link table). */
  legacyUserId?: () => Promise<string | null>,
): Promise<ApprovalPressResult> {
  const parsed = parseApprovalValue(press.value)
  if (!parsed) return { ok: false, message: 'That button is not valid any more.' }

  const row = await db.conversationMessage.findUnique({ where: { id: parsed.messageId } })
  if (!row || !approvalOf(row.blocks)) return { ok: false, message: 'That approval request no longer exists.' }

  // The card must belong to the workspace this chat tenant is installed for.
  const installation = await installationForTenant(press.provider, press.tenantId)
  if (!installation || installation.workspaceId !== row.workspaceId) {
    return { ok: false, message: 'That request belongs to a different workspace.' }
  }

  const userId = (await linkedUserId(press.provider, press.tenantId, press.externalUserId)) ?? (await legacyUserId?.()) ?? null
  if (!userId) return { ok: false, message: 'Link your Shogo account first, then press the button again.' }
  const role = await getWorkspaceRole(row.workspaceId, userId)
  if (!role || role === 'viewer') return { ok: false, message: 'You do not have permission to approve agent actions here.' }

  const user = await db.user.findUnique({ where: { id: userId }, select: { name: true, email: true } }).catch(() => null)
  try {
    const { approval } = await decideApproval({
      messageId: row.id,
      decision: parsed.decision,
      by: { userId, name: user?.name || user?.email || 'Someone' },
      respond,
    })
    return { ok: true, message: approval.status === 'approved' ? 'Approved.' : 'Denied.' }
  } catch (err) {
    if (err instanceof AgentMessageError) return { ok: false, message: err.message }
    throw err
  }
}
