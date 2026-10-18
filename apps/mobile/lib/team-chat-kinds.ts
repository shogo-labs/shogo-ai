// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Message kinds and status cards on the client: what an agent's post is for
 * (status, result, decision, alert), the card an agent keeps up to date in
 * place, and how runs of routine status posts collapse into one row.
 * Mirrors the API's `conversation-message-kind`.
 */
import type { ChatMessage } from './team-chat-api'

export type MessageKind = 'status' | 'result' | 'decision' | 'alert'
export type CardStatus = 'working' | 'blocked' | 'done' | 'failed'

export interface StatusCard {
  title: string
  status: CardStatus
  step?: number
  steps?: string[]
  links?: Array<{ label: string; url: string }>
  criteria?: string[]
  summary?: string
}

const KINDS: readonly string[] = ['status', 'result', 'decision', 'alert']

export function messageKind(message: Pick<ChatMessage, 'blocks'>): MessageKind | null {
  const kind = (message.blocks as { messageKind?: unknown } | null)?.messageKind
  return typeof kind === 'string' && KINDS.includes(kind) ? (kind as MessageKind) : null
}

/** The message's status card, if it is one. */
export function statusCardOf(message: Pick<ChatMessage, 'blocks'>): StatusCard | null {
  const blocks = message.blocks as { type?: unknown; card?: StatusCard } | null
  if (blocks?.type !== 'status_card' || !blocks.card || typeof blocks.card.title !== 'string') return null
  return blocks.card
}

/** A board card's post in a channel; see the API's `workItemBlock()`. */
export interface WorkItemBlock {
  id: string
  key: string
  /** The full card title, not the clipped one in `card.title`. */
  title: string
  boardId?: string
  boardName?: string | null
  column?: { name: string; category: string } | null
  priority?: string
  assignee?: { kind: 'user' | 'agent'; name: string } | null
  dueAt?: string | null
  path?: string
  note?: string
}

/**
 * The board card a message is about, if it carries one. Author-agnostic: board
 * posts come from `system`. Blocks posted before cards carried a title have no
 * `title` and are left to the plain-text fallback.
 */
export function workItemOf(message: Pick<ChatMessage, 'blocks'>): WorkItemBlock | null {
  const block = (message.blocks as { workItem?: WorkItemBlock } | null)?.workItem
  if (!block || typeof block.id !== 'string' || typeof block.key !== 'string' || typeof block.title !== 'string') return null
  return block
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired'

/** An action an agent is waiting for a person to approve. */
export interface ApprovalCard {
  requestId: string
  toolName: string
  summary: string
  reason?: string
  status: ApprovalStatus
  decidedBy?: { userId: string | null; name: string }
}

/** The message's approval request, if it is one. */
export function approvalOf(message: Pick<ChatMessage, 'blocks'>): ApprovalCard | null {
  const blocks = message.blocks as { type?: unknown; approval?: ApprovalCard } | null
  if (blocks?.type !== 'approval_request' || !blocks.approval || typeof blocks.approval.requestId !== 'string') return null
  return blocks.approval
}

export type QuestionInteraction = 'choice' | 'confirm' | 'text' | 'person' | 'secret'
export type QuestionStatus = 'open' | 'answered' | 'superseded' | 'dismissed'

export interface QuestionOption {
  label: string
  description?: string
}

/** Something an agent needs a person to answer, shown as a card on its message. */
export interface Question {
  id: string
  to: { userIds: string[]; anyone?: boolean; via: 'mention' | 'run' | 'thread' | 'channel' }
  header: string
  prompt: string
  interaction: QuestionInteraction
  options?: QuestionOption[]
  multiSelect?: boolean
  hint?: 'number' | 'url'
  secretName?: string
  status: QuestionStatus
  answer?: { text: string; by: { userId: string; name: string }; at: string; relayedAt?: string }
  closedReason?: string
  closedAt?: string
  source: 'agent' | 'inferred'
  askCount?: number
  lastAskedAt?: string
}

/** A later message asking again for a question that is still open on an earlier one. */
export interface QuestionRef {
  messageId: string
  questionId: string
  header: string
  prompt: string
}

const INTERACTIONS: readonly string[] = ['choice', 'confirm', 'text', 'person', 'secret']

export const CONFIRM_OPTIONS: QuestionOption[] = [{ label: 'Approve' }, { label: 'Not yet' }, { label: 'Discuss' }]

export function questionsOf(message: Pick<ChatMessage, 'blocks'>): Question[] {
  const list = (message.blocks as { questions?: unknown } | null)?.questions
  if (!Array.isArray(list)) return []
  return list.filter(
    (q): q is Question =>
      !!q && typeof q === 'object' && typeof (q as Question).id === 'string' && typeof (q as Question).prompt === 'string' && INTERACTIONS.includes((q as Question).interaction),
  )
}

export function questionRefsOf(message: Pick<ChatMessage, 'blocks'>): QuestionRef[] {
  const list = (message.blocks as { questionRefs?: unknown } | null)?.questionRefs
  if (!Array.isArray(list)) return []
  return list.filter((r): r is QuestionRef => !!r && typeof (r as QuestionRef).messageId === 'string' && typeof (r as QuestionRef).questionId === 'string')
}

/** The buttons a choice or confirm question offers. */
export function questionOptions(q: Question): QuestionOption[] {
  if (q.interaction === 'confirm') return q.options?.length ? q.options : CONFIRM_OPTIONS
  return q.interaction === 'choice' ? q.options ?? [] : []
}

/** Whether `userId` is asked: named on it, or anyone may answer. */
export function isAskedOf(q: Question, userId: string | null): boolean {
  return !!q.to.anyone || (!!userId && q.to.userIds.includes(userId))
}

export type StepState = 'done' | 'current' | 'pending'

/** Done before `step`, current at it, pending after; a finished card has every step done. */
export function stepStates(card: StatusCard): StepState[] {
  const steps = card.steps ?? []
  const at = card.status === 'done' ? steps.length : card.step ?? 0
  return steps.map((_, i) => (i < at ? 'done' : i === at ? 'current' : 'pending'))
}

/** 0..1 progress through a card's steps. */
export function cardProgress(card: StatusCard): number {
  const steps = card.steps ?? []
  if (card.status === 'done') return 1
  if (!steps.length) return 0
  return Math.min(1, Math.max(0, (card.step ?? 0) / steps.length))
}

/** A routine progress post that can fold into a run: agent-written, kind `status`, plain text. */
export function isCollapsibleStatus(message: ChatMessage): boolean {
  return (
    message.authorType === 'agent' &&
    messageKind(message) === 'status' &&
    !statusCardOf(message) &&
    message.agentStatus !== 'running' &&
    !message.deletedAt &&
    !message.pending &&
    message.attachments.length === 0 &&
    message.replyCount === 0
  )
}

const sameAgent = (a: ChatMessage, b: ChatMessage) =>
  (a.authorAgent?.projectId ?? null) === (b.authorAgent?.projectId ?? null) && a.threadRootId === b.threadRootId

export interface TimelineItem {
  /** The message shown; for a run, the latest one. */
  message: ChatMessage
  /** Earlier posts folded into this one, oldest first. Empty for an ordinary message. */
  folded: ChatMessage[]
}

/**
 * Oldest-first items with each run of `minRun`+ consecutive routine status posts
 * from one agent in one thread folded into a single item.
 */
export function foldStatusRuns(messages: ChatMessage[], minRun = 2): TimelineItem[] {
  const items: TimelineItem[] = []
  let i = 0
  while (i < messages.length) {
    const m = messages[i]!
    if (!isCollapsibleStatus(m)) {
      items.push({ message: m, folded: [] })
      i++
      continue
    }
    let j = i + 1
    while (j < messages.length && isCollapsibleStatus(messages[j]!) && sameAgent(m, messages[j]!)) j++
    if (j - i >= minRun) {
      items.push({ message: messages[j - 1]!, folded: messages.slice(i, j - 1) })
    } else {
      for (let k = i; k < j; k++) items.push({ message: messages[k]!, folded: [] })
    }
    i = j
  }
  return items
}

/** Where an agent's final message keeps what it did first. */
export interface AgentWork {
  chatMessageId: string
  startedAt: number
  completedAt: number
  toolCalls: number
}

/** An account the agent needs someone to connect before it can carry on. */
export interface ConnectRequest {
  provider: string
  connectUrl: string
  message?: string
}

export function connectRequestsOf(message: Pick<ChatMessage, 'blocks'>): ConnectRequest[] {
  const list = (message.blocks as { connect?: unknown } | null)?.connect
  if (!Array.isArray(list)) return []
  return list.filter(
    (c): c is ConnectRequest =>
      !!c && typeof c === 'object' && typeof (c as ConnectRequest).provider === 'string' && /^https?:\/\//i.test(String((c as ConnectRequest).connectUrl)),
  )
}

export function workOf(message: Pick<ChatMessage, 'blocks'>): AgentWork | null {
  const work = (message.blocks as { work?: AgentWork } | null)?.work
  return work && typeof work.chatMessageId === 'string' && typeof work.startedAt === 'number' ? work : null
}
