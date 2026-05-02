// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `ShogoVoiceProvider` (native) — root provider that every
 * `useShogoVoice` / `useVoiceConversation` caller from
 * `@shogo-ai/sdk/voice/native` needs to live under.
 *
 * Mirrors the web provider in [packages/sdk/src/voice/react/ShogoVoiceProvider.tsx]
 * but wraps `@elevenlabs/react-native`'s `ConversationProvider` instead
 * of `@elevenlabs/react`'s. Importantly, just importing
 * `@elevenlabs/react-native` runs its module side-effects:
 *
 *   - `registerGlobals()` from `@livekit/react-native` polyfills the
 *     WebRTC globals the underlying ElevenLabs client expects.
 *   - `setSetupStrategy(reactNativeSessionSetup)` swaps the voice
 *     session bootstrapper to start a native iOS/Android AudioSession
 *     before opening the LiveKit connection.
 *
 * That's why this provider is the single recommended import path on
 * native — pulling in `@elevenlabs/react-native` somewhere near the
 * root of the app is what makes the native voice path work at all.
 */

import * as React from 'react'
import { ConversationProvider as ElevenLabsConversationProvider } from '@elevenlabs/react-native'

export interface ShogoVoiceProviderProps {
  children: React.ReactNode
  /**
   * Optional default agent id forwarded to `ConversationProvider`.
   * Omit if your app passes `signedUrl` per-session via
   * `useVoiceConversation` (the recommended Shogo flow).
   */
  agentId?: string
}

export function ShogoVoiceProvider(
  props: ShogoVoiceProviderProps,
): React.ReactElement {
  const { agentId, children } = props
  return (
    <ElevenLabsConversationProvider agentId={agentId as never}>
      {children}
    </ElevenLabsConversationProvider>
  )
}

export default ShogoVoiceProvider
