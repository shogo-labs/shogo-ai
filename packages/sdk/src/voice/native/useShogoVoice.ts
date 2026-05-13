// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `useShogoVoice` (native) — zero-config voice hook for Expo / React
 * Native pod apps.
 *
 * Mirrors the web counterpart in
 * [packages/sdk/src/voice/react/useShogoVoice.ts] — same options, same
 * result shape — so a pod that already drives the web sphere can swap
 * its import path from `@shogo-ai/sdk/voice/react` to
 * `@shogo-ai/sdk/voice/native` and keep the rest of its code unchanged.
 *
 * Defaults applied here:
 *
 *   - `characterName: 'Shogo'`
 *   - `signedUrlPath: '/api/voice/signed-url'`
 *   - `fetchCredentials: 'include'` — RN apps are always cross-origin
 *     to the Shogo API, so `same-origin` (the web default) makes no
 *     sense; `include` carries any cookies the consumer's auth flow
 *     stored in the native cookie jar.
 *
 * Provider requirement
 * --------------------
 * Mount `<ShogoVoiceProvider>` near the root of your app (it wraps
 * `@elevenlabs/react-native`'s `ConversationProvider`). Without it
 * the underlying `useRegisterCallbacks` throws:
 *
 *     useRegisterCallbacks must be used within a ConversationProvider
 *
 * Just importing `@elevenlabs/react-native` (which `ShogoVoiceProvider`
 * does for you) is also what wires up the WebRTC polyfills and the
 * native AudioSession setup strategy, so don't lazy-import the
 * provider — keep it in the tree from app start.
 *
 * @example
 * ```tsx
 * import {
 *   ShogoVoiceProvider,
 *   useShogoVoice,
 * } from '@shogo-ai/sdk/voice/native'
 *
 * function VoiceButton() {
 *   const { start, end, status } = useShogoVoice()
 *   const active = status === 'connected' || status === 'connecting'
 *   return (
 *     <Pressable onPress={active ? end : start}>
 *       <Text>{active ? 'End call' : 'Talk to Shogo'}</Text>
 *     </Pressable>
 *   )
 * }
 *
 * export default function App() {
 *   return (
 *     <ShogoVoiceProvider>
 *       <VoiceButton />
 *     </ShogoVoiceProvider>
 *   )
 * }
 * ```
 *
 * Named secondary agents
 * ----------------------
 * Same as on web: declare extra agents in `shogo.config.json#agents`,
 * run `bunx shogo deploy`, then pass `agentName` to drive a specific
 * persona. `useShogoVoice({ agentName })` and `useShogoChat({
 * agentName })` resolve to the same `ProjectAgent` row.
 *
 * Per-user dynamic variables
 * --------------------------
 * Pass `dynamicVariables: { user_display_name, relationship_stage }`
 * (or any keys the agent prompt references) to surface per-user
 * fields from your local `Companion` row to ElevenLabs at session
 * start. The SDK's built-ins (`character_name`, `user_context`,
 * `conversation_id`) always win on collision.
 */

import {
  useVoiceConversation,
  type UseVoiceConversationOptions,
  type UseVoiceConversationResult,
} from './useVoiceConversation.js'

export type UseShogoVoiceOptions = Partial<UseVoiceConversationOptions>

export function useShogoVoice(
  opts: UseShogoVoiceOptions = {},
): UseVoiceConversationResult {
  return useVoiceConversation({
    characterName: opts.characterName ?? 'Shogo',
    signedUrlPath: opts.signedUrlPath ?? '/api/voice/signed-url',
    fetchCredentials: opts.fetchCredentials ?? 'include',
    ...opts,
  })
}
