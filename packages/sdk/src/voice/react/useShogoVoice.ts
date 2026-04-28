// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `useShogoVoice` — zero-config voice hook for generated pod apps.
 *
 * This is a thin alias around {@link useVoiceConversation} with the
 * pod-friendly defaults pre-applied:
 *
 *   - `characterName: 'Shogo'`
 *   - `signedUrlPath: '/api/voice/signed-url'` — served same-origin by
 *     the app's own Hono/Next route, which in turn proxies through the
 *     Shogo API via the pod's runtime token. No API key is read by the
 *     browser and no `Authorization` header is sent — the pod handles
 *     auth server-side.
 *   - `fetchCredentials: 'same-origin'`
 *
 * Provider requirement
 * --------------------
 * `@elevenlabs/react` ≥ 1.1 requires every `useConversation` caller —
 * which includes this hook — to live under a `<ConversationProvider>`
 * ancestor. The SDK re-exports that provider as `<ShogoVoiceProvider>`
 * so consumer apps don't have to import from `@elevenlabs/react`
 * directly. Without the provider you'll get:
 *
 *     useRegisterCallbacks must be used within a ConversationProvider
 *
 * Mount the provider once near the root of your app (NOT around each
 * component individually — sibling voice components only share session
 * state when they live under the same provider, so mounting separate
 * providers around `<VoiceButton>` and `<VoiceSphere>` will give them
 * disconnected sessions and the sphere will never visualize the
 * button's audio).
 *
 * For third-party / external embeds (not pod-native), keep using
 * `useVoiceConversation({ shogoApiKey, projectId })` — the bearer path
 * is the correct choice when same-origin fetch can't reach the Shogo
 * API directly. The provider requirement is the same.
 *
 * @example Minimum viable usage
 * ```tsx
 * import {
 *   ShogoVoiceProvider,
 *   useShogoVoice,
 * } from '@shogo-ai/sdk/voice/react'
 *
 * function VoiceButton() {
 *   const { start, end, status } = useShogoVoice()
 *   const active = status === 'connected' || status === 'connecting'
 *   return (
 *     <button onClick={active ? end : start}>
 *       {active ? 'End call' : 'Talk to Shogo'}
 *     </button>
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
    fetchCredentials: opts.fetchCredentials ?? 'same-origin',
    ...opts,
  })
}
