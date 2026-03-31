// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Credit Cost Calculator
 *
 * Shared module for computing credit costs from token usage.
 * Used by both the AI chat endpoint and the AI proxy.
 *
 * 1 credit = $0.10 of raw LLM cost. Credits are calculated from actual
 * dollar cost using separate input/output token pricing per model tier.
 *
 * Model costs (per 1M tokens):
 * - Haiku:       $0.80 input / $4.00 output
 * - GPT-5.4-Mini: $1.10 input / $4.40 output
 * - Sonnet:      $3.00 input / $15.00 output
 * - Opus:        $15.00 input / $75.00 output
 */

export const CREDIT_DOLLAR_VALUE = 0.10
export const MIN_CREDIT_COST = 0.2
export const MIN_CREDIT_COST_ECONOMY = 0.1

export const MODEL_DOLLAR_COSTS = {
  haiku:          { inputPerMillion: 0.80, outputPerMillion: 4.00 },
  'gpt-5.4-mini': { inputPerMillion: 1.10, outputPerMillion: 4.40 },
  sonnet:         { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  opus:           { inputPerMillion: 15.00, outputPerMillion: 75.00 },
} as const

export type ModelName = keyof typeof MODEL_DOLLAR_COSTS
export type AgentMode = 'basic' | 'advanced'
export type ModelTier = 'economy' | 'standard' | 'premium'

const BILLING_MODEL_TIER: Record<ModelName, ModelTier> = {
  haiku:          'economy',
  'gpt-5.4-mini': 'economy',
  sonnet:         'standard',
  opus:           'premium',
}

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
  'gpt-5.4-mini': 'economy',
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
  if (agentMode === 'basic') return 'gpt-5.4-mini'
  return 'sonnet'
}

/**
 * Map a proxy model string (e.g. "claude-sonnet", "claude-haiku-4-5", "gpt-5-mini") to a billing ModelName.
 */
export function proxyModelToBillingModel(proxyModel: string): ModelName {
  const lower = proxyModel.toLowerCase()
  if (lower === 'gpt-5.4-mini') return 'gpt-5.4-mini'
  if (lower.includes('opus') || lower === 'gpt-5.4' || lower === 'o3') return 'opus'
  if (lower.includes('haiku') || lower.includes('nano') || lower.includes('mini')) return 'haiku'
  return 'sonnet'
}

function resolveModel(modelOrAgentMode?: ModelName | AgentMode): ModelName {
  if (modelOrAgentMode === 'basic' || modelOrAgentMode === 'advanced') {
    return agentModeToModel(modelOrAgentMode as AgentMode)
  }
  if (modelOrAgentMode && modelOrAgentMode in MODEL_DOLLAR_COSTS) {
    return modelOrAgentMode as ModelName
  }
  return 'sonnet'
}

/**
 * Calculate credit cost from separate input/output token counts.
 * 1 credit = $0.10 of raw LLM cost.
 */
export function calculateCreditCost(
  inputTokens: number,
  outputTokens: number,
  modelOrAgentMode?: ModelName | AgentMode
): number {
  const model = resolveModel(modelOrAgentMode)
  const costs = MODEL_DOLLAR_COSTS[model]
  const dollarCost =
    (inputTokens * costs.inputPerMillion / 1_000_000) +
    (outputTokens * costs.outputPerMillion / 1_000_000)

  const raw = Math.ceil((dollarCost / CREDIT_DOLLAR_VALUE) * 10) / 10
  if (raw === 0) return 0
  const min = BILLING_MODEL_TIER[model] === 'economy' ? MIN_CREDIT_COST_ECONOMY : MIN_CREDIT_COST
  return Math.max(min, raw)
}

// =============================================================================
// Image Generation Credit Costs
// =============================================================================

// Base costs are expressed directly in credits (1 credit = $0.10).
export const IMAGE_CREDIT_CONFIG: Record<string, { base: number; hdMultiplier: number; largeSizeMultiplier: number }> = {
  'dall-e-3':       { base: 2.6, hdMultiplier: 2.0, largeSizeMultiplier: 1.5 },
  'dall-e-2':       { base: 1.3, hdMultiplier: 1.0, largeSizeMultiplier: 1.0 },
  'gpt-image-1':    { base: 3.9, hdMultiplier: 1.5, largeSizeMultiplier: 1.5 },
  'gpt-image-1.5':  { base: 3.9, hdMultiplier: 1.5, largeSizeMultiplier: 1.5 },
  'imagen-4':       { base: 2.0, hdMultiplier: 1.0, largeSizeMultiplier: 1.5 },
  'imagen-4-ultra': { base: 3.9, hdMultiplier: 1.0, largeSizeMultiplier: 1.5 },
  'imagen-4-fast':  { base: 1.3, hdMultiplier: 1.0, largeSizeMultiplier: 1.5 },
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

  return Math.ceil(cost * 10) / 10
}
