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
 *
 * @example Named secondary agents
 * Declare additional agents in `shogo.config.json#agents`, run
 * `bunx shogo deploy`, then pick which one a component talks to via
 * `agentName`. Both `useShogoVoice({ agentName: 'architect' })` and
 * `useShogoChat({ agentName: 'architect' })` resolve to the SAME
 * `ProjectAgent` row, so voice + text can share one persona /
 * tool-allowlist.
 *
 * ```jsonc
 * // shogo.config.json
 * {
 *   "agents": {
 *     "architect": {
 *       "systemPrompt": "You design system architectures.",
 *       "tools": ["lookup_user"],
 *       "model": "claude-sonnet-4-5"
 *     },
 *     "narrator": {
 *       "systemPrompt": "You narrate system events out loud.",
 *       "voiceId": "voice_id_here",
 *       "firstMessage": "Hi, I'll narrate updates."
 *     }
 *   }
 * }
 * ```
 *
 * ```tsx
 * function NarratorButton() {
 *   const v = useShogoVoice({ agentName: 'narrator' })
 *   return <button onClick={v.start}>Start narration</button>
 * }
 * ```
 *
 * Tool contract: the manifest declares the tools the agent is allowed
 * to invoke — including the full `description` + JSON `inputSchema`
 * for each — and the consumer's React code provides the matching
 * handler implementations via `clientTools`. Manifest schemas win
 * server-side, so a `shogo deploy` is a single source of truth for
 * BOTH ElevenLabs (voice) AND `streamText` (chat).
 *
 * @example Per-user dynamic variables
 * Surface fields from your own `Companion` row to the agent prompt
 * via `dynamicVariables`. The values land in EL as
 * `dynamic_variables` and the agent prompt can reference them via
 * `{{user_display_name}}` etc. (assuming the variables are declared
 * on the agent in `dynamic_variable_placeholders` at deploy time).
 *
 * The SDK's built-ins (`character_name`, `user_context`,
 * `conversation_id`) always win on collision so you can't
 * accidentally override them.
 *
 * ```tsx
 * function NarratorButton() {
 *   const companion = useCompanion() // your store
 *   const v = useShogoVoice({
 *     agentName: 'narrator',
 *     dynamicVariables: {
 *       user_display_name: companion.userDisplayName,
 *       relationship_stage: companion.relationshipStage,
 *       greeting_token: companion.firstMessage ?? '',
 *     },
 *   })
 *   return <button onClick={v.start}>Start narration</button>
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
