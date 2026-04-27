// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useTranslatorChat — text modality for the Shogo Mode translator.
 *
 * Thin wrapper around `@ai-sdk/react`'s `useChat`, pointed at the
 * per-session translator endpoint on `apps/api`. The server declares
 * the translator's tools WITHOUT execute functions, so every tool call
 * is streamed to the client as a `tool-call` UI part and we resolve it
 * here by running the matching client tool and reporting the result
 * back via `addToolOutput`.
 *
 * The result: the same persona that the voice agent uses can also be
 * driven by text, with identical client-side effects on the ChatBridge.
 *
 * Persistence (server-authoritative)
 * ----------------------------------
 * The client never writes to the `chat_messages` table directly.
 *
 *   - On mount (or when `chatSessionId` changes), the hook fetches all
 *     Shogo `shogo-text` rows for the session via
 *     `GET /api/chat-messages?sessionId=...&agent=voice` and applies
 *     them via `chat.setMessages(...)` so the AI-SDK thread is
 *     hydrated.
 *
 *   - On every turn, the POST target is
 *     `/api/voice/translator/chat/:chatSessionId`. The route handler
 *     upserts both the incoming user UIMessage and the final assistant
 *     UIMessage as `ChatMessage` rows tagged `agent="voice"` with a
 *     `{ kind: 'shogo-text', uiParts: ... }` envelope in `parts`. This
 *     keeps id-level idempotency: a retry of the same stream upserts
 *     the same row.
 *
 * If `chatSessionId` is `null`, the hook still works in-memory but does
 * no hydration and has no backing store — useful for transient contexts
 * where no ChatSession has been created yet.
 */

import { Platform } from 'react-native'
import { useEffect, useMemo, useRef } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { API_URL } from '../../lib/api'
import { loadShogoMessages, type ShogoMessageRow } from './shogoMessages'

/**
 * Minimal shape that `useTranslatorChat` expects from its client tools.
 * Deliberately loose so consumers can mix in additional tools (e.g.
 * `get_recent_activity`) alongside the bridge-backed ones.
 */
export type TranslatorClientTools = Record<
  string,
  (params: Record<string, unknown>) => string | Promise<string>
>

export interface UseTranslatorChatOptions {
  /**
   * Client-side tool implementations. Must at minimum include
   * `send_to_chat` and `set_mode`; may include others (e.g.
   * `get_recent_activity`).
   */
  clientTools: TranslatorClientTools
  /**
   * ChatSession id that scopes the Shogo thread. Used for both the
   * server POST URL (`/api/voice/translator/chat/:chatSessionId`) and
   * for hydrating `shogo-text` rows on mount. `null` disables
   * persistence.
   */
  chatSessionId: string | null
  /**
   * Optional override for the translator chat endpoint base. Defaults
   * to `${API_URL}/api/voice/translator/chat`. The `chatSessionId`
   * path segment is appended automatically.
   */
  api?: string
  /**
   * Chat id — pass a stable value to preserve conversation state across
   * renders. Defaults to a per-session id when `chatSessionId` is
   * known, falling back to a module-scoped constant otherwise.
   */
  id?: string
}

const DEFAULT_CHAT_ID = 'shogo-mode-translator'

/**
 * Rebuild an AI-SDK `UIMessage` from a persisted row. Falls back to a
 * single text part when the envelope didn't carry `uiParts` (e.g. row
 * written before the envelope format existed, or by the transcript
 * endpoint).
 */
function rowToUIMessage(row: ShogoMessageRow): UIMessage | null {
  if (row.role !== 'user' && row.role !== 'assistant') return null
  const envelope = row.envelope
  const uiParts =
    envelope &&
    envelope.kind === 'shogo-text' &&
    Array.isArray(envelope.uiParts)
      ? (envelope.uiParts as UIMessage['parts'])
      : null
  if (uiParts && uiParts.length > 0) {
    return {
      id: row.id,
      role: row.role,
      parts: uiParts,
    } as UIMessage
  }
  return {
    id: row.id,
    role: row.role,
    parts: [{ type: 'text', text: row.content }],
  } as UIMessage
}

export function useTranslatorChat({
  clientTools,
  chatSessionId,
  api,
  id,
}: UseTranslatorChatOptions) {
  const endpointBase = api || `${API_URL ?? ''}/api/voice/translator/chat`
  const endpoint = chatSessionId
    ? `${endpointBase}/${encodeURIComponent(chatSessionId)}`
    : endpointBase

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
  const toolsRef = useRef<TranslatorClientTools>(clientTools)
  toolsRef.current = clientTools

  const resolvedId = id ?? (chatSessionId ? `shogo:${chatSessionId}` : DEFAULT_CHAT_ID)

  const chat = useChat({
    id: resolvedId,
    transport,
    async onToolCall({ toolCall }) {
      const name = toolCall.toolName
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
        const output = await fn(params)
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

  // -------------------------------------------------------------------
  // Hydrate from the server on mount (and whenever `chatSessionId`
  // changes). The server is the source of truth for `shogo-text` rows;
  // we make a single read call and seed `useChat`'s in-memory thread
  // with the result. No writes — the translator endpoint persists user
  // + assistant turns server-side during the stream.
  // -------------------------------------------------------------------
  const hydratedSessionRef = useRef<string | null>(null)

  useEffect(() => {
    if (!chatSessionId) {
      hydratedSessionRef.current = null
      return
    }
    if (hydratedSessionRef.current === chatSessionId) return
    hydratedSessionRef.current = chatSessionId

    const controller = new AbortController()
    ;(async () => {
      try {
        const rows = await loadShogoMessages(chatSessionId, {
          signal: controller.signal,
        })
        if (controller.signal.aborted) return
        const shogoTextRows = rows.filter(
          (r) => r.envelope?.kind === 'shogo-text',
        )
        const uiMessages = shogoTextRows
          .map(rowToUIMessage)
          .filter((m): m is UIMessage => !!m)
        chatRef.current?.setMessages?.(uiMessages as never)
      } catch (err: any) {
        if (err?.name === 'AbortError') return
        console.warn('[useTranslatorChat] hydrate failed:', err?.message || err)
      }
    })()

    return () => {
      controller.abort()
    }
  }, [chatSessionId])

  return chat
}
