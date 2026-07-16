// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Re-export shim. Canonical implementation lives in the MIT-licensed SDK
// at @shogo-ai/sdk/agent-loop. `ToolContext` is intentionally NOT
// re-exported here — it's an agent-runtime internal type that stays in
// `./gateway-tools`. The handful of internal call sites import it from
// there directly.
export { runAgentLoop, classifyRetryability, stripStreamErrorMarker } from '@shogo-ai/sdk/agent-loop'
export type {
  LoopDetectorConfig,
  LoopDetectorResult,
  OrchestrationOptions,
  ThinkingLevel,
  AgentLoopOptions,
  ToolCallRecord,
  AgentLoopResult,
  RetryClassification,
  RetryReason,
} from '@shogo-ai/sdk/agent-loop'
