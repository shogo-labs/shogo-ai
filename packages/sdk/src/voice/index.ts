// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * @shogo-ai/sdk/voice
 *
 * ElevenLabs convai + TTS integration for Shogo apps. This entry point is
 * framework-agnostic and safe to import from the browser — it's just pure
 * helpers, types, and a `fetch`-based REST client.
 *
 * - Mount server handlers from `@shogo-ai/sdk/voice/server`.
 * - Use the React hook from `@shogo-ai/sdk/voice/react`.
 *
 * @example
 * ```ts
 * import { ElevenLabsClient, stripAudioTags, AUDIO_TAGS } from '@shogo-ai/sdk/voice'
 *
 * const el = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY! })
 * const agentId = await el.createAgent({ ... })
 * ```
 */

export {
  AUDIO_TAGS,
  AUDIO_TAG_GROUPS,
  DEFAULT_ALLOWED_TAGS,
  DEFAULT_VOICE_SETTINGS,
  EXPRESSIVITY_BLOCK_CLOSE,
  EXPRESSIVITY_BLOCK_OPEN,
  EXPRESSIVITY_OPTIONS,
  buildPreviewLine,
  composeExpressivityBlock,
  normalizeAudioTags,
  normalizeExpressivity,
  normalizeVoiceSettings,
  readAudioTags,
  readExpressivity,
  readVoiceSettings,
  stripAudioTags,
  stripExpressivityBlock,
  type AudioTag,
  type AudioTagGroup,
  type Expressivity,
  type VoiceSettings,
} from './audioTags.js'

export {
  DEFAULT_MEMORY_BLOCK,
  composeAgentPrompt,
  extractBasePrompt,
  stripMemoryBlock,
  type ComposeAgentPromptOptions,
} from './prompt.js'

export {
  CONVAI_SUPPORTED_TTS_MODELS,
  CONVAI_TTS_MODEL_FALLBACK,
  DEFAULT_ELEVENLABS_BASE_URL,
  ElevenLabsApiError,
  ElevenLabsClient,
  MEMORY_CLIENT_TOOLS,
  resolveConvaiTtsModel,
  type ConvaiClientTool,
  type CreateAgentParams,
  type ElevenLabsClientConfig,
  type PatchAgentParams,
  type TextToSpeechParams,
} from './elevenlabs.js'

export type {
  Companion,
  CompanionStore,
  CreateCompanionBody,
  PatchCompanionBody,
  TtsPreviewBody,
  VoiceMemoryStore,
  VoiceUser,
} from './types.js'
