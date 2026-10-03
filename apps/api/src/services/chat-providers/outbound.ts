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
import { agentIconUrl, conversationAudience, type PostMessageResult } from '../conversation.service'
import type { AgentChain } from '../conversation-agent-chain'
import { blocksForKind, cardToMarkdown, normalizeKind, type AgentWork, type MessageBlocks, type MessageKind, type StatusCard } from '../conversation-message-kind'
import { getChatProvider } from './registry'
import { installationForWorkspace } from './installations'
import { shogoProvider } from './shogo'
import {
  externalRefFor,
  parseExternalRef,
  type ChatProvider,
  type ConversationRef,
  type ExternalMessageRef,
  type OutboundAction,
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
    const root = await db.conversationMessage.findUnique({ where: { id: threadRootId }, select: { externalRef: true, externalThreadRef: true } })
    threadExternalId = parseExternalRef(root?.externalThreadRef ?? root?.externalRef)?.id ?? null
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
  actions?: OutboundAction[],
): Promise<AgentReplyHandle['external']> {
  const target = await conversationRef(conversation, row.threadRootId ?? null)
  if (!target) return null
  try {
    const ref = await target.provider.postMessage(target.conv, { text: await providerText(conversation.workspaceId, text), author, actions })
    await db.conversationMessage.update({
      where: { id: row.id },
      data: {
        externalRef: externalRefFor(ref),
        ...(ref.threadKey && !row.threadRootId
          ? { externalThreadRef: externalRefFor({ provider: ref.provider, channelId: ref.channelId, id: ref.threadKey }) }
          : {}),
      },
    })
    return { ...target, ref }
  } catch (err) {
    console.error(`[ChatOutbound] ${target.provider.kind} post failed:`, (err as Error).message)
    return null
  }
}

/** The agent's name and avatar, as stored on the message and sent to providers. */
async function withIcon(
  workspaceId: string | undefined,
  agent: { projectId: string | null; name: string; iconUrl?: string | null },
): Promise<{ projectId: string | null; name: string; iconUrl?: string | null }> {
  if (agent.iconUrl !== undefined || !workspaceId) return agent
  const iconUrl = await agentIconUrl(workspaceId, agent.projectId).catch(() => null)
  return iconUrl ? { ...agent, iconUrl } : agent
}

/** A finished message from an agent (tool post, task result, schedule output). */
export async function postAgentMessage(input: {
  conversationId: string
  workspaceId?: string
  text: string
  agent: { projectId: string | null; name: string }
  threadRootId?: string | null
  agentStatus?: string
  agentSessionId?: string | null
  externalRef?: string | null
  agentChain?: AgentChain | null
  /** Message kind and status card; see `conversation-message-kind`. */
  blocks?: MessageBlocks | null
  /** Buttons for the mirrored copy on platforms that have them; a function gets the stored row (for its id). */
  actions?: OutboundAction[] | ((row: any) => OutboundAction[])
}): Promise<PostMessageResult> {
  const conversation = await db.conversation.findUnique({
    where: { id: input.conversationId },
    select: { provider: true, externalId: true, workspaceId: true },
  })
  // Mirrored rows carry the provider's message id in externalRef, so a
  // caller's dedupe key moves to clientMsgId (also unique per conversation).
  const external = isExternal(conversation)
  const agent = await withIcon(input.workspaceId ?? conversation?.workspaceId, input.agent)
  const result = await shogoProvider.postMessage({
    conversationId: input.conversationId,
    text: input.text,
    authorType: 'agent',
    authorAgentRef: agent,
    threadRootId: input.threadRootId ?? null,
    agentStatus: input.agentStatus ?? 'done',
    agentSessionId: input.agentSessionId ?? null,
    externalRef: external ? null : input.externalRef ?? null,
    clientMsgId: external ? input.externalRef?.slice(0, 100) ?? null : null,
    agentChain: input.agentChain ?? null,
    blocks: input.blocks ?? undefined,
  })
  if (!result.duplicate) {
    await mirror(result.conversation, result.row, input.text, { type: 'agent', ...agent }, typeof input.actions === 'function' ? input.actions(result.row) : input.actions)
  }
  return result
}

/** Open a streaming agent reply: a placeholder in the store and, for external channels, on the provider. */
export async function startAgentReply(input: {
  conversation: any
  agent: { projectId: string | null; name: string }
  threadRootId: string | null
  agentSessionId: string
  agentChain?: AgentChain | null
}): Promise<AgentReplyHandle> {
  const agent = await withIcon(input.conversation.workspaceId, input.agent)
  const author: OutboundAuthor = { type: 'agent', ...agent }
  const placeholder = await shogoProvider.postMessage({
    conversationId: input.conversation.id,
    text: '',
    authorType: 'agent',
    authorAgentRef: agent,
    threadRootId: input.threadRootId,
    agentStatus: 'running',
    agentSessionId: input.agentSessionId,
    agentChain: input.agentChain ?? null,
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

/** External channels see a status line while the agent works; the answer arrives in one piece. */
function externalProgressText(state: { text: string; tool: string | null }): string {
  return state.tool ? `_Using ${state.tool}…_` : WORKING_TEXT
}

/** Live progress. Shogo clients get every delta; external providers get throttled edits. */
export async function streamAgentReply(
  handle: AgentReplyHandle,
  state: { text: string; tool: string | null; tools?: Array<{ name: string; done: boolean }> },
): Promise<void> {
  await shogoProvider.streamUpdate(handle.conversation, handle.messageId, state, handle.audience)
  const ext = handle.external
  if (!ext?.provider.updateMessage || !ext.provider.capabilities.edits) return
  if (Date.now() - handle.lastExternalUpdate < EXTERNAL_STREAM_THROTTLE_MS) return
  handle.lastExternalUpdate = Date.now()
  const text = await providerText(ext.conv.workspaceId, externalProgressText(state))
  await ext.provider.updateMessage(ext.conv, ext.ref, { text, author: handle.author })
    .catch((err) => console.warn(`[ChatOutbound] ${ext.provider.kind} progress update failed:`, (err as Error).message))
}

/** `Worked for 8s` / `1m 05s` / `1h 2m`, the same wording as the app's work header (`formatWorkedDuration`). */
export function workedForLabel(work: { startedAt: number; completedAt: number }): string {
  const totalSeconds = Math.max(0, Math.round((work.completedAt - work.startedAt) / 1000))
  if (totalSeconds < 60) return `Worked for ${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `Worked for ${minutes}m ${String(totalSeconds % 60).padStart(2, '0')}s`
  return `Worked for ${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * Settle a streaming reply with its final text and status. A reply that finished after other
 * messages landed moves to the end of the conversation, so the timeline reads in the order things
 * were written, not the order the replies were started.
 */
export async function finishAgentReply(
  handle: AgentReplyHandle,
  final: { text: string; agentStatus: string; work?: AgentWork | null },
): Promise<void> {
  await shogoProvider.updateMessage(
    handle.messageId,
    { text: final.text, agentStatus: final.agentStatus, ...(final.work ? { blocks: { work: final.work } } : {}) },
    { moveToEnd: true },
  )
  const ext = handle.external
  if (!ext) return
  try {
    const footer = final.work ? `_${workedForLabel(final.work)}_` : ''
    const body = [final.text, footer].filter(Boolean).join('\n\n')
    const msg = { text: await providerText(ext.conv.workspaceId, body), author: handle.author }
    if (ext.provider.updateMessage && ext.provider.capabilities.edits) {
      await ext.provider.updateMessage(ext.conv, ext.ref, msg)
    } else {
      await ext.provider.postMessage(ext.conv, msg)
    }
  } catch (err) {
    console.error(`[ChatOutbound] ${ext.provider.kind} final update failed:`, (err as Error).message)
  }
}

/**
 * A thread's task card is shared: the agent that opened it and the agents it
 * hands the work to all move it forward, so the thread shows one card instead
 * of one per agent. Only status cards qualify, and only for an agent that has
 * itself written in that thread.
 */
async function mayShareCard(row: any, blocks: MessageBlocks | null, projectId: string | null): Promise<boolean> {
  if (row.authorType !== 'agent' || blocks?.type !== 'status_card' || !projectId) return false
  const rootId = row.threadRootId ?? row.id
  const agentMessages = await db.conversationMessage.findMany({
    where: { conversationId: row.conversationId, threadRootId: rootId, authorType: 'agent', deletedAt: null },
    select: { authorAgentRef: true },
    take: 200,
  })
  return agentMessages.some((m: any) => m.authorAgentRef?.projectId === projectId)
}

/**
 * The task card of the thread a message belongs to. Agents often pass the thread's root id (the
 * report) instead of the card's id when they move a card forward, so a card sent to a message that
 * is not itself a card goes to the thread's card.
 */
async function threadCardFor(row: any): Promise<any | null> {
  const rootId = row.threadRootId ?? row.id
  const candidates = await db.conversationMessage.findMany({
    where: {
      conversationId: row.conversationId,
      workspaceId: row.workspaceId,
      authorType: 'agent',
      deletedAt: null,
      OR: [{ id: rootId }, { threadRootId: rootId }],
    },
    orderBy: { seq: 'asc' },
    take: 200,
  })
  return candidates.find((m: any) => (m.blocks as MessageBlocks | null)?.type === 'status_card') ?? null
}

/**
 * Change a message an agent posted earlier: its text, kind, or status card.
 * Only the agent that wrote it can. A card's text is re-rendered from the card,
 * and the edit is mirrored to the provider so Slack and the other bridges show
 * the latest state in place. Mentions are not re-read, so an edit never hands
 * work to another agent.
 */
export async function updateAgentMessage(input: {
  messageId: string
  workspaceId: string
  projectId: string | null
  text?: string
  kind?: MessageKind | null
  card?: StatusCard | null
}): Promise<{ message: any; row: any }> {
  let row = await db.conversationMessage.findUnique({ where: { id: input.messageId } })
  if (!row || row.deletedAt || row.workspaceId !== input.workspaceId) throw new AgentMessageError(404, 'not_found', 'Message not found')
  if (input.card && (row.blocks as MessageBlocks | null)?.type !== 'status_card') row = (await threadCardFor(row)) ?? row
  const existing = row.blocks as MessageBlocks | null
  const own = row.authorType === 'agent' && (row.authorAgentRef?.projectId ?? null) === input.projectId
  if (!own && !(await mayShareCard(row, existing, input.projectId))) {
    throw new AgentMessageError(403, 'forbidden', 'Agents can only update their own messages, or the task card of a thread they are working in')
  }
  if (row.agentStatus === 'running') throw new AgentMessageError(409, 'running', 'That message is still being written')

  const card = input.card ?? null
  const blocks = blocksForKind({ kind: input.kind ?? normalizeKind(existing?.messageKind), card, existing })
  let text = input.text ?? row.text
  // A card message's text is always its rendering, plus an optional note under it.
  const shown = card ?? (existing?.type === 'status_card' ? existing.card ?? null : null)
  if (shown && (card || input.text !== undefined)) {
    text = [cardToMarkdown(shown), input.text?.trim()].filter(Boolean).join('\n\n')
  }
  if (!String(text ?? '').trim()) throw new AgentMessageError(400, 'empty', 'Nothing to update')

  const message = await shogoProvider.updateMessage(row.id, { text, blocks: blocks ?? null })
  const conversation = await db.conversation.findUnique({ where: { id: row.conversationId } })
  const target = conversation ? await conversationRef(conversation, row.threadRootId ?? null) : null
  const ref = parseExternalRef(row.externalRef)
  if (target && ref && target.provider.capabilities.edits) {
    const author: OutboundAuthor = { type: 'agent', ...(row.authorAgentRef ?? { projectId: input.projectId, name: 'Agent' }) }
    await target.provider
      .updateMessage?.(
        target.conv,
        { provider: ref.provider as ExternalChatProvider, channelId: ref.channelId, id: ref.id, threadId: target.conv.threadExternalId },
        { text: await providerText(row.workspaceId, text), author },
      )
      .catch((err: Error) => console.warn(`[ChatOutbound] ${target.provider.kind} message update failed:`, err.message))
  }
  return { message, row }
}

/**
 * Rewrite a message's text and blocks in place, on the store and (where the
 * provider can edit) the mirrored channel. Unlike `updateAgentMessage` this
 * does no authorship check: callers are system flows such as approval cards,
 * where the author is the agent but the one editing is a person's decision.
 */
export async function rewriteMessage(input: {
  messageId: string
  text: string
  blocks: MessageBlocks
  actions?: OutboundAction[]
}): Promise<{ message: any; row: any }> {
  const row = await db.conversationMessage.findUnique({ where: { id: input.messageId } })
  if (!row || row.deletedAt) throw new AgentMessageError(404, 'not_found', 'Message not found')
  const message = await shogoProvider.updateMessage(row.id, { text: input.text, blocks: input.blocks })
  const conversation = await db.conversation.findUnique({ where: { id: row.conversationId } })
  const target = conversation ? await conversationRef(conversation, row.threadRootId ?? null) : null
  const ref = parseExternalRef(row.externalRef)
  if (target && ref && target.provider.capabilities.edits) {
    const author: OutboundAuthor = { type: 'agent', ...(row.authorAgentRef ?? { projectId: null, name: 'Agent' }) }
    await target.provider
      .updateMessage?.(
        target.conv,
        { provider: ref.provider as ExternalChatProvider, channelId: ref.channelId, id: ref.id, threadId: target.conv.threadExternalId },
        { text: await providerText(row.workspaceId, input.text), author, actions: input.actions },
      )
      .catch((err: Error) => console.warn(`[ChatOutbound] ${target.provider.kind} message update failed:`, err.message))
  }
  return { message, row }
}

export class AgentMessageError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, public code: string, message: string) {
    super(message)
  }
}
