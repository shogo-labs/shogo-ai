// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useRef } from "react"
import { useChat, type UIMessage } from "@ai-sdk/react"
import { DefaultChatTransport, type ChatInit, type ChatTransport } from "ai"
import { DEFAULT_PUBLISH_WAIT_MS, PacedChat } from "./paced-chat"

type Callbacks<M extends UIMessage> = Pick<
  ChatInit<M>,
  "onError" | "onData" | "onFinish" | "onToolCall" | "sendAutomaticallyWhen"
>

export interface UsePacedChatOptions<M extends UIMessage> extends Callbacks<M> {
  id?: string
  transport?: ChatTransport<M>
  resume?: boolean
  publishWaitMs?: number
}

interface Latest<M extends UIMessage> {
  transport?: ChatTransport<M>
  callbacks: Callbacks<M>
}

function createChat<M extends UIMessage>(
  id: string | undefined,
  latestRef: { current: Latest<M> },
  publishWaitMs: number,
): PacedChat<M> {
  let fallbackTransport: ChatTransport<M> | undefined
  const transport = (): ChatTransport<M> =>
    latestRef.current.transport ?? (fallbackTransport ??= new DefaultChatTransport<M>())
  const cb = () => latestRef.current.callbacks
  return new PacedChat<M>({
    id,
    publishWaitMs,
    transport: {
      sendMessages: (options) => transport().sendMessages(options),
      reconnectToStream: (options) => transport().reconnectToStream(options),
    },
    onError: (error) => cb().onError?.(error),
    onData: (dataPart) => cb().onData?.(dataPart),
    onFinish: (options) => cb().onFinish?.(options),
    onToolCall: (options) => cb().onToolCall?.(options),
    sendAutomaticallyWhen: (options) => cb().sendAutomaticallyWhen?.(options) ?? false,
  })
}

/**
 * `useChat` backed by a {@link PacedChat}. Mirrors `useChat({ transport, id })`:
 * the chat is recreated only when a non-null `id` differs from the current
 * one, and the latest transport and callbacks are always used, so a rebuilt
 * transport never drops the in-memory conversation.
 *
 * `publishWaitMs` is read only when the chat is created; changing it later
 * has no effect until `id` changes.
 */
export function usePacedChat<M extends UIMessage = UIMessage>({
  id,
  transport,
  resume = false,
  publishWaitMs = DEFAULT_PUBLISH_WAIT_MS,
  ...callbacks
}: UsePacedChatOptions<M>) {
  const latestRef = useRef<Latest<M>>({ transport, callbacks })
  latestRef.current = { transport, callbacks }
  const chatRef = useRef<PacedChat<M> | null>(null)
  if (chatRef.current === null || (id != null && chatRef.current.id !== id)) {
    chatRef.current = createChat(id, latestRef, publishWaitMs)
  }
  return useChat<M>({ chat: chatRef.current, resume })
}
