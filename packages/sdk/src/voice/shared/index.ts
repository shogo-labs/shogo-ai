// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Internal-only barrel for the platform-agnostic voice helpers shared
 * between `voice/react` (web) and `voice/native` (Expo / RN).
 *
 * Not part of the public package surface — consumers should import
 * from `@shogo-ai/sdk/voice/react` or `@shogo-ai/sdk/voice/native`.
 */

export { createPostJson, type PostJson, type PostJsonConfig } from './postJson.js'

export {
  createMemoryAddTool,
  createMemoryContextInjector,
  type ClientToolFn,
  type CreateMemoryAddToolOptions,
  type CreateMemoryContextInjectorOptions,
  type MemoryContextInjector,
} from './memory.js'

export {
  createTranscriptDisconnectHandler,
  appendTranscriptLine,
  type AppendTranscriptLineOptions,
  type CreateTranscriptDisconnectHandlerOptions,
  type TranscriptCallback,
} from './transcript.js'

export {
  buildSessionPayload,
  fetchSignedUrl,
  withProjectId,
  type BuildSessionPayloadOptions,
  type FetchSignedUrlOptions,
  type SignedUrlResponse,
} from './sessionPayload.js'

export type {
  BaseVoiceConversationOptions,
  BaseVoiceConversationResult,
} from './types.js'
