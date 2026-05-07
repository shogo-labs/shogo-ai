// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `useShogoChat` — zero-config text-chat hook for generated pod apps.
 *
 * Thin alias around {@link useChatConversation} with the pod-friendly
 * defaults pre-applied:
 *
 *   - `api: '/api/chat/turn'` — served same-origin by the app's own
 *     Hono/Next route, which proxies through the Shogo API via the
 *     pod's runtime token. No API key is read by the browser.
 *   - `fetchCredentials: 'same-origin'`
 *
 * For external / third-party SDK consumers, drive
 * `useChatConversation({ shogoApiKey, projectId, ... })` directly —
 * the bearer path is the right choice when the chat endpoint can't
 * be reached same-origin.
 *
 * @example Minimum viable usage
 * ```tsx
 * import { useShogoChat } from '@shogo-ai/sdk/voice/react'
 *
 * function ChatBox() {
 *   const { messages, sendMessage, status } = useShogoChat()
 *   const [draft, setDraft] = useState('')
 *   return (
 *     <>
 *       {messages.map((m) => <div key={m.id}>{m.parts.map(p => p.type === 'text' ? p.text : '').join('')}</div>)}
 *       <input value={draft} onChange={(e) => setDraft(e.target.value)} />
 *       <button onClick={() => { void sendMessage(draft); setDraft('') }} disabled={status === 'streaming'}>
 *         Send
 *       </button>
 *     </>
 *   )
 * }
 * ```
 *
 * @example Voice + text bridge (the customer use case)
 * ```tsx
 * const voice = useShogoVoice({ shogoApiKey, projectId })
 * const chat  = useShogoChat({
 *   shogoApiKey,
 *   projectId,
 *   conversationId: voice.conversationId ?? undefined,
 * })
 *
 * // When the user types while voice is active, mirror it as
 * // contextual input to the live voice agent rather than going
 * // through the LLM:
 * async function send(text) {
 *   if (voice.status === 'connected') {
 *     voice.sendContextualUpdate(text)
 *     chat.appendUserMessage(text) // local-only echo for the bubble
 *     return
 *   }
 *   await chat.sendMessage(text)
 * }
 *
 * // When the voice agent speaks, mirror it into the text thread:
 * useShogoVoice({
 *   onMessage: ({ source, message }) => {
 *     if (source === 'agent') chat.appendAssistantMessage(message)
 *   },
 * })
 * ```
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
    fetchCredentials: opts.fetchCredentials ?? 'same-origin',
    ...opts,
  })
}
