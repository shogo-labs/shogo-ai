// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `createBridgeClientTools(bridge)` — the single place the translator's
 * client tool (`send_to_chat`) is implemented against the `ChatBridge`.
 *
 * Consumed by:
 *   - `useVoiceConversation({ clientTools })` (ElevenLabs path)
 *   - the AI-SDK `useChat` tool handler inside `useTranslatorChat`
 *     (text path)
 *
 * Both paths call tools by name with a JSON-ish params object and expect a
 * short string result, so a single shape works for both.
 */

import type { ChatBridgeApi } from './ChatBridgeContext'

export type BridgeToolName = 'send_to_chat'
export type BridgeToolFn = (params: Record<string, unknown>) => string

export interface BridgeClientTools {
  send_to_chat: BridgeToolFn
}

/**
 * Produce the bridge-backed client tool. It is synchronous — the underlying
 * bridge call is a fire-and-forget UI operation that completes long before the
 * translator's next turn.
 */
export function createBridgeClientTools(bridge: ChatBridgeApi): BridgeClientTools {
  return {
    send_to_chat: (params) => {
      const text =
        typeof params.text === 'string' ? params.text.trim() : ''
      if (!text) return 'Error: missing text.'
      bridge.send(text)
      return 'Sent.'
    },
  }
}
