// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Outbound messages from agents and the system, whatever the chat surface.
 *
 * Every message is written to the conversation store through the Shogo
 * provider. When the conversation mirrors an external channel, the message is
 * also posted to that provider and the store row records the provider's
 * message id in `externalRef`, which is also how inbound echoes of our own
 * posts are recognized and dropped.
 */

import { prisma } from '../../lib/prisma'
import { renderMentionsAsText } from '../conversation-mentions'
import { conversationAudience, type PostMessageResult } from '../conversation.service'
import { getChatProvider } from './registry'
import { installationForWorkspace } from './installations'
import { shogoProvider } from './shogo'
import {
  externalRefFor,
  parseExternalRef,
  type ChatProvider,
  type ConversationRef,
  type ExternalMessageRef,
  type OutboundAuthor,
} from './types'
import type { ExternalChatProvider } from '../chat-mode'

const db = prisma as any

/** Provider edit calls are rate limited (Slack: ~1/s per channel), so external streams update less often. */
export const EXTERNAL_STREAM_THROTTLE_MS = 1_500
const WORKING_TEXT = '_Working on it…_'

export interface AgentReplyHandle {
  conversation: any
  messageId: string
  row: any
  author: OutboundAuthor
  external: { provider: ChatProvider; conv: ConversationRef; ref: ExternalMessageRef } | null
  lastExternalUpdate: number
  audience: string[] | null
}

/** Shogo mention tokens (`<@u:…>`, `<@a:p:…>`) mean nothing on other platforms; send names instead. */
async function providerText(workspaceId: string, text: string): Promise<string> {
  if (!/<[@#!]/.test(text)) return text
  const { loadMentionNames } = await import('../conversation-agent-dispatcher')
  return renderMentionsAsText(text, await loadMentionNames(workspaceId, [text]))
}

function isExternal(conversation: any): boolean {
  return !!conversation?.provider && conversation.provider !== 'shogo' && !!conversation.externalId
}

async function conversationRef(conversation: any, threadRootId: string | null): Promise<{ provider: ChatProvider; conv: ConversationRef } | null> {
  if (!isExternal(conversation)) return null
  const provider = getChatProvider(conversation.provider)
  if (!provider) {
    console.warn(`[ChatOutbound] No ${conversation.provider} provider registered; message kept in Shogo only`)
    return null
  }
  const installation = await installationForWorkspace(conversation.workspaceId, conversation.provider as ExternalChatProvider)
  if (!installation) {
    console.warn(`[ChatOutbound] ${conversation.provider} is not installed for workspace ${conversation.workspaceId}`)
    return null
  }
  let threadExternalId: string | null = null
  if (threadRootId) {
    const root = await db.conversationMessage.findUnique({ where: { id: threadRootId }, select: { externalRef: true } })
    threadExternalId = parseExternalRef(root?.externalRef)?.id ?? null
  }
  return {
    provider,
    conv: {
      workspaceId: conversation.workspaceId,
      conversationId: conversation.id,
      externalId: conversation.externalId,
      threadExternalId,
      installation,
    },
  }
}

async function mirror(
  conversation: any,
  row: any,
  text: string,
  author: OutboundAuthor,
): Promise<AgentReplyHandle['external']> {
  const target = await conversationRef(conversation, row.threadRootId ?? null)
  if (!target) return null
  try {
    const ref = await target.provider.postMessage(target.conv, { text: await providerText(conversation.workspaceId, text), author })
    await db.conversationMessage.update({ where: { id: row.id }, data: { externalRef: externalRefFor(ref) } })
    return { ...target, ref }
  } catch (err) {
    console.error(`[ChatOutbound] ${target.provider.kind} post failed:`, (err as Error).message)
    return null
  }
}

/** A finished message from an agent (tool post, task result, schedule output). */
export async function postAgentMessage(input: {
  conversationId: string
  text: string
  agent: { projectId: string | null; name: string }
  threadRootId?: string | null
  agentStatus?: string
  agentSessionId?: string | null
  externalRef?: string | null
}): Promise<PostMessageResult> {
  const conversation = await db.conversation.findUnique({
    where: { id: input.conversationId },
    select: { provider: true, externalId: true },
  })
  // Mirrored rows carry the provider's message id in externalRef, so a
  // caller's dedupe key moves to clientMsgId (also unique per conversation).
  const external = isExternal(conversation)
  const result = await shogoProvider.postMessage({
    conversationId: input.conversationId,
    text: input.text,
    authorType: 'agent',
    authorAgentRef: input.agent,
    threadRootId: input.threadRootId ?? null,
    agentStatus: input.agentStatus ?? 'done',
    agentSessionId: input.agentSessionId ?? null,
    externalRef: external ? null : input.externalRef ?? null,
    clientMsgId: external ? input.externalRef?.slice(0, 100) ?? null : null,
  })
  if (!result.duplicate) {
    await mirror(result.conversation, result.row, input.text, { type: 'agent', ...input.agent })
  }
  return result
}

/** Open a streaming agent reply: a placeholder in the store and, for external channels, on the provider. */
export async function startAgentReply(input: {
  conversation: any
  agent: { projectId: string | null; name: string }
  threadRootId: string | null
  agentSessionId: string
}): Promise<AgentReplyHandle> {
  const author: OutboundAuthor = { type: 'agent', ...input.agent }
  const placeholder = await shogoProvider.postMessage({
    conversationId: input.conversation.id,
    text: '',
    authorType: 'agent',
    authorAgentRef: input.agent,
    threadRootId: input.threadRootId,
    agentStatus: 'running',
    agentSessionId: input.agentSessionId,
  })
  const external = await mirror(placeholder.conversation, placeholder.row, WORKING_TEXT, author)
  return {
    conversation: placeholder.conversation,
    messageId: placeholder.row.id,
    row: placeholder.row,
    author,
    external,
    lastExternalUpdate: Date.now(),
    audience: await conversationAudience(placeholder.conversation),
  }
}

function externalProgressText(state: { text: string; tool: string | null }): string {
  const body = state.text.trim()
  const status = state.tool ? `_Using ${state.tool}…_` : ''
  if (body && status) return `${body}\n\n${status}`
  return body || status || WORKING_TEXT
}

/** Live progress. Shogo clients get every delta; external providers get throttled edits. */
export async function streamAgentReply(handle: AgentReplyHandle, state: { text: string; tool: string | null }): Promise<void> {
  await shogoProvider.streamUpdate(handle.conversation, handle.messageId, state, handle.audience)
  const ext = handle.external
  if (!ext?.provider.updateMessage || !ext.provider.capabilities.edits) return
  if (Date.now() - handle.lastExternalUpdate < EXTERNAL_STREAM_THROTTLE_MS) return
  handle.lastExternalUpdate = Date.now()
  const text = await providerText(ext.conv.workspaceId, externalProgressText(state))
  await ext.provider.updateMessage(ext.conv, ext.ref, { text, author: handle.author })
    .catch((err) => console.warn(`[ChatOutbound] ${ext.provider.kind} progress update failed:`, (err as Error).message))
}

/** Settle a streaming reply with its final text and status. */
export async function finishAgentReply(handle: AgentReplyHandle, final: { text: string; agentStatus: string }): Promise<void> {
  await shogoProvider.updateMessage(handle.messageId, { text: final.text, agentStatus: final.agentStatus })
  const ext = handle.external
  if (!ext) return
  try {
    const msg = { text: await providerText(ext.conv.workspaceId, final.text), author: handle.author }
    if (ext.provider.updateMessage && ext.provider.capabilities.edits) {
      await ext.provider.updateMessage(ext.conv, ext.ref, msg)
    } else {
      await ext.provider.postMessage(ext.conv, msg)
    }
  } catch (err) {
    console.error(`[ChatOutbound] ${ext.provider.kind} final update failed:`, (err as Error).message)
  }
}
