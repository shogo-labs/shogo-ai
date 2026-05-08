// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `useChatConversation` (native) — text-only sibling of
 * {@link useVoiceConversation}.
 *
 * Mirrors the web counterpart in
 * [packages/sdk/src/voice/react/useChatConversation.ts] — same options,
 * same result shape — so a pod that already drives the web chat panel
 * can swap its import path from `@shogo-ai/sdk/voice/react` to
 * `@shogo-ai/sdk/voice/native` and keep the rest of its code unchanged.
 *
 * Differences from the web implementation:
 *
 *   - Default `fetchCredentials` flips from `'same-origin'` (web) to
 *     `'omit'` when `shogoApiKey` is set, or `'include'` otherwise.
 *     RN apps are always cross-origin to the backend, so `same-origin`
 *     makes no sense; `include` carries any cookies the consumer's
 *     auth flow stored in the native cookie jar.
 *   - No DOM hooks. `@ai-sdk/react` is platform-agnostic; the import
 *     surface used here (`useChat`, `DefaultChatTransport`) runs the
 *     same way on RN/Hermes/JSC.
 *
 * Requires the host app to install `@ai-sdk/react` and `ai`. Both are
 * optional peer deps of `@shogo-ai/sdk`.
 *
 * @experimental V1 surface — shape may evolve before promotion.
 */

import { useCallback, useMemo, useRef } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import {
  type BaseChatConversationOptions,
  type BaseChatConversationResult,
  type ChatClientToolFn,
  type ChatConversationStatus,
  type ChatToolDescriptor,
} from '../shared/chatTypes.js'
import { appendChatQuery } from '../shared/chatUrl.js'

export type UseChatConversationOptions = BaseChatConversationOptions
export type UseChatConversationResult = BaseChatConversationResult

const DEFAULT_API_PATH = '/api/chat/turn'
const DEFAULT_CHAT_ID = 'shogo-chat'

function syntheticId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function useChatConversation(
  options: UseChatConversationOptions = {},
): UseChatConversationResult {
  const {
    api = DEFAULT_API_PATH,
    shogoApiKey,
    projectId,
    agentName,
    conversationId,
    initialMessages,
    clientTools = {},
    tools,
    // RN fetch has no real "same-origin" — apps are always cross-
    // origin to the backend. Default to `'omit'` for the bearer
    // path and `'include'` for the cookie path so the cookie jar
    // gets used when the consumer set up auth that way.
    fetchCredentials = shogoApiKey ? 'omit' : 'include',
    id,
    onError,
    dynamicVariables,
  } = options

  const resolvedApi = useMemo(
    () => appendChatQuery(api, { projectId, conversationId, agentName }),
    [api, projectId, conversationId, agentName],
  )

  const headers = useMemo(() => {
    const h: Record<string, string> = {}
    if (shogoApiKey) h.authorization = `Bearer ${shogoApiKey}`
    return h
  }, [shogoApiKey])

  const body = useMemo(() => {
    const b: Record<string, unknown> = {}
    if (projectId) b.projectId = projectId
    if (agentName) b.agentName = agentName
    if (conversationId) b.conversationId = conversationId
    if (tools && tools.length > 0) b.tools = tools
    if (dynamicVariables && Object.keys(dynamicVariables).length > 0) {
      b.dynamicVariables = dynamicVariables
    }
    return b
  }, [projectId, agentName, conversationId, tools, dynamicVariables])

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: resolvedApi,
        credentials: fetchCredentials,
        headers,
        body,
      }),
    [resolvedApi, fetchCredentials, headers, body],
  )

  const toolsRef = useRef<Record<string, ChatClientToolFn>>(clientTools)
  toolsRef.current = clientTools
  const chatRef = useRef<ReturnType<typeof useChat> | null>(null)

  const resolvedId = id ?? (conversationId ? `shogo-chat:${conversationId}` : DEFAULT_CHAT_ID)

  const chat = useChat({
    id: resolvedId,
    transport,
    messages: initialMessages,
    async onToolCall({ toolCall }) {
      const name = toolCall.toolName
      const fn = toolsRef.current[name]
      const current = chatRef.current
      if (!current) return
      if (!fn) {
        await current.addToolOutput({
          state: 'output-error',
          tool: name,
          toolCallId: toolCall.toolCallId,
          errorText: `Unknown chat tool: ${String(name)}`,
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
      onError?.(err)
    },
  })

  chatRef.current = chat

  const sendMessage = useCallback(
    async (text: string): Promise<void> => {
      if (!text.trim()) return
      await chatRef.current?.sendMessage({ text })
    },
    [],
  )

  const setMessages = useCallback((messages: UIMessage[]) => {
    chatRef.current?.setMessages?.(messages as never)
  }, [])

  const appendAssistantMessage = useCallback((text: string) => {
    const next: UIMessage = {
      id: syntheticId('synthetic-assistant'),
      role: 'assistant',
      parts: [{ type: 'text', text }],
    } as UIMessage
    const current = chatRef.current
    if (!current) return
    const nextList = [...(current.messages as UIMessage[]), next]
    current.setMessages?.(nextList as never)
  }, [])

  const appendUserMessage = useCallback((text: string) => {
    const next: UIMessage = {
      id: syntheticId('synthetic-user'),
      role: 'user',
      parts: [{ type: 'text', text }],
    } as UIMessage
    const current = chatRef.current
    if (!current) return
    const nextList = [...(current.messages as UIMessage[]), next]
    current.setMessages?.(nextList as never)
  }, [])

  const status = chat.status as ChatConversationStatus

  return {
    messages: chat.messages as UIMessage[],
    sendMessage,
    setMessages,
    appendAssistantMessage,
    appendUserMessage,
    status,
    conversationId: conversationId ?? null,
  }
}

export type { ChatClientToolFn, ChatConversationStatus, ChatToolDescriptor }
