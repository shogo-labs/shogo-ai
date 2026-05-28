// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `@shogo-ai/sdk/model-catalog`
 *
 * Single source of truth for LLM model IDs, display names, providers,
 * tiers, billing buckets, dollar costs, and aliases. Imported by the
 * agent runtime, the chat UI, and userland code that needs to render or
 * route by model.
 *
 * Lifted into the SDK from the standalone `@shogo/model-catalog`
 * package (was AGPL) under MIT. The original package is now a thin
 * shim that re-exports this module so existing imports of
 * `@shogo/model-catalog` continue to work without changes.
 */

export {
  MODEL_CATALOG,
  IMAGE_MODEL_CATALOG,
  AUTO_MODEL_ID,
  OPENROUTER_MODEL_PREFIX,
  type ModelEntry,
  type ImageModelEntry,
  type ModelId,
  type ImageModelId,
  type Provider,
  type ImageProvider,
  type ModelTier,
  type ModelFamily,
  type ModelGeneration,
  type BillingModel,
  type AgentMode,
  type ModelCapabilities,
  type CapabilityReliability,
} from './models'

export {
  MODEL_ALIASES,
  AGENT_MODE_DEFAULTS,
  setAgentModeOverrides,
  getAgentModeOverrides,
  resolveAgentModeDefault,
} from './aliases'

export {
  resolveModelId,
  getModelEntry,
  getImageModelEntry,
  getModelDisplayName,
  getModelShortDisplayName,
  inferProviderFromModel,
  getModelTier,
  getModelBillingModel,
  getModelFamily,
  getMaxOutputTokens,
  getAvailableModels,
  getModelsByProvider,
  isAutoModel,
  isOpenRouterModel,
  stripOpenRouterPrefix,
  MODEL_DOLLAR_COSTS,
  calculateDollarCost,
  getSubagentOrchestrationReliability,
  type AvailableModelFilter,
  type CapabilityRating,
} from './helpers'
