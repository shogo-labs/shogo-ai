// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

export {
  MODEL_CATALOG,
  IMAGE_MODEL_CATALOG,
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
  MODEL_DOLLAR_COSTS,
  calculateDollarCost,
  type AvailableModelFilter,
} from './helpers'
