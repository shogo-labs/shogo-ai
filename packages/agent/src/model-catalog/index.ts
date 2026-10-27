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
  VIDEO_MODEL_CATALOG,
  MUSIC_MODEL_CATALOG,
  HIGGSFIELD_LEGACY_MODEL_ALIASES,
  AUTO_MODEL_ID,
  OPENROUTER_MODEL_PREFIX,
  type ModelEntry,
  type ImageModelEntry,
  type ImageModelCapabilities,
  type ModelOptionField,
  type VideoModelEntry,
  type MusicModelEntry,
  type ModelId,
  type ImageModelId,
  type VideoModelId,
  type MusicModelId,
  type Provider,
  type ImageProvider,
  type VideoProvider,
  type MusicProvider,
  type ModelTier,
  type ModelFamily,
  type ModelGeneration,
  type ModelKind,
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
  setAutoTierOverrides,
  getAutoTierOverrides,
  type AutoTier,
} from './aliases'

export {
  resolveModelId,
  resolveMediaModelId,
  getModelEntry,
  getImageModelEntry,
  getVideoModelEntry,
  getMusicModelEntry,
  getModelDisplayName,
  getModelShortDisplayName,
  inferProviderFromModel,
  getModelTier,
  getModelBillingModel,
  getModelFamily,
  getMaxOutputTokens,
  getContextWindowTokens,
  modelSupportsAudioInput,
  getModelKind,
  isLiveModel,
  calculateLiveSessionCost,
  getAvailableModels,
  getModelsByProvider,
  getProviderLabel,
  isAutoModel,
  isOpenRouterModel,
  stripOpenRouterPrefix,
  MODEL_DOLLAR_COSTS,
  calculateDollarCost,
  getSubagentOrchestrationReliability,
  type AvailableModelFilter,
  type CapabilityRating,
} from './helpers'

export { ADAPTIVE_THINKING_MODEL_MARKERS, supportsAdaptiveThinking } from './thinking'

export {
  endpointsOf,
  mediaOption,
  mergeModelOptions,
  optionsForEndpoint,
} from './media-options'

export {
  registerDynamicModels,
  rememberProviderHint,
  getDynamicModel,
  isAnthropicBacked,
  parseDynamicModelsEnv,
  clearDynamicModels,
  type DynamicModelEntry,
} from './dynamic-models'
