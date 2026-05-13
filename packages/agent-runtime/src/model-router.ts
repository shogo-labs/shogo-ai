// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Re-export shim. Canonical implementation lives in the MIT-licensed SDK
// at @shogo-ai/sdk/model-router (which carries its own
// routing-thresholds.json).
export {
  AUTO_MODEL_ID,
  getRoutingConfig,
  setRoutingConfig,
  classifySpawnTask,
  selectModelForSpawn,
  escalateModel,
  buildAutoTierMap,
  buildModelTierMap,
  formatRoutingLog,
} from '@shogo-ai/sdk/model-router'
export type {
  RoutingConfig,
  ComplexityTier,
  RoutingDecision,
  SpawnClassificationInput,
  ModelTierMap,
  ModelRouterOptions,
} from '@shogo-ai/sdk/model-router'
