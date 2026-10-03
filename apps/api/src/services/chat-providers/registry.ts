// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/** External chat providers by kind. Providers register at startup; tests swap in fakes. */

import type { ExternalChatProvider } from '../chat-mode'
import type { ChatProvider } from './types'

const providers = new Map<ExternalChatProvider, ChatProvider>()

export function registerChatProvider(provider: ChatProvider): () => void {
  const previous = providers.get(provider.kind)
  providers.set(provider.kind, provider)
  return () => {
    if (previous) providers.set(provider.kind, previous)
    else providers.delete(provider.kind)
  }
}

export function getChatProvider(kind: string | null | undefined): ChatProvider | null {
  if (!kind || kind === 'shogo') return null
  return providers.get(kind as ExternalChatProvider) ?? null
}

export function _resetChatProvidersForTests(): void {
  providers.clear()
}
