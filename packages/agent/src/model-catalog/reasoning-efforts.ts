// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { ModelEntry, ReasoningEffort } from './models'

const VALID_EFFORTS = new Set<ReasoningEffort>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
])

const GOOGLE_THINKING_LEVELS: Record<string, readonly ReasoningEffort[]> = {
  'gemini-4-carbon': ['low', 'medium', 'high'],
  'gemini-4-argon': ['low', 'medium', 'high'],
  'gemini-4-neon': ['low', 'medium', 'high', 'xhigh'],
  'gemini-4-hydrogen': ['low', 'medium', 'high', 'xhigh'],
  'gemini-3.1-pro-preview': ['low', 'medium', 'high'],
  'gemini-3.8-flash': ['minimal', 'low', 'medium', 'high'],
  'gemini-3.5-flash-lite': ['minimal', 'low', 'medium', 'high'],
}

export function getGoogleThinkingEfforts(apiModel: string): readonly ReasoningEffort[] {
  return GOOGLE_THINKING_LEVELS[apiModel] ?? ['low', 'medium', 'high']
}

function sanitizeEfforts(raw: unknown): ReasoningEffort[] | null {
  if (!Array.isArray(raw)) return null
  const efforts = raw.filter(
    (effort): effort is ReasoningEffort =>
      typeof effort === 'string' && VALID_EFFORTS.has(effort as ReasoningEffort),
  )
  return [...new Set(efforts)]
}

/**
 * Return the effort variants the picker may offer for a model.
 *
 * Explicit capability metadata wins (used by custom OpenAI-compatible
 * providers). Otherwise use only the provider/model combinations whose wire
 * support Shogo knows how to translate. `reasoningEffort` remains the model's
 * configured default; it does not restrict the choices the user can make.
 */
export function getSupportedReasoningEfforts(
  model: Pick<ModelEntry, 'provider' | 'apiModel' | 'reasoningEffort' | 'reasoningEfforts' | 'thinkingApi' | 'capabilities'>,
): ReasoningEffort[] {
  const configured = sanitizeEfforts(model.reasoningEfforts) ?? sanitizeEfforts(model.capabilities?.reasoningEfforts)
  if (configured) return configured

  if (model.provider === 'google') {
    return [...getGoogleThinkingEfforts(model.apiModel)]
  }

  if (model.provider === 'anthropic' && model.thinkingApi) {
    return model.thinkingApi === 'adaptive'
      ? ['low', 'medium', 'high', 'xhigh']
      : ['low', 'medium', 'high']
  }

  if (model.provider === 'openai' && /^gpt-(?:5|6)(?:[.-]|$)/i.test(model.apiModel)) {
    return ['minimal', 'low', 'medium', 'high', 'xhigh']
  }

  // A custom / OpenRouter route has no reliable model-capability catalog. An
  // admin can opt it in by declaring `capabilities.reasoningEfforts`; do not
  // guess and send a parameter that an arbitrary endpoint may reject.
  return []
}

/** Runtime validation shared by API routes and the chat proxy boundary. */
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && VALID_EFFORTS.has(value as ReasoningEffort)
}
