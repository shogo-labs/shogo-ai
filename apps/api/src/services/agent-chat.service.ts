// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A person's chat with one agent (SHO-412).
 *
 * A DM with an agent is just a project chat with that agent — a workspace chat
 * for the workspace agent. There is no separate agent-DM surface any more:
 *
 *   * `openAgentChatSession` finds or creates the person's own chat with an
 *     agent, keyed `ChatSession.directKey`.
 *   * `deliverAgentDirectMessage` is the one insert point for a message an
 *     agent sends *to* a person (`team_chat_dm`, the app API's `chat.dm`, and
 *     event scripts all go through it). It appends an assistant row to that
 *     chat and pushes a notification.
 *   * `migrateAgentDmsToProjectChat` moves every existing agent DM into one of
 *     those chats, once, at API boot.
 *
 * Person-to-person DMs, group DMs, note-to-self, channels and bridged
 * Slack/Google DMs are untouched.
 */
import { prisma } from '../lib/prisma'
import { homeRegionWorkspaceWhere } from '../lib/region'
import { sendPushToUser } from '../lib/push-notifications'
import { agentDisplayName } from './conversation.service'

const db = prisma as any

/** `a:<workspaceId>:<userId>:<projectId|ws>` — one chat per person per agent per workspace. */
export function agentDirectKey(workspaceId: string, userId: string, projectId: string | null): string {
  return `a:${workspaceId}:${userId}:${projectId ?? 'ws'}`
}

/** The `dmKey` an agent DM used, which is what the migration reads. */
export function agentDmKey(userId: string, projectId: string | null): string {
  return `a:${userId}:${projectId ?? 'ws'}`
}

/** Split an agent DM's `dmKey` back into the person and the agent. */
export function parseAgentDmKey(dmKey: string): { userId: string; projectId: string | null } | null {
  if (!dmKey.startsWith('a:')) return null
  const rest = dmKey.slice(2)
  const sep = rest.lastIndexOf(':')
  if (sep <= 0) return null
  const userId = rest.slice(0, sep)
  const target = rest.slice(sep + 1)
  if (!userId || !target) return null
  return { userId, projectId: target === 'ws' ? null : target }
}

export interface AgentChatSession {
  id: string
  workspaceId: string
  projectId: string | null
}

/**
 * The person's chat with an agent, created on first use. Idempotent: a second
 * call returns the same session, and a race across pods resolves to whichever
 * row won the unique index.
 */
export async function openAgentChatSession(
  workspaceId: string,
  userId: string,
  projectId: string | null,
): Promise<AgentChatSession> {
  const directKey = agentDirectKey(workspaceId, userId, projectId)
  const existing = await db.chatSession.findUnique({ where: { directKey } })
  if (existing) return { id: existing.id, workspaceId, projectId }

  const name = await agentDisplayName(workspaceId, projectId)
  try {
    const created = await db.chatSession.create({
      data: {
        inferredName: name.slice(0, 120),
        directKey,
        createdByUserId: userId,
        ...(projectId
          ? { contextType: 'project', contextId: projectId }
          : { contextType: 'workspace', workspaceId }),
      },
      select: { id: true },
    })
    return { id: created.id, workspaceId, projectId }
  } catch (err: any) {
    // Another pod created it between the lookup and the insert.
    const raced = await db.chatSession.findUnique({ where: { directKey } })
    if (raced) return { id: raced.id, workspaceId, projectId }
    throw err
  }
}

export interface DeliverAgentDirectMessageInput {
  workspaceId: string
  /** The person the agent is writing to. */
  userId: string
  /** The agent: a project id, or null for the workspace agent. */
  projectId: string | null
  text: string
  /** The run that produced the message, when there is one. */
  sessionId?: string | null
}

/**
 * Append a message an agent sends to a person into that person's chat with it,
 * bump the chat's activity and push a notification. This is the single insert
 * point for agent-to-person messages.
 */
export async function deliverAgentDirectMessage(
  input: DeliverAgentDirectMessageInput,
): Promise<{ chatSessionId: string; messageId: string }> {
  const { workspaceId, userId, projectId, text } = input
  const chat = await openAgentChatSession(workspaceId, userId, projectId)
  const body = String(text ?? '')
  const message = await db.chatMessage.create({
    data: {
      sessionId: chat.id,
      role: 'assistant',
      content: body,
      parts: JSON.stringify([{ type: 'text', text: body }]),
    },
    select: { id: true },
  })
  const now = new Date()
  await db.chatSession.update({ where: { id: chat.id }, data: { lastActiveAt: now, updatedAt: now } })

  const agentName = await agentDisplayName(workspaceId, projectId)
  const preview = body.replace(/\s+/g, ' ').trim().slice(0, 180)
  void sendPushToUser(userId, {
    title: agentName,
    body: preview || 'New message from your agent.',
    audience: 'chat',
    data: { sessionId: chat.id, ...(projectId ? { projectId } : {}) },
  }).catch((err: Error) => console.warn('[AgentChat] push failed:', err.message))

  return { chatSessionId: chat.id, messageId: message.id }
}

// ─── Migration ───────────────────────────────────────────────────────────────

interface MigrationSummary {
  conversations: number
  sessionsCreated: number
  messagesCopied: number
  attachmentsCopied: number
  emptyArchived: number
  skipped: number
}

const MIGRATION_PAGE = 100

/**
 * Move every existing agent DM into a project chat (a workspace chat for the
 * workspace agent), keeping each person's history.
 *
 * Idempotent: a DM whose `directKey` chat already exists is only archived, and
 * an empty DM is archived without a chat. Running it twice changes nothing.
 *
 * Cloud: only the workspace's `homeRegion` migrates it. US↔EU replication is
 * bidirectional, so a duplicate insert on the other side would disable the
 * subscription (the Nov 3 `dmKey` conflict).
 */
export async function migrateAgentDmsToProjectChat(): Promise<MigrationSummary> {
  const summary: MigrationSummary = {
    conversations: 0,
    sessionsCreated: 0,
    messagesCopied: 0,
    attachmentsCopied: 0,
    emptyArchived: 0,
    skipped: 0,
  }
  const home = homeRegionWorkspaceWhere()
  let cursor: string | null = null

  for (;;) {
    const page: any[] = await db.conversation.findMany({
      where: {
        kind: 'dm',
        dmKey: { startsWith: 'a:' },
        archivedAt: null,
        ...(home ? { workspace: home } : {}),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: 'asc' },
      take: MIGRATION_PAGE,
      select: { id: true, workspaceId: true, dmKey: true },
    })
    if (!page.length) break
    cursor = page[page.length - 1].id

    for (const conversation of page) {
      summary.conversations++
      try {
        await migrateOne(conversation, summary)
      } catch (err: any) {
        summary.skipped++
        console.warn(`[AgentDmMigration] ${conversation.id} failed:`, err?.message ?? err)
      }
    }
  }

  return summary
}

async function migrateOne(
  conversation: { id: string; workspaceId: string; dmKey: string },
  summary: MigrationSummary,
): Promise<void> {
  const parsed = parseAgentDmKey(conversation.dmKey)
  if (!parsed) {
    summary.skipped++
    return
  }
  const { userId, projectId } = parsed
  const directKey = agentDirectKey(conversation.workspaceId, userId, projectId)

  const existing = await db.chatSession.findUnique({ where: { directKey }, select: { id: true } })
  if (existing) {
    // Already migrated (or the person has since opened the chat): just retire
    // the DM so it stops showing up.
    await archiveConversation(conversation.id)
    summary.skipped++
    return
  }

  const messages: any[] = await db.conversationMessage.findMany({
    where: {
      conversationId: conversation.id,
      deletedAt: null,
      authorType: { in: ['user', 'agent'] },
    },
    orderBy: { seq: 'asc' },
    select: {
      id: true,
      authorType: true,
      text: true,
      agentSessionId: true,
      attachments: { select: { id: true, name: true, mimeType: true } },
    },
  })

  if (!messages.length) {
    await archiveConversation(conversation.id)
    summary.emptyArchived++
    return
  }

  const name = await agentDisplayName(conversation.workspaceId, projectId)
  const session = await db.chatSession.create({
    data: {
      inferredName: name.slice(0, 120),
      directKey,
      createdByUserId: userId,
      ...(projectId
        ? { contextType: 'project', contextId: projectId }
        : { contextType: 'workspace', workspaceId: conversation.workspaceId }),
    },
    select: { id: true },
  })
  summary.sessionsCreated++

  for (const message of messages) {
    const text = String(message.text ?? '')
    const parts: any[] = [{ type: 'text', text }]
    for (const attachment of message.attachments ?? []) {
      parts.push({
        type: 'file',
        mediaType: attachment.mimeType,
        name: attachment.name,
        url: `/api/conversation-files/${attachment.id}`,
      })
      summary.attachmentsCopied++
    }
    await db.chatMessage.create({
      data: {
        sessionId: session.id,
        role: message.authorType === 'agent' ? 'assistant' : 'user',
        content: text,
        parts: JSON.stringify(parts),
        ...(message.authorType === 'user' ? { authorUserId: userId } : {}),
      },
    })
    summary.messagesCopied++
  }

  // The wrapper-prompt sessions the DM ran on: hand them to the person and
  // archive them so they stop appearing in anyone's chat list.
  const backingIds = [...new Set(messages.map((m) => m.agentSessionId).filter((id): id is string => !!id))]
  if (backingIds.length) {
    await db.chatSession.updateMany({
      where: { id: { in: backingIds } },
      data: { createdByUserId: userId, isArchived: true },
    })
  }

  await archiveConversation(conversation.id)
}

async function archiveConversation(conversationId: string): Promise<void> {
  await db.conversation.updateMany({
    where: { id: conversationId, archivedAt: null },
    data: { archivedAt: new Date() },
  })
}

/**
 * Run the migration once at API boot, off the request path. Never rejects: a
 * failed migration is logged and the API keeps booting.
 */
export function startAgentDmMigration(): void {
  setTimeout(() => {
    migrateAgentDmsToProjectChat()
      .then((summary) => {
        if (summary.conversations === 0) return
        console.log(
          `[AgentDmMigration] ${summary.conversations} agent DMs: ${summary.sessionsCreated} chats created, ` +
            `${summary.messagesCopied} messages and ${summary.attachmentsCopied} attachments copied, ` +
            `${summary.emptyArchived} empty DMs archived, ${summary.skipped} skipped`,
        )
      })
      .catch((err: any) => console.error('[AgentDmMigration] failed (non-fatal):', err?.message ?? err))
  }, 12_000)
}
