// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Re-export shim. Canonical implementation lives in the MIT-licensed SDK
// at @shogo-ai/sdk/pi-adapter.
export {
  resolveModel,
  resolveApiKey,
  userMessage,
  userMessageWithImages,
  extractUserText,
  extractAssistantText,
  extractFinalText,
  countToolCalls,
  sumUsage,
  defaultConvertToLlm,
  buildTextResponse,
  buildToolUseResponse,
  createMockStreamFn,
} from '@shogo-ai/sdk/pi-adapter'
