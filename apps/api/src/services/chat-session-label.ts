// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The name a channel run stores on its `ChatSession`.
 *
 * It is the only thing the chat list, the session history and "Running now"
 * have to say what a run is, and the mention tokens are gone once it is
 * written — so it is built here, where the session is created, from the message
 * that woke the agent (plus the card, when the thread is a card's thread).
 *
 * Two rules keep it readable: the card title wins over the message, because
 * that is what people call the work; otherwise the message is rendered with
 * real names and without the tag that woke the agent, because that tag is the
 * same on every run in the thread.
 */
import { prisma } from '../lib/prisma'
import {
  loadNamesForTexts,
  renderMentionsAsText,
  stripLeadingAgentMention,
  type AgentTarget,
  type MentionNames,
} from './conversation-mentions'

/** A card's key and title, e.g. `SHO-425 · Running now list is unreadable`. */
async function cardLabel(threadRootId: string | null): Promise<string | null> {
  if (!threadRootId) return null
  const card = await prisma.workItem.findFirst({
    where: { threadRootMessageId: threadRootId },
    select: { key: true, title: true },
    orderBy: { createdAt: 'desc' },
  }).catch(() => null)
  return card ? `${card.key} · ${card.title}` : null
}

/** Display names for the mention tokens in one message, the workspace agent included. */
async function namesFor(workspaceId: string, text: string): Promise<MentionNames> {
  const [names, profile] = await Promise.all([
    loadNamesForTexts(prisma as any, workspaceId, [text]),
    prisma.workspaceAgentProfile.findUnique({ where: { workspaceId }, select: { name: true } }).catch(() => null),
  ])
  return { ...names, workspaceAgentName: profile?.name || 'Shogo' }
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim()

export async function chatSessionLabel(args: {
  workspaceId: string
  conversationName?: string | null
  text?: string | null
  target: AgentTarget
  threadRootId?: string | null
}): Promise<string> {
  const card = await cardLabel(args.threadRootId ?? null)
  if (card) return card
  const raw = args.text ?? ''
  const asked = stripLeadingAgentMention(raw, args.target) || raw
  const rendered = collapse(renderMentionsAsText(asked, await namesFor(args.workspaceId, asked)))
  const where = args.conversationName ? `#${args.conversationName}` : 'Chat'
  return rendered ? `${where}: ${rendered}` : where
}
