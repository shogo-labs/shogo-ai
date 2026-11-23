// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The model call behind `POST /api/learn/coach`.
 *
 * Runs on the shared assistant model through the proxy, tagged as internal
 * usage (`learn_coach`): the coach is part of the membership, so its cost is
 * tracked for admins but not billed to the learner's AI allowance. Per-learner
 * daily caps in `LEARN_COACH_DAILY_LIMIT` bound what it can cost.
 */
import { generateText } from 'ai'
import { DEFAULT_ASSISTANT_MODEL, resolveLanguageModel } from './resolve-language-model'

export const LEARN_COACH_MODEL_ID = DEFAULT_ASSISTANT_MODEL
export const LEARN_COACH_MAX_OUTPUT_TOKENS = 400

export async function generateLearnCoachReply(input: {
  system: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
}): Promise<string> {
  const resolved = resolveLanguageModel(LEARN_COACH_MODEL_ID, {
    headers: { 'x-shogo-usage-tag': 'learn_coach' },
  })
  if (!resolved) throw new Error(`coach model "${LEARN_COACH_MODEL_ID}" could not be resolved`)
  const result = await generateText({
    model: resolved.model,
    maxOutputTokens: LEARN_COACH_MAX_OUTPUT_TOKENS,
    system: input.system,
    messages: input.messages,
    ...(resolved.provider === 'custom'
      ? { providerOptions: { shogo: { thinking: { type: 'disabled' } } } }
      : {}),
  })
  const text = result.text.trim()
  if (!text) throw new Error('coach model returned no text')
  return text
}
