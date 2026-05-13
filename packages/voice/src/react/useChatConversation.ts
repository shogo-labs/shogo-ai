// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `useChatConversation` (web) — text-only sibling of
 * {@link useVoiceConversation}.
 *
 * Wraps `@ai-sdk/react`'s `useChat` hook, pointed at a Shogo streaming
 * chat endpoint (default `/api/chat/turn`). The same agent persona +
 * memory + project context the voice hook drives over an ElevenLabs
 * Convai websocket is reachable here over a plain HTTPS POST + SSE
 * stream — no microphone, no `getUserMedia`, no audio context.
 *
 * Why a sibling instead of a flag on `useVoiceConversation`: the wire
 * shapes are different enough (no signed URL, no audio frames, no
 * `firstMessage`/`characterName` dynamic variables, no `setMuted`)
 * that a single hook would have a surface area split-brain. The auth
 * surface (`shogoApiKey` + `projectId` or session cookie) is shared
 * verbatim, and `BaseChatConversationOptions.conversationId` lines up
 * with the new `BaseVoiceConversationResult.conversationId` so a
 * consumer can stitch a single logical conversation across both
 * transports — see `packages/sdk/README.md` §"Voice + text bridge".
 *
 * Streaming + tool-calls
 * ----------------------
 * The server declares any caller-registered tools WITHOUT an `execute`
 * function, so each tool call is streamed back to the client as a
 * `tool-call` UI part. The hook resolves it by running the matching
 * entry from `clientTools`, then forwards the result via
 * `addToolOutput`. The wire pattern matches the existing internal
 * `useTranslatorChat` (apps/mobile) — see that file for a longer
 * walk-through of the AI-SDK callback flow.
 *
 * Provider requirement
 * --------------------
 * No provider required. Unlike `useVoiceConversation`, this hook
 * doesn't depend on `@elevenlabs/react`'s `ConversationProvider`.
 *
 * Consumers should still mount `<ShogoVoiceProvider>` near the root
 * if they're ALSO using `useShogoVoice`; that's the voice-side
 * requirement and is unrelated to the chat path.
 *
 * Requires the host app to install `@ai-sdk/react` and `ai` as
 * peer deps; both are optional from the SDK's perspective.
 *
 * @experimental V1 surface — shape may evolve before promotion.
 */

import { useCallback, useMemo, useRef } from 'react'
// `@ai-sdk/react` and `ai` are optional peer deps — at runtime the host
// app must have them installed, at compile time the imports are
// type-only paths.
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

/**
 * Generate a stable-ish synthetic UIMessage id. The AI SDK ships its
 * own ids for messages it produces; we only mint ids for synthetic
 * inserts (`appendAssistantMessage` / `appendUserMessage`) where the
 * message bypasses the model entirely.
 */
function syntheticId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Hook that owns the text-chat session lifecycle end-to-end.
 *
 * Returns the message list plus imperative helpers (`sendMessage`,
 * `setMessages`, `appendAssistantMessage`, `appendUserMessage`) and
 * the AI-SDK status. State management is in-memory only — for durable
 * threads, persist `messages` yourself (e.g. on `status === 'ready'`)
 * and rehydrate via `setMessages(...)` on next mount.
 */
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
    fetchCredentials = shogoApiKey ? 'omit' : 'same-origin',
    id,
    onError,
    dynamicVariables,
  } = options

  // Resolve the per-request URL up front. `useChat` is given a
  // transport instance, not a URL — but the transport's `api` is
  // captured at construction time, so we recompute it every render
  // and let `useMemo` guard against churn when nothing relevant
  // changed.
  const resolvedApi = useMemo(
    () => appendChatQuery(api, { projectId, conversationId, agentName }),
    [api, projectId, conversationId, agentName],
  )

  const headers = useMemo(() => {
    const h: Record<string, string> = {}
    if (shogoApiKey) h.authorization = `Bearer ${shogoApiKey}`
    return h
  }, [shogoApiKey])

  // Server-side request body extras (everything beyond `messages`,
  // which the AI SDK supplies). We ship `projectId`, `conversationId`,
  // and the tool descriptors here; the SDK appends them to the JSON
  // body on every send.
  const body = useMemo(() => {
    const b: Record<string, unknown> = {}
    if (projectId) b.projectId = projectId
    if (agentName) b.agentName = agentName
    if (conversationId) b.conversationId = conversationId
    if (tools && tools.length > 0) b.tools = tools
    if (dynamicVariables && Object.keys(dynamicVariables).length > 0) {
      // Forward verbatim — the server may use these in the system
      // prompt or simply log them. Symmetric with how voice surfaces
      // them to ElevenLabs.
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

  // Tool-call resolution. Matches the pattern in
  // `apps/mobile/components/voice-mode/useTranslatorChat.ts` — capture
  // both the chat ref and the tools map in refs so `onToolCall` doesn't
  // need to resubscribe on every render.
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
      // `useChat().sendMessage` handles thread bookkeeping + transport
      // dispatch in one call. We swallow its return value to keep the
      // surface narrow; consumers observe `messages` / `status`.
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
