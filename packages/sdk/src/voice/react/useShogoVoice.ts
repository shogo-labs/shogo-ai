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
 * Drop in anywhere: `const voice = useShogoVoice()` works inside a
 * generated pod app with no arguments.
 *
 * For third-party / external embeds (not pod-native), keep using
 * `useVoiceConversation({ shogoApiKey, projectId })` — the bearer path
 * is the correct choice when same-origin fetch can't reach the Shogo
 * API directly.
 *
 * @example Drop-in VoiceButton
 * ```tsx
 * import { useShogoVoice } from '@shogo-ai/sdk/voice/react'
 *
 * export function VoiceButton() {
 *   const { start, end, status } = useShogoVoice()
 *   const active = status === 'connected' || status === 'connecting'
 *   return (
 *     <button onClick={active ? end : start}>
 *       {active ? 'End call' : 'Talk to Shogo'}
 *     </button>
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
