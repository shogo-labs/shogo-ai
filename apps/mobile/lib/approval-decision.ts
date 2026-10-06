// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Answering an agent's approval request from anywhere in the app: a Home row
 * swipe, the session card, or a notification button. One path, so the
 * biometric lock, the haptic and the refresh of every list happen the same
 * way each time.
 */
import { confirmApproval } from './approval-lock'
import { haptics } from './haptics'
import { teamChatApi } from './team-chat-api'

export type ApprovalAnswer = 'approve' | 'deny'

export type ApprovalOutcome =
  | { ok: true; decision: ApprovalAnswer }
  | { ok: false; reason: 'cancelled' }
  | { ok: false; reason: 'failed'; message: string }

type Listener = (event: { messageId: string; decision: ApprovalAnswer }) => void
const listeners = new Set<Listener>()

/** Called after any approval is answered, so lists can drop it at once. */
export function subscribeApprovalDecided(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** What a person should read when the server refuses an answer. */
export function approvalErrorMessage(err: any): string {
  const code = err?.response?.data?.error?.code
  if (code === 'already_decided') return err?.response?.data?.error?.message ?? 'Someone already answered this'
  if (code === 'expired') return 'This request timed out, so the action was not run'
  return err?.response?.data?.error?.message ?? err?.message ?? 'Could not send that answer'
}

export async function answerApproval(
  messageId: string,
  decision: ApprovalAnswer,
  opts: { biometricReason?: string; send?: (messageId: string, decision: ApprovalAnswer) => Promise<unknown> } = {},
): Promise<ApprovalOutcome> {
  if (decision === 'approve') {
    const allowed = await confirmApproval(opts.biometricReason ?? 'Approve this action')
    if (!allowed) {
      haptics.warning()
      return { ok: false, reason: 'cancelled' }
    }
  }
  try {
    await (opts.send ?? ((id, d) => teamChatApi().decideApproval(id, d)))(messageId, decision)
  } catch (err) {
    haptics.error()
    return { ok: false, reason: 'failed', message: approvalErrorMessage(err) }
  }
  if (decision === 'approve') haptics.success()
  else haptics.impact()
  for (const listener of [...listeners]) listener({ messageId, decision })
  return { ok: true, decision }
}
