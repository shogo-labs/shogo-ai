// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Repair-on-read for `project_call` chats.
 *
 * The reply of a call is normally written by the stream follower
 * (`agent-call.service.ts`), which can be missed: the callee turn may produce
 * no text, the follower may attach after the runtime's 30 s buffer grace, or
 * the API may restart mid-call. The call record still holds the reply, so when
 * a chat is opened and its newest row is an unanswered call prompt, write the
 * missing assistant row from that record. Idempotent by construction — once the
 * reply row exists it is the newest row, so this never runs again for a turn.
 */
import { PROJECT_CALL_MESSAGE_AGENT } from '@shogo/shared-runtime/project-call-chat'
import { getAgentCall, getAgentCallSessionLink } from '../lib/agent-call-store'

/** Text persisted when a call ended with nothing to show at all. */
export function callNoReplyText(status: string): string {
  return `The called agent's turn ended before its reply could be saved (${status}). The reply may still be in the caller's task result.`
}

/**
 * Write the missing reply row for a call chat, if it is missing. Returns true
 * when a row was inserted. Never throws — a chat list must load even when the
 * call record is gone.
 */
export async function reconcileCallReplyOnRead(db: any, sessionId: string): Promise<boolean> {
  try {
    const newest = await db.chatMessage.findFirst({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      select: { role: true, agent: true },
    })
    if (!newest || newest.role !== 'user' || newest.agent !== PROJECT_CALL_MESSAGE_AGENT) return false

    const link = await getAgentCallSessionLink(sessionId)
    if (!link) return false
    const record = await getAgentCall(link.projectId, link.runId)
    if (!record || record.status === 'running') return false

    const reply = typeof record.reply === 'string' && record.reply.trim() ? record.reply : null
    const text = reply ?? callNoReplyText(record.error?.code ?? record.status)

    await db.chatMessage.create({
      data: {
        sessionId,
        role: 'assistant',
        content: text,
        parts: JSON.stringify([{ type: 'text', text }]),
        agent: 'technical',
      },
    })
    await db.chatSession
      .update({ where: { id: sessionId }, data: { lastActiveAt: new Date(), cachedMessageCount: { increment: 1 } } })
      .catch(() => {})
    console.log(
      `[AgentCall] reconciled missing call reply for ${sessionId} (run ${link.runId}, ${reply ? 'reply' : 'failure row'})`,
    )
    return true
  } catch (err: any) {
    console.warn('[AgentCall] could not reconcile a call reply:', err?.message ?? err)
    return false
  }
}
