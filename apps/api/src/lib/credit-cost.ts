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
 * - GPT-5.4-Nano: $0.20 input / $0.02 cached input / $1.25 output
 * - Haiku:       $0.80 input / $0.08 cached input / $4.00 output
 * - GPT-5.4-Mini: $1.10 input / $0.55 cached input / $4.40 output
 * - Sonnet:      $3.00 input / $0.30 cached input / $15.00 output
 * - Opus:        $15.00 input / $1.50 cached input / $75.00 output
 *
 * Cached input rates: Anthropic charges 10% of input for cache reads,
 * OpenAI charges 50%. The billing tiers approximate this per model family.
 */

import {
  getModelTier as catalogGetModelTier,
  getModelBillingModel,
  resolveAgentModeDefault,
  type ModelTier,
  type AgentMode,
  type BillingModel,
} from '@shogo/model-catalog'

export type { ModelTier, AgentMode }

export const CREDIT_DOLLAR_VALUE = 0.10
export const MIN_CREDIT_COST = 0.2
export const MIN_CREDIT_COST_ECONOMY = 0.1

export const MODEL_DOLLAR_COSTS = {
  'gpt-5.4-nano': { inputPerMillion: 0.20, cachedInputPerMillion: 0.02, outputPerMillion: 1.25 },
  haiku:          { inputPerMillion: 0.80, cachedInputPerMillion: 0.08, outputPerMillion: 4.00 },
  'gpt-5.4-mini': { inputPerMillion: 0.75, cachedInputPerMillion: 0.075, outputPerMillion: 4.40 },
  sonnet:         { inputPerMillion: 3.00, cachedInputPerMillion: 0.30, outputPerMillion: 15.00 },
  opus:           { inputPerMillion: 15.00, cachedInputPerMillion: 1.50, outputPerMillion: 75.00 },
} as const

export type ModelName = keyof typeof MODEL_DOLLAR_COSTS

const BILLING_MODEL_TIER: Record<ModelName, ModelTier> = {
  'gpt-5.4-nano': 'economy',
  haiku:          'economy',
  'gpt-5.4-mini': 'economy',
  sonnet:         'standard',
  opus:           'premium',
}

/** Re-export from the shared catalog for backward compatibility. */
export const getModelTier = catalogGetModelTier

/**
 * Map agent mode (model ID or legacy "basic"/"advanced") to billing model name.
 */
export function agentModeToModel(agentMode?: string): ModelName {
  if (!agentMode) return resolveAgentModeDefault('advanced') as ModelName
  if (agentMode === 'basic' || agentMode === 'advanced') {
    return resolveAgentModeDefault(agentMode as AgentMode) as ModelName
  }
  const billing = getModelBillingModel(agentMode)
  if (billing in MODEL_DOLLAR_COSTS) return billing as ModelName
  return 'sonnet'
}

/**
 * Map a proxy model string to a billing ModelName using the shared catalog.
 */
export function proxyModelToBillingModel(proxyModel: string): ModelName {
  const billing = getModelBillingModel(proxyModel)
  if (billing in MODEL_DOLLAR_COSTS) return billing as ModelName
  return 'sonnet'
}

function resolveModel(modelOrAgentMode?: string): ModelName {
  if (!modelOrAgentMode) return 'sonnet'
  if (modelOrAgentMode === 'basic' || modelOrAgentMode === 'advanced') {
    return agentModeToModel(modelOrAgentMode)
  }
  if (modelOrAgentMode in MODEL_DOLLAR_COSTS) {
    return modelOrAgentMode as ModelName
  }
  const billing = getModelBillingModel(modelOrAgentMode)
  if (billing in MODEL_DOLLAR_COSTS) return billing as ModelName
  return 'sonnet'
}

/**
 * Calculate credit cost from separate input/output token counts.
 * 1 credit = $0.10 of raw LLM cost.
 *
 * `inputTokens` should be non-cached input only. Pass `cachedInputTokens`
 * separately so they're billed at the discounted cache-read rate.
 */
export function calculateCreditCost(
  inputTokens: number,
  outputTokens: number,
  modelOrAgentMode?: string,
  cachedInputTokens: number = 0,
): number {
  const model = resolveModel(modelOrAgentMode)
  const costs = MODEL_DOLLAR_COSTS[model]
  const dollarCost =
    (inputTokens * costs.inputPerMillion / 1_000_000) +
    (cachedInputTokens * costs.cachedInputPerMillion / 1_000_000) +
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
