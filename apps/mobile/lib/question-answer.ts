// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Answering or dismissing an agent's question from anywhere in the app: the
 * card in a channel or the Questions inbox. One path, so the haptic and the
 * refresh of every list and badge happen the same way each time.
 */
import { haptics } from './haptics'
import { newClientMsgId, teamChatApi } from './team-chat-api'

/** `relay` on an answer: `held` while the person still has questions open on the same card. */
export type QuestionOutcome = { ok: true; relay?: 'sent' | 'held' } | { ok: false; message: string }

type Listener = (event: { messageId: string; questionId: string }) => void
const listeners = new Set<Listener>()

/** Called after any question is answered or dismissed, so lists can drop it at once. */
export function subscribeQuestionClosed(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function questionErrorMessage(err: any): string {
  return err?.response?.data?.error?.message ?? err?.message ?? 'Could not send that answer'
}

async function run(messageId: string, questionId: string, send: () => Promise<unknown>): Promise<QuestionOutcome> {
  let result: { relay?: 'sent' | 'held' } | undefined
  try {
    result = (await send()) as { relay?: 'sent' | 'held' } | undefined
  } catch (err) {
    haptics.error()
    return { ok: false, message: questionErrorMessage(err) }
  }
  haptics.success()
  for (const listener of [...listeners]) listener({ messageId, questionId })
  return { ok: true, relay: result?.relay }
}

export function answerQuestion(messageId: string, questionId: string, input: { answer?: string; secret?: string }): Promise<QuestionOutcome> {
  return run(messageId, questionId, () => teamChatApi().answerQuestion(messageId, questionId, input))
}

/** Reply in the agent's thread that an account it needed is connected, which wakes it to carry on. */
export async function continueAfterConnect(input: { conversationId: string; messageId: string; threadRootId: string | null; agentProjectId: string | null; label: string }): Promise<void> {
  const tag = input.agentProjectId ? `<@a:p:${input.agentProjectId}>` : '<@a:ws>'
  await teamChatApi().post(input.conversationId, {
    text: `${tag} I connected ${input.label}. Please go ahead.`,
    threadRootId: input.threadRootId ?? input.messageId,
    clientMsgId: newClientMsgId(),
  })
}

export function dismissQuestion(messageId: string, questionId: string): Promise<QuestionOutcome> {
  return run(messageId, questionId, () => teamChatApi().dismissQuestion(messageId, questionId))
}
