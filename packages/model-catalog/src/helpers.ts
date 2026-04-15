// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import {
  MODEL_CATALOG,
  IMAGE_MODEL_CATALOG,
  type ModelEntry,
  type ImageModelEntry,
  type ModelId,
  type Provider,
  type ModelTier,
  type ModelFamily,
  type ModelGeneration,
  type AgentMode,
  type BillingModel,
} from './models'
import { MODEL_ALIASES, resolveAgentModeDefault } from './aliases'

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a model string (alias, agent mode, or canonical ID) to a canonical
 * model ID. Returns the input unchanged if it's already canonical or unknown.
 */
export function resolveModelId(id: string): string {
  if (id in MODEL_CATALOG) return id
  if (id in MODEL_ALIASES) return MODEL_ALIASES[id]
  if (id === 'basic' || id === 'advanced') return resolveAgentModeDefault(id as AgentMode)
  return id
}

/**
 * Look up the full catalog entry for a model. Resolves aliases automatically.
 * Returns undefined for unknown models.
 */
export function getModelEntry(id: string): ModelEntry | undefined {
  const resolved = resolveModelId(id)
  return (MODEL_CATALOG as Record<string, ModelEntry>)[resolved]
}

/**
 * Look up the full catalog entry for an image model.
 * Falls back to prefix matching. Returns undefined for unknown models.
 */
export function getImageModelEntry(id: string): ImageModelEntry | undefined {
  if (id in IMAGE_MODEL_CATALOG) {
    return (IMAGE_MODEL_CATALOG as Record<string, ImageModelEntry>)[id]
  }
  for (const [key, entry] of Object.entries(IMAGE_MODEL_CATALOG)) {
    if (key.startsWith(id) || entry.apiModel.startsWith(id)) return entry
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Display names
// ---------------------------------------------------------------------------

/** Full display name, e.g. "Claude Sonnet 4.6". Falls back to the raw ID. */
export function getModelDisplayName(id: string): string {
  if (!id) return 'Unknown'
  const entry = getModelEntry(id)
  if (entry) return entry.displayName
  return id.length > 20 ? id.slice(0, 20) + '...' : id
}

/** Short display name for compact UIs, e.g. "Sonnet 4.6". Falls back to the raw ID. */
export function getModelShortDisplayName(id: string): string {
  if (!id) return 'Unknown'
  const entry = getModelEntry(id)
  if (entry) return entry.shortDisplayName
  return id.length > 20 ? id.slice(0, 20) + '...' : id
}

// ---------------------------------------------------------------------------
// Provider inference
// ---------------------------------------------------------------------------

/**
 * Infer the LLM provider from a model ID. Uses the catalog first, then
 * falls back to prefix heuristics for unknown model strings.
 */
export function inferProviderFromModel(modelId: string, fallback: string = 'anthropic'): string {
  if (modelId === 'basic') return 'anthropic'
  if (modelId === 'advanced') return 'anthropic'

  const entry = getModelEntry(modelId)
  if (entry) return entry.provider

  if (modelId.startsWith('gpt')) return 'openai'
  if (modelId.startsWith('claude')) return 'anthropic'
  if (modelId.startsWith('gemini')) return 'google'
  return fallback
}

// ---------------------------------------------------------------------------
// Tier & billing
// ---------------------------------------------------------------------------

/**
 * Get the billing tier for a model. Uses the catalog first, then falls back
 * to keyword heuristics for unknown models. Unknown models default to
 * 'standard' (fail-safe: blocks free users).
 */
export function getModelTier(id: string): ModelTier {
  const entry = getModelEntry(id)
  if (entry) return entry.tier

  const lower = id.toLowerCase()
  if (lower.includes('opus')) return 'premium'
  if (lower.includes('haiku') || lower.includes('nano') || lower.includes('mini')) return 'economy'
  return 'standard'
}

/**
 * Get the billing model bucket for a model (maps to dollar cost tables).
 * Falls back to 'sonnet' for unknown models.
 */
export function getModelBillingModel(id: string): BillingModel {
  const entry = getModelEntry(id)
  if (entry) return entry.billingModel
  return 'sonnet'
}

// ---------------------------------------------------------------------------
// Max output tokens
// ---------------------------------------------------------------------------

const DEFAULT_MAX_OUTPUT_TOKENS = 64_000

/**
 * Get the max output tokens for a model per official provider specs.
 * Falls back to 64k for unknown models.
 */
export function getMaxOutputTokens(id: string): number {
  const entry = getModelEntry(id)
  if (entry) return entry.maxOutputTokens
  return DEFAULT_MAX_OUTPUT_TOKENS
}

// ---------------------------------------------------------------------------
// Family (for UI color coding)
// ---------------------------------------------------------------------------

export function getModelFamily(id: string): ModelFamily {
  const entry = getModelEntry(id)
  if (entry) return entry.family

  const lower = id.toLowerCase()
  if (lower.includes('opus')) return 'opus'
  if (lower.includes('sonnet')) return 'sonnet'
  if (lower.includes('haiku')) return 'haiku'
  if (lower.startsWith('gpt')) return 'gpt'
  return 'other'
}

// ---------------------------------------------------------------------------
// Dollar cost calculation (per 1M tokens by billing-model bucket)
// ---------------------------------------------------------------------------

export const MODEL_DOLLAR_COSTS: Record<BillingModel, {
  inputPerMillion: number
  cacheWritePerMillion: number
  cachedInputPerMillion: number
  outputPerMillion: number
}> = {
  'gpt-5.4-nano': { inputPerMillion: 0.20, cacheWritePerMillion: 0.25, cachedInputPerMillion: 0.02, outputPerMillion: 1.25 },
  haiku:          { inputPerMillion: 0.80, cacheWritePerMillion: 1.00, cachedInputPerMillion: 0.08, outputPerMillion: 4.00 },
  'gpt-5.4-mini': { inputPerMillion: 0.75, cacheWritePerMillion: 0.9375, cachedInputPerMillion: 0.075, outputPerMillion: 4.40 },
  sonnet:         { inputPerMillion: 3.00, cacheWritePerMillion: 3.75, cachedInputPerMillion: 0.30, outputPerMillion: 15.00 },
  opus:           { inputPerMillion: 15.00, cacheWritePerMillion: 18.75, cachedInputPerMillion: 1.50, outputPerMillion: 75.00 },
}

/**
 * Calculate raw dollar cost from token counts and a model identifier.
 * Resolves the model to its billing bucket first.
 *
 * `inputTokens` = non-cached input. Pass cached/write counts separately.
 */
export function calculateDollarCost(
  modelOrAgentMode: string | undefined,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number = 0,
  cacheWriteTokens: number = 0,
): number {
  const billing = modelOrAgentMode ? getModelBillingModel(modelOrAgentMode) : 'sonnet'
  const costs = MODEL_DOLLAR_COSTS[billing] ?? MODEL_DOLLAR_COSTS.sonnet
  return (
    (inputTokens * costs.inputPerMillion / 1_000_000) +
    (cacheWriteTokens * costs.cacheWritePerMillion / 1_000_000) +
    (cachedInputTokens * costs.cachedInputPerMillion / 1_000_000) +
    (outputTokens * costs.outputPerMillion / 1_000_000)
  )
}

// ---------------------------------------------------------------------------
// Filtered model lists (for UI pickers)
// ---------------------------------------------------------------------------

export interface AvailableModelFilter {
  generation?: ModelGeneration
  provider?: Provider
  tier?: ModelTier
}

/**
 * Get a filtered list of models from the catalog. Defaults to current-generation
 * models suitable for UI pickers.
 */
export function getAvailableModels(filter: AvailableModelFilter = { generation: 'current' }): ModelEntry[] {
  return Object.values(MODEL_CATALOG).filter(entry => {
    if (filter.generation && entry.generation !== filter.generation) return false
    if (filter.provider && entry.provider !== filter.provider) return false
    if (filter.tier && entry.tier !== filter.tier) return false
    return true
  })
}

/**
 * Get current-generation models grouped by provider, suitable for UI display.
 */
export function getModelsByProvider(): Array<{ label: string; models: ModelEntry[] }> {
  const current = getAvailableModels({ generation: 'current' })
  const groups: Record<string, ModelEntry[]> = {}
  for (const entry of current) {
    const label = entry.provider === 'anthropic' ? 'Anthropic' : entry.provider === 'openai' ? 'OpenAI' : entry.provider
    if (!groups[label]) groups[label] = []
    groups[label].push(entry)
  }
  return Object.entries(groups).map(([label, models]) => ({ label, models }))
}
