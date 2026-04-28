// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `ShogoVoiceProvider` — root provider that every `useShogoVoice` /
 * `useVoiceConversation` caller needs to live under.
 *
 * Why this exists
 * ---------------
 * `@elevenlabs/react` ≥ 1.1 split `useConversation` into a
 * provider-backed API: every caller of the hook (and therefore every
 * caller of our `useVoiceConversation` / `useShogoVoice` wrapper) must
 * have a `<ConversationProvider>` somewhere above it in the tree.
 * Without it the underlying `useRegisterCallbacks` throws:
 *
 *   useRegisterCallbacks must be used within a ConversationProvider
 *
 * Re-exporting the provider here keeps consumer code free of a direct
 * `@elevenlabs/react` import — pods only ever import from
 * `@shogo-ai/sdk/voice/react`, which means we can swap providers (or
 * upgrade across breaking versions) without touching every app.
 *
 * Usage
 * -----
 * Wrap the SDK's voice-aware tree once, near the root of your app:
 *
 * ```tsx
 * import { ShogoVoiceProvider } from '@shogo-ai/sdk/voice/react'
 *
 * export default function Root({ children }: { children: React.ReactNode }) {
 *   return <ShogoVoiceProvider>{children}</ShogoVoiceProvider>
 * }
 * ```
 *
 * One provider is enough for an entire app — sibling components that
 * use the voice hook share the same underlying convai session context.
 * Mounting multiple providers is supported but isolates their
 * sessions, so do that intentionally (e.g. two completely separate
 * voice surfaces in one shell).
 */

import * as React from 'react'
import { ConversationProvider as ElevenLabsConversationProvider } from '@elevenlabs/react'

export interface ShogoVoiceProviderProps {
  children: React.ReactNode
}

export function ShogoVoiceProvider(
  props: ShogoVoiceProviderProps,
): React.ReactElement {
  return (
    <ElevenLabsConversationProvider>
      {props.children}
    </ElevenLabsConversationProvider>
  )
}

export default ShogoVoiceProvider
