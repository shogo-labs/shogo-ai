// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useTranslatorChat — text modality for the Shogo Mode translator.
 *
 * Thin wrapper around `@ai-sdk/react`'s `useChat`, pointed at the
 * `/api/voice/translator/chat` endpoint on `apps/api`. The server
 * declares the translator's two tools (`send_to_chat`, `set_mode`)
 * WITHOUT execute functions, so every tool call is streamed to the
 * client as a `tool-call` UI part and we resolve it here by running
 * the matching `BridgeClientTools` function and reporting the result
 * back via `addToolOutput`.
 *
 * The result: the same persona that the voice agent uses can also be
 * driven by text, with identical client-side effects on the ChatBridge.
 */

import { Platform } from 'react-native'
import { useMemo, useRef } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { API_URL } from '../../lib/api'
import type { BridgeClientTools, BridgeToolName } from './bridgeClientTools'

export interface UseTranslatorChatOptions {
  /**
   * Bridge-backed client tools. Must include `send_to_chat` and `set_mode`.
   * Typically produced via `createBridgeClientTools(bridge)`.
   */
  clientTools: BridgeClientTools
  /**
   * Optional override for the translator chat endpoint. Defaults to
   * `${API_URL}/api/voice/translator/chat`.
   */
  api?: string
  /**
   * Chat id — pass a stable value to preserve conversation state across
   * renders. Defaults to a module-scoped constant so the translator
   * thread is shared for the session.
   */
  id?: string
}

const DEFAULT_CHAT_ID = 'shogo-mode-translator'

export function useTranslatorChat({
  clientTools,
  api,
  id = DEFAULT_CHAT_ID,
}: UseTranslatorChatOptions) {
  const endpoint =
    api || `${API_URL ?? ''}/api/voice/translator/chat`

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: endpoint,
        credentials: Platform.OS === 'web' ? 'include' : 'omit',
      }),
    [endpoint],
  )

  // `useChat` returns an object whose `addToolOutput` we call from inside
  // `onToolCall`. But `onToolCall` is defined before `useChat` has finished
  // building the return value, so we reach back through a ref. Capturing
  // `clientTools` in a ref likewise keeps the callback stable if the caller
  // recreates the map on every render.
  const chatRef = useRef<ReturnType<typeof useChat> | null>(null)
  const toolsRef = useRef<BridgeClientTools>(clientTools)
  toolsRef.current = clientTools

  const chat = useChat({
    id,
    transport,
    async onToolCall({ toolCall }) {
      const name = toolCall.toolName as BridgeToolName
      const tools = toolsRef.current
      const fn = tools[name]
      const current = chatRef.current
      if (!current) return

      if (!fn) {
        await current.addToolOutput({
          state: 'output-error',
          tool: name,
          toolCallId: toolCall.toolCallId,
          errorText: `Unknown translator tool: ${String(name)}`,
        })
        return
      }

      try {
        const params =
          typeof toolCall.input === 'object' && toolCall.input !== null
            ? (toolCall.input as Record<string, unknown>)
            : {}
        const output = fn(params)
        await current.addToolOutput({
          tool: name,
          toolCallId: toolCall.toolCallId,
          output,
        })
      } catch (err: any) {
        await current.addToolOutput({
          state: 'output-error',
          tool: name,
          toolCallId: toolCall.toolCallId,
          errorText: err?.message ?? String(err),
        })
      }
    },
    onError(err) {
      console.warn('[useTranslatorChat] chat error:', err?.message || err)
    },
  })

  chatRef.current = chat
  return chat
}
