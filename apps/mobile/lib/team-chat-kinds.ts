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

export function workOf(message: Pick<ChatMessage, 'blocks'>): AgentWork | null {
  const work = (message.blocks as { work?: AgentWork } | null)?.work
  return work && typeof work.chatMessageId === 'string' && typeof work.startedAt === 'number' ? work : null
}
