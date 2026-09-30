// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Inbound messages from an external chat provider.
 *
 * Each external channel gets a shadow Conversation (provider + externalId)
 * and each message a row keyed by its provider message id, so agents keep
 * transcripts, thread memory, and search exactly as in Shogo channels.
 * Messages from people who haven't linked a Shogo account are stored (they
 * are context) but never run an agent: agents act with the author's Shogo
 * permissions.
 */

import { prisma } from '../../lib/prisma'
import { getWorkspaceChatConfig, type ExternalChatProvider } from '../chat-mode'
import { agentMentionToken } from '../conversation-mentions'
import { postMessage, updateMessageInternal, type PostMessageResult } from '../conversation.service'
import { afterMessagePosted, type MessageOrigin } from '../conversation-pipeline'
import { installationForTenant, linkedUserId } from './installations'
import {
  externalRefFor,
  type ChannelKind,
  type ChatInstallationRecord,
  type ChatProvider,
  type ConversationRef,
  type InboundEvent,
} from './types'

const db = prisma as any
const MAX_ADDRESSED_AGENTS = 3

type MessageEvent = Extract<InboundEvent, { type: 'message' }>

export interface KeywordRule {
  keyword: string
  projectId: string
}

/** The bridge owns a provider's traffic only while the workspace's team chat runs on it. */
export async function bridgeActive(provider: ExternalChatProvider, workspaceId: string): Promise<boolean> {
  const config = await getWorkspaceChatConfig(workspaceId)
  return (config.mode === 'external' || config.mode === 'bridged') && config.provider === provider
}

export async function handleInboundEvents(provider: ChatProvider, events: InboundEvent[]): Promise<void> {
  for (const event of events) {
    try {
      await handleInboundEvent(provider, event)
    } catch (err) {
      console.error(`[ChatInbound] ${provider.kind} ${event.type} failed:`, (err as Error).message)
    }
  }
}

export async function handleInboundEvent(provider: ChatProvider, event: InboundEvent): Promise<PostMessageResult | null> {
  const installation = await installationForTenant(provider.kind, event.tenantId)
  if (!installation || !(await bridgeActive(provider.kind, installation.workspaceId))) return null
  if (event.type === 'message') return handleMessage(provider, installation, event)

  const conversation = await findShadowConversation(installation, event.channelId)
  if (!conversation) return null
  const row = await db.conversationMessage.findFirst({
    where: { conversationId: conversation.id, externalRef: externalRefFor({ provider: provider.kind, channelId: event.channelId, id: event.messageId }) },
    select: { id: true, authorType: true, deletedAt: true },
  })
  if (!row || row.deletedAt || row.authorType !== 'user') return null
  if (event.type === 'edit') {
    await updateMessageInternal(row.id, { text: event.text, editedAt: new Date() })
  } else {
    await db.conversationReaction.deleteMany({ where: { messageId: row.id } })
    await updateMessageInternal(row.id, { text: '', blocks: null, deletedAt: new Date() })
  }
  return null
}

function findShadowConversation(installation: ChatInstallationRecord, channelId: string) {
  return db.conversation.findUnique({
    where: {
      workspaceId_provider_externalId: { workspaceId: installation.workspaceId, provider: installation.provider, externalId: channelId },
    },
  })
}

/** Find or create the Conversation mirroring an external channel. */
export async function ensureShadowConversation(
  installation: ChatInstallationRecord,
  provider: ChatProvider | null,
  channel: { channelId: string; channelName: string | null; channelKind: ChannelKind | null },
): Promise<any> {
  const existing = await findShadowConversation(installation, channel.channelId)
  if (existing) {
    if (channel.channelName && existing.kind !== 'dm' && existing.name !== channel.channelName) {
      return db.conversation.update({ where: { id: existing.id }, data: { name: channel.channelName } })
    }
    return existing
  }

  let { channelName: name, channelKind: kind } = channel
  if ((!name || !kind) && provider?.describeChannel) {
    const described = await provider.describeChannel(installation, channel.channelId).catch(() => null)
    name ??= described?.name ?? null
    kind ??= described?.kind ?? null
  }
  kind ??= 'public'
  const isDm = kind === 'dm'
  try {
    const created = await db.conversation.create({
      data: {
        workspaceId: installation.workspaceId,
        kind,
        name: isDm ? null : name ?? channel.channelId,
        provider: installation.provider,
        externalId: channel.channelId,
        // Agent DMs reply top-level instead of threading (see the dispatcher).
        dmKey: isDm ? `a:ext:${installation.provider}:${channel.channelId}` : null,
      },
    })
    if (isDm) {
      const projectId = typeof installation.config.defaultProjectId === 'string' ? installation.config.defaultProjectId : null
      await db.conversationMember.create({
        data: { conversationId: created.id, memberType: 'agent', projectId, agentTrigger: 'all' },
      })
    }
    return created
  } catch (err: any) {
    if (err?.code !== 'P2002') throw err
    return findShadowConversation(installation, channel.channelId)
  }
}

/** A linked user only counts while they're still a member of the workspace. */
async function linkedMember(installation: ChatInstallationRecord, externalUserId: string): Promise<string | null> {
  const userId = await linkedUserId(installation.provider, installation.externalTenantId, externalUserId)
  if (!userId) return null
  const member = await db.member.findFirst({ where: { userId, workspaceId: installation.workspaceId }, select: { id: true } })
  return member ? userId : null
}

async function ensureUserMember(conversationId: string, userId: string): Promise<void> {
  await db.conversationMember.upsert({
    where: { conversationId_userId: { conversationId, userId } },
    create: { conversationId, userId, memberType: 'user' },
    update: {},
  }).catch(() => {})
}

/** Map the provider thread to its root row, creating a stub root for threads that predate the bridge. */
async function threadRootFor(provider: ChatProvider, conversation: any, event: MessageEvent): Promise<string | null> {
  if (!event.threadId || event.threadId === event.messageId) return null
  const externalRef = externalRefFor({ provider: provider.kind, channelId: event.channelId, id: event.threadId })
  const root = await db.conversationMessage.findFirst({
    where: { conversationId: conversation.id, externalRef },
    select: { id: true, threadRootId: true },
  })
  if (root) return root.threadRootId ?? root.id
  const stub = await postMessage({
    conversationId: conversation.id,
    text: '_Earlier message_',
    authorType: 'system',
    externalRef,
  })
  return stub.row.id
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase()
}

/**
 * The provider's app was @mentioned. Decide which Shogo agents that means and
 * prepend their mention tokens, in order of precedence:
 *   `project=<name>` or a leading project name ("Billing Bot, ...")
 *   one matching keyword rule
 *   the channel's agent members that answer mentions
 *   the install's default project
 *   the workspace agent
 */
export async function addressAgents(
  installation: ChatInstallationRecord,
  conversation: any,
  text: string,
): Promise<string> {
  const projects: Array<{ id: string; name: string }> = await db.project.findMany({
    where: { workspaceId: installation.workspaceId },
    select: { id: true, name: true },
  })
  let body = text
  let targets: Array<string | null> = []

  const selector = /(?:^|\s)project=("([^"]+)"|(\S+))/i.exec(body)
  if (selector) {
    const wanted = normalize(selector[2] ?? selector[3])
    const project = projects.find((p) => p.id.toLowerCase() === wanted || normalize(p.name) === wanted)
    if (project) {
      targets = [project.id]
      body = body.replace(selector[0], ' ').replace(/[ \t]+/g, ' ').trim()
    }
  }
  if (!targets.length) {
    const lower = normalize(body)
    const leading = projects
      .filter((p) => p.name.trim().length > 2)
      .sort((a, b) => b.name.length - a.name.length)
      .find((p) => {
        const name = normalize(p.name)
        return lower.startsWith(name) && /^($|[\s,:])/.test(lower.slice(name.length))
      })
    if (leading) targets = [leading.id]
  }
  if (!targets.length) {
    const rules = Array.isArray(installation.config.keywordRules) ? (installation.config.keywordRules as KeywordRule[]) : []
    const lower = normalize(body)
    const matched = [...new Set(rules.filter((r) => r.keyword && lower.includes(normalize(r.keyword))).map((r) => r.projectId))]
    if (matched.length === 1 && projects.some((p) => p.id === matched[0])) targets = matched
  }
  if (!targets.length) {
    const members = await db.conversationMember.findMany({
      where: { conversationId: conversation.id, memberType: 'agent', agentTrigger: 'mention' },
      select: { projectId: true },
    })
    targets = members.map((m: any) => m.projectId ?? null)
  }
  if (!targets.length) {
    const fallback = installation.config.defaultProjectId
    targets = [typeof fallback === 'string' && projects.some((p) => p.id === fallback) ? fallback : null]
  }
  const tokens = [...new Set(targets)].slice(0, MAX_ADDRESSED_AGENTS).map(agentMentionToken)
  return `${tokens.join(' ')} ${body}`.trim()
}

async function handleMessage(provider: ChatProvider, installation: ChatInstallationRecord, event: MessageEvent): Promise<PostMessageResult | null> {
  const conversation = await ensureShadowConversation(installation, provider, event)
  if (!conversation) return null
  const userId = await linkedMember(installation, event.user.externalUserId)
  const threadRootId = await threadRootFor(provider, conversation, event)
  const isDm = conversation.kind === 'dm'
  const text = event.addressed && !isDm ? await addressAgents(installation, conversation, event.text) : event.text

  if (userId) await ensureUserMember(conversation.id, userId)
  const result = await postMessage({
    conversationId: conversation.id,
    text,
    authorType: 'user',
    authorUserId: userId,
    threadRootId,
    externalRef: externalRefFor({ provider: provider.kind, channelId: event.channelId, id: event.messageId }),
    blocks: userId
      ? undefined
      : { externalAuthor: { provider: provider.kind, id: event.user.externalUserId, name: event.user.displayName } },
  })
  if (result.duplicate) return result

  if (!userId) {
    if ((event.addressed || isDm) && provider.sendLinkPrompt) {
      const conv: ConversationRef = {
        workspaceId: installation.workspaceId,
        conversationId: conversation.id,
        externalId: event.channelId,
        threadExternalId: isDm ? event.threadId : event.threadId ?? event.messageId,
        installation,
      }
      await provider.sendLinkPrompt(conv, event.user, {
        tenantId: event.tenantId,
        channelId: event.channelId,
        messageId: event.messageId,
        threadId: event.threadId,
        text: event.text,
      }).catch((err) => console.warn(`[ChatInbound] ${provider.kind} link prompt failed:`, (err as Error).message))
    }
    return result
  }

  await afterMessagePosted(result, { actorUserId: userId, origin: provider.kind as MessageOrigin })
  return result
}

/**
 * After someone links their account, claim the message that prompted it and
 * run it as if they had been linked all along.
 */
export async function resumeAfterLink(
  provider: ChatProvider,
  pending: { tenantId: string; channelId: string; messageId: string },
  userId: string,
): Promise<boolean> {
  const installation = await installationForTenant(provider.kind, pending.tenantId)
  if (!installation || !(await bridgeActive(provider.kind, installation.workspaceId))) return false
  const conversation = await findShadowConversation(installation, pending.channelId)
  if (!conversation) return false
  const row = await db.conversationMessage.findFirst({
    where: { conversationId: conversation.id, externalRef: externalRefFor({ provider: provider.kind, channelId: pending.channelId, id: pending.messageId }) },
  })
  if (!row || row.deletedAt || row.authorType !== 'user' || row.authorUserId) return false
  await ensureUserMember(conversation.id, userId)
  const message = await updateMessageInternal(row.id, { authorUserId: userId, blocks: null })
  await afterMessagePosted(
    { message, row: { ...row, authorUserId: userId, blocks: null }, conversation, mentions: [], duplicate: false },
    { actorUserId: userId, origin: provider.kind as MessageOrigin },
  )
  return true
}
