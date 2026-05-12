// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `useShogoChat` (native) — zero-config text-chat hook for Expo / React
 * Native pod apps.
 *
 * Mirrors the web counterpart in
 * [packages/sdk/src/voice/react/useShogoChat.ts] — same options, same
 * result shape — so a pod that already drives the web chat panel can
 * swap its import path from `@shogo-ai/sdk/voice/react` to
 * `@shogo-ai/sdk/voice/native` and keep the rest of its code unchanged.
 *
 * Defaults applied here:
 *
 *   - `api: '/api/chat/turn'`
 *   - `fetchCredentials: 'include'` — RN apps are always cross-origin
 *     to the Shogo API, so `same-origin` (the web default) makes no
 *     sense; `include` carries any cookies the consumer's auth flow
 *     stored in the native cookie jar.
 *
 * For external SDK consumers using a Shogo API key, drive
 * `useChatConversation({ shogoApiKey, projectId, ... })` directly —
 * the bearer path defaults to `'omit'` automatically.
 *
 * @experimental V1 surface — shape may evolve before promotion.
 */

import {
  useChatConversation,
  type UseChatConversationOptions,
  type UseChatConversationResult,
} from './useChatConversation.js'

export type UseShogoChatOptions = Partial<UseChatConversationOptions>

export function useShogoChat(
  opts: UseShogoChatOptions = {},
): UseChatConversationResult {
  return useChatConversation({
    api: opts.api ?? '/api/chat/turn',
    fetchCredentials: opts.fetchCredentials ?? 'include',
    ...opts,
  })
}
