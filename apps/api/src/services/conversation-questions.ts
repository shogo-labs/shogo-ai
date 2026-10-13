// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Question cards: what an agent asks people in a channel, as something they
 * can answer in one tap instead of a sentence buried in a long update.
 *
 * Questions live on the message that asked them (`blocks.questions`). An
 * agent declares them on `team_chat_post`, or the designer
 * (`conversation-question-designer`) finds them in plain prose. A question
 * that repeats one still open in the conversation is folded into it: the new
 * message gets a reference and the original's ask count goes up.
 *
 * Everything that follows from a question being asked or closed (the card,
 * the `#activity` line, the asker's inbox items) goes through
 * `onQuestionAsked` / `onQuestionClosed`, whichever way it got there: tool,
 * designer, app, Slack, or closed as moot.
 */

import { randomUUID } from 'crypto'
import { prisma } from '../lib/prisma'
import { decryptSecret, encryptSecret } from '../lib/secret-crypto'
import { publishConversationEvent } from '../lib/conversation-bus'
import { getFrontendUrl } from '../lib/cloud-urls'
import { AgentMessageError, rewriteMessage } from './chat-providers/outbound'
import type { OutboundAction } from './chat-providers/types'
import { envInt, readChain } from './conversation-agent-chain'
import {
  conversationAudience,
  getWorkspaceRole,
  isOpenKind,
  loadAccess,
  postMessage,
  updateMessageInternal,
  type PostMessageResult,
} from './conversation.service'
import { createInboxItems, unreadInboxCount } from './chat-inbox'
import {
  kindOf,
  questionOptions,
  questionsOf,
  questionRefsOf,
  questionsToMarkdown,
  type MessageBlocks,
  type QuestionAnswer,
  type QuestionBlock,
  type QuestionDraft,
  type QuestionRecipients,
  type QuestionRef,
  type QuestionStatus,
} from './conversation-message-kind'

const db = prisma as any

/** A question nobody answered or re-asked in this long is closed as stale. */
export const QUESTION_STALE_MS = envInt('SHOGO_QUESTION_STALE_HOURS', 14 * 24) * 60 * 60_000
/** How far back the inbox looks for answered questions. */
const ANSWERED_LOOKBACK_MS = 30 * 24 * 60 * 60_000
const CONVERSATION_SCAN_LIMIT = 300
const WORKSPACE_SCAN_LIMIT = 2000
const MAX_ANSWER_CHARS = 2000
const MAX_SECRET_CHARS = 8000
const PREVIEW_CHARS = 280

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export interface OpenQuestion {
  row: any
  question: QuestionBlock
}

/** Prompt reduced to its words, so the same question asked twice matches. */
export function promptKey(prompt: string): string {
  return prompt.toLowerCase().replace(/<[^>]+>/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function askedAt(question: QuestionBlock, row: any): number {
  return Date.parse(question.lastAskedAt ?? '') || new Date(row.createdAt).getTime()
}

export function isStale(question: QuestionBlock, row: any, now: Date = new Date()): boolean {
  return question.status === 'open' && now.getTime() - askedAt(question, row) > QUESTION_STALE_MS
}

const SCAN_SELECT = {
  id: true,
  conversationId: true,
  workspaceId: true,
  threadRootId: true,
  text: true,
  blocks: true,
  authorType: true,
  authorAgentRef: true,
  externalRef: true,
  createdAt: true,
  updatedAt: true,
}

/** Questions still open in a conversation, newest first. */
export async function listOpenQuestions(conversationId: string, now: Date = new Date()): Promise<OpenQuestion[]> {
  const rows = await db.conversationMessage.findMany({
    where: {
      conversationId,
      authorType: 'agent',
      deletedAt: null,
      // Folding a re-ask rewrites the original, so a question asked again stays in reach.
      updatedAt: { gte: new Date(now.getTime() - QUESTION_STALE_MS) },
    },
    orderBy: { updatedAt: 'desc' },
    take: CONVERSATION_SCAN_LIMIT,
    select: SCAN_SELECT,
  })
  return (rows as any[]).flatMap((row) =>
    questionsOf(row.blocks)
      .filter((q) => q.status === 'open' && !isStale(q, row, now))
      .map((question) => ({ row, question })),
  )
}

// ─── Recipients ──────────────────────────────────────────────────────────────

async function workspaceMembers(workspaceId: string, userIds: string[]): Promise<string[]> {
  const unique = [...new Set(userIds.filter(Boolean))]
  if (!unique.length) return []
  const rows = await db.member.findMany({
    where: { workspaceId, projectId: null, userId: { in: unique } },
    select: { userId: true },
  })
  const members = new Set(rows.map((r: any) => r.userId))
  return unique.filter((id) => members.has(id))
}

/**
 * Who an agent's question is for: the people it tagged; else the person whose
 * message started the run; else, in a direct conversation, its people; else
 * whoever started the thread; else anyone who can post in the channel.
 */
export async function resolveQuestionRecipients(row: any, conversation: any): Promise<QuestionRecipients> {
  const workspaceId = conversation.workspaceId
  const mentions = await db.conversationMention.findMany({
    where: { messageId: row.id, targetType: 'user' },
    select: { targetUserId: true },
  })
  const tagged = await workspaceMembers(workspaceId, mentions.map((m: any) => m.targetUserId))
  if (tagged.length) return { userIds: tagged, via: 'mention' }

  // An unprompted post roots its own chain, and its origin is whoever is billed, not someone who asked.
  const chain = readChain(row.agentChain)
  const origin = chain?.rootMessageId && chain.rootMessageId !== row.id ? chain.originUserId : null
  const runStarter = origin ? await workspaceMembers(workspaceId, [origin]) : []
  if (runStarter.length) return { userIds: runStarter, via: 'run' }

  if (conversation.kind === 'dm' || conversation.kind === 'group_dm') {
    const people = await workspaceMembers(workspaceId, (await conversationAudience(conversation)) ?? [])
    if (people.length) return { userIds: people, via: 'channel' }
  }

  if (row.threadRootId) {
    const root = await db.conversationMessage.findUnique({ where: { id: row.threadRootId }, select: { authorUserId: true } })
    const starter = root?.authorUserId ? await workspaceMembers(workspaceId, [root.authorUserId]) : []
    if (starter.length) return { userIds: starter, via: 'thread' }
  }
  return { userIds: [], anyone: true, via: 'channel' }
}

/** People who follow a thread: whoever started it and every person who replied. */
async function threadFollowers(row: any): Promise<string[]> {
  const rootId = row.threadRootId ?? row.id
  const rows = await db.conversationMessage.findMany({
    where: { OR: [{ id: rootId }, { threadRootId: rootId }], authorUserId: { not: null }, deletedAt: null },
    select: { authorUserId: true },
    distinct: ['authorUserId'],
    take: 50,
  })
  return rows.map((r: any) => r.authorUserId).filter(Boolean)
}

/** Who a question lands with: its recipients, or the thread's followers when anyone may answer. */
async function audienceOf(row: any, question: QuestionBlock): Promise<string[]> {
  return question.to.anyone ? threadFollowers(row) : question.to.userIds
}

// ─── Card writes ─────────────────────────────────────────────────────────────

const QUESTION_VALUE_PREFIX = 'q|'

/** `q|<messageId>|<questionId>|<option index>`, as set on a mirrored button. */
export function questionActionValue(messageId: string, questionId: string, index: number): string {
  return `${QUESTION_VALUE_PREFIX}${messageId}|${questionId}|${index}`
}

export function parseQuestionActionValue(value: string): { messageId: string; questionId: string; index: number } | null {
  if (!value.startsWith(QUESTION_VALUE_PREFIX)) return null
  const [messageId, questionId, index] = value.slice(QUESTION_VALUE_PREFIX.length).split('|')
  const n = Number(index)
  return messageId && questionId && Number.isInteger(n) && n >= 0 ? { messageId, questionId, index: n } : null
}

/** Buttons for the mirrored copy: the options of the first open single-pick question. */
export function questionActions(messageId: string, questions: QuestionBlock[]): OutboundAction[] {
  const first = questions.find((q) => q.status === 'open' && !q.multiSelect && questionOptions(q).length)
  if (!first) return []
  return questionOptions(first).map((o, i) => ({
    id: `question_${i}`,
    label: clip(o.label, 75),
    value: questionActionValue(messageId, first.id, i),
    kind: 'question' as const,
    ...(i === 0 ? { style: 'primary' as const } : {}),
  }))
}

async function userNames(userIds: string[]): Promise<Map<string, string>> {
  if (!userIds.length) return new Map()
  const users = await db.user.findMany({ where: { id: { in: [...new Set(userIds)] } }, select: { id: true, name: true, email: true } })
  return new Map(users.map((u: any) => [u.id, u.name || u.email]))
}

/**
 * The mirrored copy leads with the questions, so a long update cut short still
 * shows them, and links back to the app for answers buttons can't give.
 */
async function providerTextFor(row: any, questions: QuestionBlock[]): Promise<string> {
  if (!questions.length) return row.text
  const names = await userNames(questions.flatMap((q) => q.to.userIds))
  const rootId = row.threadRootId ?? row.id
  const link = `${getFrontendUrl()}/c/${encodeURIComponent(row.conversationId)}?thread=${encodeURIComponent(rootId)}`
  const lead = [questionsToMarkdown(questions, { users: names })]
  if (questions.some((q) => q.status === 'open')) lead.push(`[Answer in Shogo](${link})`)
  return [lead.join('\n\n'), row.text].filter(Boolean).join('\n\n———\n\n')
}

async function writeBlocks(row: any, blocks: MessageBlocks): Promise<any> {
  const questions = questionsOf(blocks)
  const mirrored = !!row.externalRef && questions.length > 0
  if (!mirrored) return updateMessageInternal(row.id, { blocks })
  const { message } = await rewriteMessage({
    messageId: row.id,
    blocks,
    actions: questionActions(row.id, questions),
    providerText: await providerTextFor(row, questions),
  })
  return message
}

// ─── Asking ──────────────────────────────────────────────────────────────────

export function newQuestionId(): string {
  return `q_${randomUUID().replace(/-/g, '').slice(0, 10)}`
}

function agentNameOf(row: any): string {
  return (row.authorAgentRef?.name as string | undefined)?.trim() || 'An agent'
}

function whoText(question: QuestionBlock, names: Map<string, string>): string {
  if (question.to.anyone) return 'the channel'
  const list = question.to.userIds.map((id) => `**${names.get(id) ?? 'someone'}**`)
  return list.length ? list.join(', ') : 'the channel'
}

async function activityAudience(conversation: any): Promise<string[] | null> {
  return isOpenKind(conversation.kind) ? null : (await conversationAudience(conversation)) ?? []
}

async function postQuestionActivity(
  conversation: any,
  row: any,
  question: QuestionBlock,
  event: 'asked' | 'answered' | 'closed',
  openText: string,
  privateText: string,
): Promise<void> {
  const visibleTo = await activityAudience(conversation)
  const { postActivity } = await import('./conversation-activity')
  await postActivity(conversation.workspaceId, {
    kind: event === 'asked' ? 'question.asked' : event === 'answered' ? 'question.answered' : 'question.closed',
    // `#activity` is searchable by everyone, so a private conversation's line names no content.
    text: visibleTo ? privateText : openText,
    ref: `question:${question.id}:${event}`,
    projectId: row.authorAgentRef?.projectId ?? null,
    actorUserId: event === 'answered' ? question.answer?.by.userId ?? null : null,
    meta: {
      conversationId: conversation.id,
      messageId: row.id,
      threadRootId: row.threadRootId ?? null,
      questionId: question.id,
      header: question.header,
      preview: clip(question.prompt, PREVIEW_CHARS),
      ...(event === 'answered' && question.answer ? { answer: clip(question.answer.text, PREVIEW_CHARS) } : {}),
      ...(visibleTo ? { visibleTo } : {}),
    },
  })
}

/** Alert recipients the post itself didn't: those tagged were notified by the mention. */
async function notifyRecipients(conversation: any, row: any, question: QuestionBlock, userIds: string[]): Promise<void> {
  if (!userIds.length) return
  const mentioned = await db.chatInboxItem.findMany({
    where: { messageId: row.id, kind: 'mention', userId: { in: userIds } },
    select: { userId: true },
  })
  const already = new Set(mentioned.map((m: any) => m.userId))
  const pending = userIds.filter((id) => !already.has(id))
  if (!pending.length) return
  const { notifyQuestion } = await import('./conversation-notifications')
  await notifyQuestion({
    conversation,
    row,
    userIds: pending,
    title: `${agentNameOf(row)} asked you: ${question.header}`,
    body: question.prompt,
  })
}

/** Side effects of a new question: `#activity`, inbox items, and an alert for its people. */
export async function onQuestionAsked(row: any, conversation: any, question: QuestionBlock): Promise<void> {
  const agent = agentNameOf(row)
  try {
    const names = await userNames(question.to.userIds)
    const who = whoText(question, names)
    await postQuestionActivity(
      conversation,
      row,
      question,
      'asked',
      `**${agent}** asked ${who}: ${clip(question.prompt, PREVIEW_CHARS)}`,
      `**${agent}** asked ${who} a question in a private conversation`,
    )
  } catch (err) {
    console.warn('[Questions] asked activity failed:', (err as Error).message)
  }
  try {
    const audience = await audienceOf(row, question)
    await createInboxItems(audience.map((userId) => ({
      workspaceId: conversation.workspaceId,
      userId,
      kind: 'question',
      conversationId: conversation.id,
      messageId: row.id,
      title: question.to.anyone ? `${agent} asked: ${question.header}` : `${agent} asked you: ${question.header}`,
      preview: question.prompt,
    })))
    await notifyRecipients(conversation, row, question, audience)
  } catch (err) {
    console.warn('[Questions] inbox failed:', (err as Error).message)
  }
}

/**
 * Put questions on an agent message. Each one that repeats a question still
 * open in the conversation (`sameAs`, or the same words) is folded into it.
 * Returns what was asked and what was folded.
 */
export async function attachQuestions(input: {
  messageId: string
  drafts: QuestionDraft[]
  source: 'agent' | 'inferred'
  /** For each draft, the id of the open question it repeats, if the designer found one. */
  sameAs?: Array<string | null>
  recipients?: QuestionRecipients
  now?: Date
}): Promise<{ asked: QuestionBlock[]; folded: QuestionRef[] }> {
  const now = input.now ?? new Date()
  const row = await db.conversationMessage.findUnique({ where: { id: input.messageId } })
  if (!row || row.deletedAt || row.authorType !== 'agent') return { asked: [], folded: [] }
  const conversation = await db.conversation.findUnique({ where: { id: row.conversationId } })
  if (!conversation || conversation.kind === 'activity') return { asked: [], folded: [] }

  const recipients = input.recipients ?? await resolveQuestionRecipients(row, conversation)
  const open = (await listOpenQuestions(conversation.id, now)).filter((o) => o.row.id !== row.id)
  const existing = questionsOf(row.blocks)
  const asked: QuestionBlock[] = []
  const folded: QuestionRef[] = []
  for (const [i, draft] of input.drafts.entries()) {
    const key = promptKey(draft.prompt)
    if (existing.some((q) => promptKey(q.prompt) === key) || asked.some((q) => promptKey(q.prompt) === key)) continue
    const sameAs = input.sameAs?.[i]
    const match = (sameAs && open.find((o) => o.question.id === sameAs)) || open.find((o) => promptKey(o.question.prompt) === key)
    if (match) {
      if (!folded.some((f) => f.questionId === match.question.id)) {
        await bumpAsk(match.row.id, match.question.id, now)
        folded.push({ messageId: match.row.id, questionId: match.question.id, header: match.question.header, prompt: match.question.prompt })
      }
      continue
    }
    const named = draft.userIds?.length ? await workspaceMembers(conversation.workspaceId, draft.userIds) : []
    const { userIds: _ids, ...shape } = draft
    asked.push({
      ...shape,
      id: newQuestionId(),
      to: named.length ? { userIds: named, via: 'mention' } : recipients,
      status: 'open',
      source: input.source,
      askCount: 1,
      lastAskedAt: now.toISOString(),
    })
  }

  const blocks: MessageBlocks = {
    ...((row.blocks as MessageBlocks | null) ?? {}),
    questionScan: input.source === 'agent' ? 'explicit' : 'done',
  }
  if (asked.length) {
    blocks.questions = [...existing, ...asked]
    if (kindOf(row.blocks) !== 'alert') blocks.messageKind = 'decision'
  }
  if (folded.length) blocks.questionRefs = [...questionRefsOf(row.blocks), ...folded]
  await writeBlocks(row, blocks)
  for (const question of asked) await onQuestionAsked({ ...row, blocks }, conversation, question)
  return { asked, folded }
}

/** A repeat of an open question: count it on the original instead of opening another card. */
async function bumpAsk(messageId: string, questionId: string, now: Date): Promise<void> {
  const row = await db.conversationMessage.findUnique({ where: { id: messageId } })
  if (!row) return
  const questions = questionsOf(row.blocks).map((q) =>
    q.id === questionId ? { ...q, askCount: (q.askCount ?? 1) + 1, lastAskedAt: now.toISOString() } : q,
  )
  await updateMessageInternal(row.id, { blocks: { ...(row.blocks ?? {}), questions } })
}

/** Mark a message as looked at, so the designer doesn't run on it again. */
export async function markScanned(messageId: string): Promise<void> {
  const row = await db.conversationMessage.findUnique({ where: { id: messageId }, select: { id: true, blocks: true } })
  if (!row || (row.blocks as MessageBlocks | null)?.questionScan) return
  await updateMessageInternal(row.id, { blocks: { ...(row.blocks ?? {}), questionScan: 'done' } })
}

// ─── Closing ─────────────────────────────────────────────────────────────────

/** Inbox items for a message's questions are read once none of them is open for that person. */
async function clearInboxItems(row: any, questions: QuestionBlock[]): Promise<void> {
  const items = await db.chatInboxItem.findMany({
    where: { messageId: row.id, kind: 'question', readAt: null },
    select: { id: true, userId: true, workspaceId: true },
  })
  if (!items.length) return
  const stillOpen = questions.filter((q) => q.status === 'open')
  const followers = stillOpen.some((q) => q.to.anyone) ? new Set(await threadFollowers(row)) : new Set<string>()
  const waiting = (userId: string) => stillOpen.some((q) => (q.to.anyone ? followers.has(userId) : q.to.userIds.includes(userId)))
  const done = (items as any[]).filter((item) => !waiting(item.userId))
  if (!done.length) return
  await db.chatInboxItem.updateMany({ where: { id: { in: done.map((i) => i.id) } }, data: { readAt: new Date() } })
  for (const userId of new Set(done.map((i) => i.userId as string))) {
    publishConversationEvent(row.workspaceId, { type: 'inbox.read', unread: await unreadInboxCount(row.workspaceId, userId) }, [userId])
  }
}

/** Side effects of a closed question: `#activity` and the inbox. */
export async function onQuestionClosed(row: any, conversation: any, question: QuestionBlock, questions: QuestionBlock[]): Promise<void> {
  const agent = agentNameOf(row)
  try {
    if (question.status === 'answered' && question.answer) {
      const by = question.answer.by.name
      await postQuestionActivity(
        conversation,
        row,
        question,
        'answered',
        `**${by}** answered **${agent}** — ${question.header}: ${clip(question.answer.text, PREVIEW_CHARS)}`,
        `**${by}** answered a question from **${agent}** in a private conversation`,
      )
    } else {
      const reason = question.closedReason ? `: ${question.closedReason}` : ''
      await postQuestionActivity(
        conversation,
        row,
        question,
        'closed',
        `**${agent}**'s question “${question.header}” was closed${reason}`,
        `A question from **${agent}** in a private conversation was closed`,
      )
    }
  } catch (err) {
    console.warn('[Questions] closed activity failed:', (err as Error).message)
  }
  try {
    await clearInboxItems(row, questions)
  } catch (err) {
    console.warn('[Questions] inbox clear failed:', (err as Error).message)
  }
}

const closing = new Set<string>()

/**
 * Close one open question: answered, superseded (no longer needed), or
 * dismissed. The first close wins; a question that is no longer open rejects it.
 */
export async function closeQuestion(input: {
  messageId: string
  questionId: string
  status: Exclude<QuestionStatus, 'open'>
  answer?: QuestionAnswer
  reason?: string
  secretCipher?: string
  now?: Date
}): Promise<{ message: any; question: QuestionBlock; row: any }> {
  const key = `${input.messageId}:${input.questionId}`
  if (closing.has(key)) throw new AgentMessageError(409, 'already_answered', 'Someone is already answering this')
  closing.add(key)
  try {
    const row = await db.conversationMessage.findUnique({ where: { id: input.messageId } })
    const current = row && !row.deletedAt ? questionsOf(row.blocks).find((q) => q.id === input.questionId) : null
    if (!row || !current) throw new AgentMessageError(404, 'not_found', 'Question not found')
    if (current.status !== 'open') {
      const by = current.answer ? ` by ${current.answer.by.name}` : ''
      throw new AgentMessageError(409, 'already_answered', `Already ${current.status}${by}`)
    }
    const now = input.now ?? new Date()
    const question: QuestionBlock = {
      ...current,
      status: input.status,
      closedAt: now.toISOString(),
      ...(input.answer ? { answer: input.answer } : {}),
      ...(input.reason ? { closedReason: clip(input.reason, 200) } : {}),
      ...(input.secretCipher ? { secretCipher: input.secretCipher } : {}),
    }
    const questions = questionsOf(row.blocks).map((q) => (q.id === question.id ? question : q))
    const blocks: MessageBlocks = { ...(row.blocks ?? {}), questions }
    const message = await writeBlocks(row, blocks)
    const conversation = await db.conversation.findUnique({ where: { id: row.conversationId } })
    if (conversation) await onQuestionClosed({ ...row, blocks }, conversation, question, questions)
    return { message, question, row: { ...row, blocks } }
  } finally {
    closing.delete(key)
  }
}

/** Close questions the asker (or another agent) says are no longer needed. */
export async function supersedeQuestions(questionIds: string[], conversationId: string, reason: string): Promise<number> {
  if (!questionIds.length) return 0
  const open = await listOpenQuestions(conversationId)
  let closed = 0
  for (const id of new Set(questionIds)) {
    const target = open.find((o) => o.question.id === id)
    if (!target) continue
    try {
      await closeQuestion({ messageId: target.row.id, questionId: id, status: 'superseded', reason })
      closed++
    } catch (err) {
      if (!(err instanceof AgentMessageError)) throw err
    }
  }
  return closed
}

// ─── Answering ───────────────────────────────────────────────────────────────

/** The tag that wakes the agent that asked: its project agent, or the workspace agent. */
function agentTag(row: any): string {
  const projectId = row.authorAgentRef?.projectId as string | null | undefined
  return projectId ? `<@a:p:${projectId}>` : '<@a:ws>'
}

/** Who may answer: the people it's for, or anyone who can post when it's open to the channel. */
export function canAnswer(question: QuestionBlock, userId: string): boolean {
  return !!question.to.anyone || question.to.userIds.includes(userId)
}

export interface AnswerInput {
  messageId: string
  questionId: string
  userId: string
  /** The answer as shown: picked option labels or free text. */
  answer?: string
  /** For `secret` questions; stored encrypted and never posted. */
  secret?: string
  origin?: 'app' | 'slack' | 'teams'
}

/**
 * A person answers a question. The card settles, and the answer is posted in
 * the thread as that person, tagging the agent that asked, so the agent wakes
 * through the normal channel pipeline.
 */
export async function answerQuestion(input: AnswerInput): Promise<{ message: any; question: QuestionBlock; reply: PostMessageResult }> {
  const row = await db.conversationMessage.findUnique({ where: { id: input.messageId } })
  const question = row && !row.deletedAt ? questionsOf(row.blocks).find((q) => q.id === input.questionId) : null
  if (!row || !question) throw new AgentMessageError(404, 'not_found', 'Question not found')
  const access = await loadAccess(row.conversationId, input.userId)
  if (access.role === 'viewer' || access.conversation.archivedAt) {
    throw new AgentMessageError(403, 'forbidden', 'You cannot answer questions in this conversation')
  }
  if (!canAnswer(question, input.userId)) {
    throw new AgentMessageError(403, 'forbidden', 'This question is for someone else')
  }

  let answerText: string
  let secretCipher: string | undefined
  if (question.interaction === 'secret') {
    const secret = (input.secret ?? '').trim()
    if (!secret) throw new AgentMessageError(400, 'empty', 'Enter a value')
    if (secret.length > MAX_SECRET_CHARS) throw new AgentMessageError(400, 'too_long', 'That value is too long')
    secretCipher = encryptSecret(secret)
    answerText = `Provided \`${question.secretName ?? 'the secret'}\``
  } else {
    answerText = clip((input.answer ?? '').replace(/\s+/g, ' ').trim(), MAX_ANSWER_CHARS)
    if (!answerText) throw new AgentMessageError(400, 'empty', 'Enter an answer')
  }

  const user = await db.user.findUnique({ where: { id: input.userId }, select: { name: true, email: true } }).catch(() => null)
  const by = { userId: input.userId, name: user?.name || user?.email || 'Someone' }
  const now = new Date()
  const closed = await closeQuestion({
    messageId: row.id,
    questionId: question.id,
    status: 'answered',
    answer: { text: answerText, by, at: now.toISOString() },
    secretCipher,
    now,
  })

  const where = question.interaction === 'secret'
    ? `\n\n_Read it with \`team_chat_question_secret\` (message \`${row.id}\`, question \`${question.id}\`)._`
    : ''
  const reply = await postMessage({
    conversationId: row.conversationId,
    text: `${agentTag(row)} **${question.header}:** ${answerText}${where}`,
    authorType: 'user',
    authorUserId: input.userId,
    threadRootId: row.threadRootId ?? row.id,
  })
  const { afterMessagePosted } = await import('./conversation-pipeline')
  void afterMessagePosted(reply, { actorUserId: input.userId, origin: input.origin ?? 'app' })
  return { message: closed.message, question: closed.question, reply }
}

/** Dismiss an open question; anyone who could answer it may. */
export async function dismissQuestion(input: { messageId: string; questionId: string; userId: string }) {
  const row = await db.conversationMessage.findUnique({ where: { id: input.messageId } })
  const question = row && !row.deletedAt ? questionsOf(row.blocks).find((q) => q.id === input.questionId) : null
  if (!row || !question) throw new AgentMessageError(404, 'not_found', 'Question not found')
  const access = await loadAccess(row.conversationId, input.userId)
  if (access.role === 'viewer') throw new AgentMessageError(403, 'forbidden', 'You cannot dismiss questions here')
  if (!canAnswer(question, input.userId) && access.role !== 'owner' && access.role !== 'admin') {
    throw new AgentMessageError(403, 'forbidden', 'This question is for someone else')
  }
  const user = await db.user.findUnique({ where: { id: input.userId }, select: { name: true, email: true } }).catch(() => null)
  return closeQuestion({ messageId: row.id, questionId: question.id, status: 'dismissed', reason: `dismissed by ${user?.name || user?.email || 'someone'}` })
}

/** The secret a person entered, for the agent that asked and no one else. */
export async function readQuestionSecret(input: {
  workspaceId: string
  messageId: string
  questionId: string
  projectId: string | null
}): Promise<{ name: string; value: string }> {
  const row = await db.conversationMessage.findUnique({ where: { id: input.messageId } })
  if (!row || row.deletedAt || row.workspaceId !== input.workspaceId || row.authorType !== 'agent') {
    throw new AgentMessageError(404, 'not_found', 'Question not found')
  }
  if ((row.authorAgentRef?.projectId ?? null) !== input.projectId) {
    throw new AgentMessageError(403, 'forbidden', 'Only the agent that asked can read this')
  }
  const question = questionsOf(row.blocks).find((q) => q.id === input.questionId)
  if (!question || question.interaction !== 'secret') throw new AgentMessageError(404, 'not_found', 'Question not found')
  if (!question.secretCipher) throw new AgentMessageError(409, 'unanswered', 'Nobody has entered it yet')
  return { name: question.secretName ?? 'SECRET', value: decryptSecret(question.secretCipher) }
}

// ─── Inbox ───────────────────────────────────────────────────────────────────

export interface QuestionListItem {
  messageId: string
  conversationId: string
  threadRootId: string | null
  conversation: { id: string; kind: string; name: string | null; slug: string | null }
  agent: { projectId: string | null; name: string; iconUrl: string | null }
  question: Omit<QuestionBlock, 'secretCipher'>
  askedAt: string
  /** For this person (or open to anyone). */
  mine: boolean
  canAnswer: boolean
}

export interface QuestionListOptions {
  status?: 'open' | 'answered' | 'all'
  scope?: 'mine' | 'all'
  now?: Date
}

/**
 * Questions a person can see in a workspace: from channels they can read
 * (open channels, or ones they belong to), newest first. Stale open ones are
 * closed on the way.
 */
export async function listQuestions(workspaceId: string, userId: string, opts: QuestionListOptions = {}): Promise<{ items: QuestionListItem[]; openCount: number }> {
  const now = opts.now ?? new Date()
  const status = opts.status ?? 'open'
  const scope = opts.scope ?? 'mine'
  const role = await getWorkspaceRole(workspaceId, userId)
  if (!role) return { items: [], openCount: 0 }
  const lookback = status === 'open' ? QUESTION_STALE_MS + 24 * 60 * 60_000 : Math.max(ANSWERED_LOOKBACK_MS, QUESTION_STALE_MS)
  const rows = await db.conversationMessage.findMany({
    where: {
      workspaceId,
      authorType: 'agent',
      deletedAt: null,
      updatedAt: { gte: new Date(now.getTime() - lookback) },
      conversation: {
        archivedAt: null,
        OR: [{ kind: 'public' }, { members: { some: { userId } } }],
      },
    },
    orderBy: { updatedAt: 'desc' },
    take: WORKSPACE_SCAN_LIMIT,
    select: { ...SCAN_SELECT, conversation: { select: { id: true, kind: true, name: true, slug: true } } },
  })

  const items: QuestionListItem[] = []
  const stale: Array<{ messageId: string; questionId: string }> = []
  let openCount = 0
  const followerCache = new Map<string, Set<string>>()
  for (const row of rows as any[]) {
    for (const q of questionsOf(row.blocks)) {
      if (isStale(q, row, now)) {
        stale.push({ messageId: row.id, questionId: q.id })
        continue
      }
      let mine = q.to.userIds.includes(userId)
      if (!mine && q.to.anyone) {
        const rootId = row.threadRootId ?? row.id
        if (!followerCache.has(rootId)) followerCache.set(rootId, new Set(await threadFollowers(row)))
        mine = followerCache.get(rootId)!.has(userId) || row.conversation.kind !== 'public'
      }
      if (mine && q.status === 'open') openCount++
      if (scope === 'mine' && !mine) continue
      if (status === 'open' && q.status !== 'open') continue
      if (status === 'answered' && q.status === 'open') continue
      const { secretCipher: _secret, ...question } = q
      items.push({
        messageId: row.id,
        conversationId: row.conversationId,
        threadRootId: row.threadRootId ?? null,
        conversation: row.conversation,
        agent: {
          projectId: row.authorAgentRef?.projectId ?? null,
          name: row.authorAgentRef?.name ?? 'Agent',
          iconUrl: row.authorAgentRef?.iconUrl ?? null,
        },
        question,
        askedAt: new Date(askedAt(q, row)).toISOString(),
        mine,
        canAnswer: role !== 'viewer' && q.status === 'open' && canAnswer(q, userId),
      })
    }
  }
  if (stale.length) void closeStale(stale)
  items.sort((a, b) => Date.parse(b.askedAt) - Date.parse(a.askedAt))
  return { items, openCount }
}

const STALE_DAYS = Math.round(QUESTION_STALE_MS / (24 * 60 * 60_000))

async function closeStale(list: Array<{ messageId: string; questionId: string }>): Promise<void> {
  for (const item of list) {
    await closeQuestion({ ...item, status: 'dismissed', reason: `no answer in ${STALE_DAYS} days` }).catch((err) => {
      if (!(err instanceof AgentMessageError)) console.warn('[Questions] stale close failed:', (err as Error).message)
    })
  }
}

export function _resetQuestionsForTests(): void {
  closing.clear()
}
