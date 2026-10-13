// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A person pressing an option on a mirrored question card.
 *
 * Honored only for someone who linked their chat account to a Shogo user in
 * the card's workspace; then it takes the same path as an answer from the app,
 * so the card, `#activity` and the inbox all follow.
 */

import { prisma } from '../../lib/prisma'
import type { ExternalChatProvider } from '../chat-mode'
import { questionOptions, questionsOf } from '../conversation-message-kind'
import { answerQuestion, parseQuestionActionValue } from '../conversation-questions'
import { ConversationError } from '../conversation.service'
import { AgentMessageError } from './outbound'
import { installationForTenant, linkedUserId } from './installations'

const db = prisma as any

export interface QuestionPress {
  provider: ExternalChatProvider
  tenantId: string
  externalUserId: string
  /** `q|<messageId>|<questionId>|<option index>`, as set on the button. */
  value: string
}

export async function handleQuestionPress(
  press: QuestionPress,
  /** Fallback lookup for accounts linked before the shared identity table (Slack's own link table). */
  legacyUserId?: () => Promise<string | null>,
): Promise<{ ok: boolean; message: string }> {
  const parsed = parseQuestionActionValue(press.value)
  if (!parsed) return { ok: false, message: 'That button is not valid any more.' }

  const row = await db.conversationMessage.findUnique({ where: { id: parsed.messageId } })
  const question = row ? questionsOf(row.blocks).find((q) => q.id === parsed.questionId) : null
  const option = question ? questionOptions(question)[parsed.index] : null
  if (!row || !question || !option) return { ok: false, message: 'That question no longer exists.' }

  const installation = await installationForTenant(press.provider, press.tenantId)
  if (!installation || installation.workspaceId !== row.workspaceId) {
    return { ok: false, message: 'That question belongs to a different workspace.' }
  }
  const userId = (await linkedUserId(press.provider, press.tenantId, press.externalUserId)) ?? (await legacyUserId?.()) ?? null
  if (!userId) return { ok: false, message: 'Link your Shogo account first, then press the button again.' }

  try {
    await answerQuestion({
      messageId: row.id,
      questionId: question.id,
      userId,
      answer: option.label,
      origin: press.provider === 'teams' ? 'teams' : 'slack',
    })
    return { ok: true, message: `Answered: ${option.label}` }
  } catch (err) {
    if (err instanceof AgentMessageError || err instanceof ConversationError) return { ok: false, message: err.message }
    throw err
  }
}
