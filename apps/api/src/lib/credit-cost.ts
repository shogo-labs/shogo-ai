// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Credit Cost Calculator
 *
 * Shared module for computing credit costs from token usage.
 * Used by both the AI chat endpoint and the AI proxy.
 *
 * Pricing is based on Anthropic's model costs:
 * - Haiku: ~$0.80/$4 per 1M tokens (input/output) - cheapest
 * - Sonnet: ~$3/$15 per 1M tokens (input/output) - 4x more than Haiku
 * - Opus: ~$15/$75 per 1M tokens (input/output) - 5x more than Sonnet
 *
 * Credit rates (per 5000 tokens):
 * - Haiku (basic): 0.025 credits
 * - Sonnet (advanced): 0.1 credits
 * - Opus: 0.5 credits
 */

export const CREDIT_MARKUP_FACTOR = 1.3

export const MODEL_CREDIT_CONFIG = {
  haiku: {
    creditsPerTokenBatch: 0.025,
    tokenBatchSize: 5000,
  },
  sonnet: {
    creditsPerTokenBatch: 0.1,
    tokenBatchSize: 5000,
  },
  opus: {
    creditsPerTokenBatch: 0.5,
    tokenBatchSize: 5000,
  },
} as const

export type ModelName = keyof typeof MODEL_CREDIT_CONFIG
export type AgentMode = 'basic' | 'advanced'
export type ModelTier = 'economy' | 'standard' | 'premium'

const MODEL_TIER_MAP: Record<string, ModelTier> = {
  'claude-opus-4-6': 'premium',
  'claude-opus-4-5': 'premium',
  'claude-opus-4-5-20251101': 'premium',
  'claude-opus-4-1': 'premium',
  'claude-opus-4-1-20250805': 'premium',
  'claude-opus-4-0': 'premium',
  'claude-opus-4-20250514': 'premium',
  'claude-opus': 'premium',
  'claude-sonnet-4-6': 'standard',
  'claude-sonnet-4-5': 'standard',
  'claude-sonnet-4-5-20250929': 'standard',
  'claude-sonnet-4-0': 'standard',
  'claude-sonnet-4-20250514': 'standard',
  'claude-sonnet': 'standard',
  'claude-3-7-sonnet-20250219': 'standard',
  'claude-3-7-sonnet-latest': 'standard',
  'claude-haiku-4-5-20251001': 'economy',
  'claude-haiku-4-5': 'economy',
  'claude-haiku': 'economy',
  'claude-3-haiku-20240307': 'economy',
  'gpt-5.4': 'premium',
  'o3': 'premium',
  'o1': 'premium',
  'gpt-5-mini': 'standard',
  'o4-mini': 'standard',
  'gpt-4.1': 'standard',
  'gpt-4o': 'standard',
  'gpt-4-turbo': 'standard',
  'gpt-5-nano': 'economy',
  'gpt-4o-mini': 'economy',
  'o1-mini': 'economy',
  'o3-mini': 'economy',
}

/**
 * Resolve the billing tier for a model. Unknown models default to 'standard'
 * so they're blocked for free users (fail-safe).
 */
export function getModelTier(model: string): ModelTier {
  if (MODEL_TIER_MAP[model]) return MODEL_TIER_MAP[model]
  const lower = model.toLowerCase()
  if (lower.includes('opus')) return 'premium'
  if (lower.includes('haiku') || lower.includes('nano') || lower.includes('mini')) return 'economy'
  return 'standard'
}

/**
 * Map agent mode to model name for credit calculation.
 */
export function agentModeToModel(agentMode?: AgentMode): ModelName {
  if (agentMode === 'basic') return 'haiku'
  return 'sonnet' // default for 'advanced' or undefined
}

/**
 * Map a proxy model string (e.g. "claude-sonnet", "claude-haiku-4-5", "gpt-5-mini") to a billing ModelName.
 */
export function proxyModelToBillingModel(proxyModel: string): ModelName {
  const lower = proxyModel.toLowerCase()
  if (lower.includes('opus') || lower === 'gpt-5.4' || lower === 'o3') return 'opus'
  if (lower.includes('haiku') || lower.includes('nano') || lower.includes('mini')) return 'haiku'
  return 'sonnet'
}

/**
 * Calculate credit cost based on total tokens consumed and model used.
 *
 * @param totalTokens - Combined input + output tokens
 * @param modelOrAgentMode - Model name ('haiku', 'sonnet', 'opus') or agent mode ('basic', 'advanced')
 * @returns Credits to charge
 */
export function calculateCreditCost(
  totalTokens: number,
  modelOrAgentMode?: ModelName | AgentMode
): number {
  // Determine the model from input
  let model: ModelName = 'sonnet' // default
  if (modelOrAgentMode === 'basic' || modelOrAgentMode === 'advanced') {
    model = agentModeToModel(modelOrAgentMode as AgentMode)
  } else if (modelOrAgentMode && modelOrAgentMode in MODEL_CREDIT_CONFIG) {
    model = modelOrAgentMode as ModelName
  }

  const config = MODEL_CREDIT_CONFIG[model]

  const rawCredits = (totalTokens / config.tokenBatchSize) * config.creditsPerTokenBatch * CREDIT_MARKUP_FACTOR

  return Math.ceil(rawCredits * 10) / 10
}

// =============================================================================
// Image Generation Credit Costs
// =============================================================================

export const IMAGE_CREDIT_CONFIG: Record<string, { base: number; hdMultiplier: number; largeSizeMultiplier: number }> = {
  'dall-e-3':       { base: 2.0, hdMultiplier: 2.0, largeSizeMultiplier: 1.5 },
  'dall-e-2':       { base: 1.0, hdMultiplier: 1.0, largeSizeMultiplier: 1.0 },
  'gpt-image-1':    { base: 3.0, hdMultiplier: 1.5, largeSizeMultiplier: 1.5 },
  'gpt-image-1.5':  { base: 3.0, hdMultiplier: 1.5, largeSizeMultiplier: 1.5 },
  'imagen-4':       { base: 1.5, hdMultiplier: 1.0, largeSizeMultiplier: 1.5 },
  'imagen-4-ultra': { base: 3.0, hdMultiplier: 1.0, largeSizeMultiplier: 1.5 },
  'imagen-4-fast':  { base: 1.0, hdMultiplier: 1.0, largeSizeMultiplier: 1.5 },
}

const LARGE_IMAGE_SIZES = new Set(['1792x1024', '1024x1792', '1536x1024', '1024x1536'])

/**
 * Calculate credit cost for image generation (flat per-image, not token-based).
 */
export function calculateImageCreditCost(
  model: string,
  quality: string = 'standard',
  size: string = '1024x1024',
): number {
  const config = IMAGE_CREDIT_CONFIG[model] || IMAGE_CREDIT_CONFIG['dall-e-3']
  let cost = config.base

  if (quality === 'hd' || quality === 'high') {
    cost *= config.hdMultiplier
  }

  if (LARGE_IMAGE_SIZES.has(size)) {
    cost *= config.largeSizeMultiplier
  }

  return Math.ceil(cost * CREDIT_MARKUP_FACTOR * 10) / 10
}
