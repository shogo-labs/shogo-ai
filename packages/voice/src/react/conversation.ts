// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Voice hooks and provider without the Three.js visualizations.
 * Import `@shogo-ai/voice/react/visuals` (or the sdk shim) for
 * OrganicParticles / OrganicSphere so the app entry does not load `three`.
 */
export {
  useVoiceConversation,
  type UseVoiceConversationOptions,
  type UseVoiceConversationResult,
} from './useVoiceConversation.js'

export {
  useLiveVoiceConversation,
  type LiveVoiceSessionResponse,
  type LiveTranscriptTurn,
  type LiveDelegationRequest,
  type UseLiveVoiceConversationOptions,
  type UseLiveVoiceConversationResult,
} from './useLiveVoiceConversation.js'

export {
  ShogoVoiceProvider,
  type ShogoVoiceProviderProps,
} from './ShogoVoiceProvider.js'
