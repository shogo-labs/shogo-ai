// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shogo's own channels as a chat provider: the conversation tables are the
 * source of truth and the realtime bus is the delivery channel. External
 * providers mirror into the same store, so every outbound message goes
 * through here first.
 */

import { publishConversationEvent } from '../../lib/conversation-bus'
import {
  conversationAudience,
  postMessage,
  updateMessageInternal,
  type PostMessageInput,
  type PostMessageResult,
} from '../conversation.service'
import type { ProviderCapabilities } from './types'

export const shogoCapabilities: ProviderCapabilities = {
  threads: true,
  edits: true,
  reactions: true,
  files: true,
  perAgentIdentity: true,
  readHistory: true,
}

export const shogoProvider = {
  kind: 'shogo' as const,
  capabilities: shogoCapabilities,

  postMessage(input: PostMessageInput): Promise<PostMessageResult> {
    return postMessage(input)
  },

  updateMessage(messageId: string, data: Record<string, unknown>, opts?: { moveToEnd?: boolean }) {
    return updateMessageInternal(messageId, data, opts)
  },

  /** Live progress for a streaming agent reply; not persisted. */
  async streamUpdate(
    conversation: { id: string; workspaceId: string; kind: string },
    messageId: string,
    state: { text: string; tool: string | null; tools?: Array<{ name: string; done: boolean }> },
    audience?: string[] | null,
  ): Promise<void> {
    const to = audience === undefined ? await conversationAudience(conversation) : audience
    publishConversationEvent(conversation.workspaceId, {
      type: 'agent.delta', conversationId: conversation.id, messageId, text: state.text, tool: state.tool, tools: state.tools,
    }, to)
  },
}
