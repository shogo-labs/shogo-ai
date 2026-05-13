// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Re-export shim. Canonical implementation lives in the MIT-licensed SDK
// at @shogo-ai/sdk/tool-orchestration.
export {
  CONCURRENT_SAFE_TOOLS,
  isConcurrencySafe,
  Semaphore,
  WriteMutex,
  partitionToolCalls,
  wrapToolsWithOrchestration,
} from '@shogo-ai/sdk/tool-orchestration'
export type {
  ToolBatch,
  OrchestrationOptions,
  OrchestrationState,
} from '@shogo-ai/sdk/tool-orchestration'
