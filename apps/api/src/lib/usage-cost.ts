// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Usage Cost Calculator
 *
 * Computes USD usage cost from LLM/image/voice usage using raw provider costs
 * plus a flat MARKUP_MULTIPLIER (Cursor-style pricing).
 *
 * `rawUsd` is the provider list-price cost; `billedUsd` is what we charge the
 * workspace. There are no per-call minimums.
 *
 * Model costs (per 1M tokens) come from `@shogo/model-catalog` MODEL_DOLLAR_COSTS.
 */

import {
  getModelTier as catalogGetModelTier,
  getModelBillingModel,
  resolveAgentModeDefault,
  MODEL_DOLLAR_COSTS,
  calculateDollarCost,
  type ModelTier,
  type AgentMode,
  type BillingModel,
} from '@shogo/model-catalog'

export type { ModelTier, AgentMode }
export { MODEL_DOLLAR_COSTS, calculateDollarCost }

/** Flat markup applied to all raw provider costs (LLM, voice, images). */
export const MARKUP_MULTIPLIER = 1.20

export type ModelName = BillingModel

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

export interface UsageCostResult {
  /** Raw provider cost in USD (no markup). */
  rawUsd: number
  /** Marked-up cost charged to the workspace in USD. */
  billedUsd: number
}

/**
 * Calculate USD cost from separate input/output token counts.
 *
 * `inputTokens` should be non-cached input only. Pass `cachedInputTokens`
 * separately so they're billed at the discounted cache-read rate. Pass
 * `cacheWriteTokens` separately so they're billed at the cache-write rate.
 */
export function calculateUsageCost(
  inputTokens: number,
  outputTokens: number,
  modelOrAgentMode?: string,
  cachedInputTokens: number = 0,
  cacheWriteTokens: number = 0,
): UsageCostResult {
  const model = resolveModel(modelOrAgentMode)
  const costs = MODEL_DOLLAR_COSTS[model]
  const rawUsd =
    (inputTokens * costs.inputPerMillion / 1_000_000) +
    (cacheWriteTokens * costs.cacheWritePerMillion / 1_000_000) +
    (cachedInputTokens * costs.cachedInputPerMillion / 1_000_000) +
    (outputTokens * costs.outputPerMillion / 1_000_000)

  if (rawUsd === 0) return { rawUsd: 0, billedUsd: 0 }
  return { rawUsd, billedUsd: rawUsd * MARKUP_MULTIPLIER }
}

// =============================================================================
// Image Generation Usage Costs
// =============================================================================

/**
 * Raw provider costs per image in USD (approximate list price).
 * Derived from previous credit-based config at $0.10/credit.
 */
export const IMAGE_USD_CONFIG: Record<string, { base: number; hdMultiplier: number; largeSizeMultiplier: number }> = {
  'dall-e-3':       { base: 0.26, hdMultiplier: 2.0, largeSizeMultiplier: 1.5 },
  'dall-e-2':       { base: 0.13, hdMultiplier: 1.0, largeSizeMultiplier: 1.0 },
  'gpt-image-1':    { base: 0.39, hdMultiplier: 1.5, largeSizeMultiplier: 1.5 },
  'gpt-image-1.5':  { base: 0.39, hdMultiplier: 1.5, largeSizeMultiplier: 1.5 },
  'imagen-4':       { base: 0.20, hdMultiplier: 1.0, largeSizeMultiplier: 1.5 },
  'imagen-4-ultra': { base: 0.39, hdMultiplier: 1.0, largeSizeMultiplier: 1.5 },
  'imagen-4-fast':  { base: 0.13, hdMultiplier: 1.0, largeSizeMultiplier: 1.5 },
}

const LARGE_IMAGE_SIZES = new Set(['1792x1024', '1024x1792', '1536x1024', '1024x1536'])

/**
 * Calculate USD cost for image generation (flat per-image, not token-based).
 */
export function calculateImageUsageCost(
  model: string,
  quality: string = 'standard',
  size: string = '1024x1024',
): UsageCostResult {
  const config = IMAGE_USD_CONFIG[model] || IMAGE_USD_CONFIG['dall-e-3']
  let rawUsd = config.base

  if (quality === 'hd' || quality === 'high') {
    rawUsd *= config.hdMultiplier
  }

  if (LARGE_IMAGE_SIZES.has(size)) {
    rawUsd *= config.largeSizeMultiplier
  }

  return { rawUsd, billedUsd: rawUsd * MARKUP_MULTIPLIER }
}
