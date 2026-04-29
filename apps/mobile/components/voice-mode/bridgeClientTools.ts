// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `createBridgeClientTools(bridge)` — the single place the translator's
 * two client tools (`send_to_chat`, `set_mode`) are implemented against
 * the `ChatBridge`.
 *
 * Consumed by:
 *   - `useVoiceConversation({ clientTools })` (ElevenLabs path)
 *   - the AI-SDK `useChat` tool handler inside `useTranslatorChat`
 *     (text path)
 *
 * Both paths call tools by name with a JSON-ish params object and expect a
 * short string result, so a single shape works for both.
 */

import type { ChatBridgeApi, ChatInteractionMode } from './ChatBridgeContext'

export type BridgeToolName = 'send_to_chat' | 'set_mode'
export type BridgeToolFn = (params: Record<string, unknown>) => string

export interface BridgeClientTools {
  send_to_chat: BridgeToolFn
  set_mode: BridgeToolFn
}

/**
 * Produce the two bridge-backed client tools. Tools are synchronous — the
 * underlying bridge calls are fire-and-forget UI operations that complete
 * long before the translator's next turn.
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
    set_mode: (params) => {
      const raw =
        typeof params.mode === 'string' ? params.mode.trim().toLowerCase() : ''
      if (raw !== 'agent' && raw !== 'plan' && raw !== 'ask') {
        return `Error: mode must be "agent", "plan", or "ask" (got ${JSON.stringify(params.mode)}).`
      }
      const mode = raw as ChatInteractionMode
      bridge.setMode(mode)
      if (mode === 'plan') return 'Switched to plan mode.'
      if (mode === 'ask') return 'Switched to ask mode.'
      return 'Switched to agent mode.'
    },
  }
}
