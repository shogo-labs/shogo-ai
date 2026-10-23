// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Polls and Q&A in a huddle's thread, built on chat messages so results stay
 * after the call. A poll is a message with `blocks.poll`; a question is a
 * message with `blocks.question`. Votes live in `conversation_votes` and are
 * mirrored into the message's blocks (tallies and who voted) so every client
 * sees updates through the ordinary `message.updated` event.
 *
 * Voting is not tied to huddles, so the same blocks can be posted into
 * ordinary chat later.
 */

import { randomUUID } from 'crypto'
import { prisma } from '../lib/prisma'
import { getHuddleChat } from './huddle.service'
import {
  ConversationError,
  getWorkspaceRole,
  postMessage,
  requirePost,
  updateMessageInternal,
} from './conversation.service'

const db = prisma as any

export const MAX_POLL_OPTIONS = 10
export const MAX_POLL_QUESTION = 200
export const MAX_POLL_OPTION = 100
export const MAX_QUESTION = 500
/** The vote id for a question upvote. */
export const UPVOTE = 'up'

export interface PollOption {
  id: string
  text: string
}

export interface PollBlock {
  question: string
  options: PollOption[]
  multiple: boolean
  closed: boolean
  /** Votes per option id. */
  tally: Record<string, number>
  /** Who voted for each option id. */
  voters: Record<string, string[]>
}

export interface QuestionBlock {
  answered: boolean
  upvotes: number
  upvoters: string[]
}

type VotableBlocks = { poll?: PollBlock; question?: QuestionBlock; [key: string]: unknown }

/**
 * Where this person's polls and questions for the call go: the call's chat for
 * them (their DM, the group with the exact people in the call, or the channel
 * thread), which also keeps non-members of the call's conversation working.
 */
async function huddleThread(conversationId: string, userId: string): Promise<{ conversationId: string; threadRootId: string | null }> {
  const huddle = await db.huddle.findUnique({
    where: { activeKey: conversationId },
    select: { id: true, participants: { where: { leftAt: null, userId }, select: { id: true } } },
  })
  if (!huddle) throw new ConversationError(409, 'huddle_ended', 'This huddle has ended')
  if (!huddle.participants.length) throw new ConversationError(403, 'forbidden', 'Join the huddle first')
  const chat = await getHuddleChat(conversationId, userId)
  if (!chat) throw new ConversationError(409, 'no_chat', 'This huddle has no chat to post in')
  await requirePost(chat.conversationId, userId, { threadReply: !!chat.threadRootId })
  return { conversationId: chat.conversationId, threadRootId: chat.threadRootId }
}

function clean(value: unknown, max: number): string {
  return (typeof value === 'string' ? value : '').replace(/\s+/g, ' ').trim().slice(0, max)
}

export async function postHuddlePoll(
  conversationId: string,
  userId: string,
  input: { question?: unknown; options?: unknown; multiple?: unknown },
) {
  const question = clean(input.question, MAX_POLL_QUESTION)
  const texts = (Array.isArray(input.options) ? input.options : []).map((o) => clean(o, MAX_POLL_OPTION)).filter(Boolean)
  const options = [...new Set(texts)].slice(0, MAX_POLL_OPTIONS)
  if (!question) throw new ConversationError(400, 'invalid_request', 'Ask a question')
  if (options.length < 2) throw new ConversationError(400, 'invalid_request', 'Give at least two options')
  const target = await huddleThread(conversationId, userId)
  const poll: PollBlock = {
    question,
    options: options.map((text) => ({ id: randomUUID().slice(0, 8), text })),
    multiple: input.multiple === true,
    closed: false,
    tally: {},
    voters: {},
  }
  const result = await postMessage({
    conversationId: target.conversationId,
    authorType: 'user',
    authorUserId: userId,
    text: `Poll: ${question}`,
    threadRootId: target.threadRootId ?? undefined,
    blocks: { poll },
  })
  return result.message
}

export async function postHuddleQuestion(conversationId: string, userId: string, input: { text?: unknown }) {
  const text = clean(input.text, MAX_QUESTION)
  if (!text) throw new ConversationError(400, 'invalid_request', 'Ask a question')
  const target = await huddleThread(conversationId, userId)
  const question: QuestionBlock = { answered: false, upvotes: 0, upvoters: [] }
  const result = await postMessage({
    conversationId: target.conversationId,
    authorType: 'user',
    authorUserId: userId,
    text,
    threadRootId: target.threadRootId ?? undefined,
    blocks: { question },
  })
  return result.message
}

async function loadVotable(messageId: string, userId: string) {
  const row = await db.conversationMessage.findUnique({ where: { id: messageId } })
  if (!row || row.deletedAt) throw new ConversationError(404, 'not_found', 'Message not found')
  await requirePost(row.conversationId, userId, { threadReply: !!row.threadRootId })
  const blocks = (row.blocks ?? {}) as VotableBlocks
  if (!blocks.poll && !blocks.question) throw new ConversationError(400, 'not_votable', 'There is nothing to vote on here')
  return { row, blocks }
}

/** Everyone's votes on a message, grouped by option. */
async function tallyVotes(messageId: string): Promise<{ tally: Record<string, number>; voters: Record<string, string[]> }> {
  const votes: Array<{ userId: string; optionId: string }> = await db.conversationVote.findMany({
    where: { messageId },
    orderBy: { createdAt: 'asc' },
    select: { userId: true, optionId: true },
  })
  const tally: Record<string, number> = {}
  const voters: Record<string, string[]> = {}
  for (const v of votes) {
    tally[v.optionId] = (tally[v.optionId] ?? 0) + 1
    ;(voters[v.optionId] ??= []).push(v.userId)
  }
  return { tally, voters }
}

/**
 * Vote for a poll option, or upvote a question (`optionId` = "up"). Voting
 * again for the same option takes the vote back; a single-choice poll moves
 * your vote.
 */
export async function voteOnMessage(messageId: string, userId: string, optionId: unknown) {
  const option = typeof optionId === 'string' ? optionId : ''
  const { row, blocks } = await loadVotable(messageId, userId)
  const poll = blocks.poll
  if (poll) {
    if (poll.closed) throw new ConversationError(409, 'poll_closed', 'This poll is closed')
    if (!poll.options.some((o) => o.id === option)) throw new ConversationError(400, 'invalid_request', 'That is not an option in this poll')
  } else if (option !== UPVOTE) {
    throw new ConversationError(400, 'invalid_request', 'Questions can only be upvoted')
  }

  const mine: Array<{ optionId: string }> = await db.conversationVote.findMany({ where: { messageId, userId }, select: { optionId: true } })
  if (mine.some((v) => v.optionId === option)) {
    await db.conversationVote.deleteMany({ where: { messageId, userId, optionId: option } })
  } else {
    if (poll && !poll.multiple) await db.conversationVote.deleteMany({ where: { messageId, userId } })
    try {
      await db.conversationVote.create({ data: { messageId, userId, optionId: option } })
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err
    }
  }

  const { tally, voters } = await tallyVotes(messageId)
  const next: VotableBlocks = poll
    ? { ...blocks, poll: { ...poll, tally, voters } }
    : { ...blocks, question: { ...blocks.question!, upvotes: tally[UPVOTE] ?? 0, upvoters: voters[UPVOTE] ?? [] } }
  return updateMessageInternal(row.id, { blocks: next })
}

async function requireAuthorOrAdmin(row: any, userId: string, hostId: string | null = null): Promise<void> {
  if (row.authorUserId === userId || hostId === userId) return
  const role = await getWorkspaceRole(row.workspaceId, userId)
  if (role === 'owner' || role === 'admin') return
  throw new ConversationError(403, 'forbidden', 'Only the person who posted this can change it')
}

/** Close a poll to further votes. The person who asked, or a workspace admin, can. */
export async function closePoll(messageId: string, userId: string) {
  const { row, blocks } = await loadVotable(messageId, userId)
  if (!blocks.poll) throw new ConversationError(400, 'not_votable', 'This is not a poll')
  await requireAuthorOrAdmin(row, userId)
  return updateMessageInternal(row.id, { blocks: { ...blocks, poll: { ...blocks.poll, closed: true } } })
}

/** Mark a question answered (or open again). The person who asked, the huddle's host, or an admin can. */
export async function setQuestionAnswered(messageId: string, userId: string, answered: boolean) {
  const { row, blocks } = await loadVotable(messageId, userId)
  if (!blocks.question) throw new ConversationError(400, 'not_votable', 'This is not a question')
  const huddle = row.threadRootId
    ? await db.huddle.findFirst({ where: { messageId: row.threadRootId }, select: { startedById: true } })
    : null
  await requireAuthorOrAdmin(row, userId, huddle?.startedById ?? null)
  return updateMessageInternal(row.id, { blocks: { ...blocks, question: { ...blocks.question, answered } } })
}
