// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What an agent's channel message is for, so a busy channel stays readable.
 *
 *   status    routine progress ("running tests"); collapsed, never notifies
 *   result    a finished piece of work (PR, preview, report); quiet by default
 *   decision  needs a person to choose or approve; notifies thread followers
 *   alert     something broke or is blocked; notifies thread followers
 *
 * A message can also carry a status card: one message an agent edits in place
 * as work moves, instead of posting every step. The kind and card live in the
 * message's `blocks` JSON (`messageKind`, `type: 'status_card'`), and the
 * message `text` always holds a Markdown rendering so providers without rich
 * messages, search, and agent transcripts all see the same content.
 */

export const MESSAGE_KINDS = ['status', 'result', 'decision', 'alert'] as const
export type MessageKind = (typeof MESSAGE_KINDS)[number]

/** Kinds that interrupt people; the rest stay in the timeline and the digest. */
export const NOTIFYING_KINDS: ReadonlySet<MessageKind> = new Set(['decision', 'alert'])

export const CARD_STATUSES = ['working', 'blocked', 'done', 'failed'] as const
export type CardStatus = (typeof CARD_STATUSES)[number]

export interface StatusCard {
  title: string
  status: CardStatus
  /** Index into `steps` of the step in progress (0-based). Past the end means every step is done. */
  step?: number
  steps?: string[]
  links?: Array<{ label: string; url: string }>
  /** What "done" means; pinned on the card so a reviewer can work from it alone. */
  criteria?: string[]
  /** Outcome, filled in when the work finishes. */
  summary?: string
}

/** Where to find what an agent did before its final message: its turn in the agent session. */
export interface AgentWork {
  chatMessageId: string
  startedAt: number
  completedAt: number
  toolCalls: number
}

export interface MessageBlocks {
  type?: 'status_card' | 'approval_request'
  messageKind?: MessageKind
  card?: StatusCard
  work?: AgentWork
  [key: string]: unknown
}

const MAX_TITLE = 160
const MAX_STEPS = 12
const MAX_STEP_LEN = 80
const MAX_LINKS = 8
const MAX_CRITERIA = 12
const MAX_CRITERION_LEN = 300
const MAX_SUMMARY = 2000

export function normalizeKind(value: unknown): MessageKind | null {
  return typeof value === 'string' && (MESSAGE_KINDS as readonly string[]).includes(value) ? (value as MessageKind) : null
}

function cleanStrings(value: unknown, max: number, len: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim().slice(0, len))
    .filter(Boolean)
    .slice(0, max)
  return out.length ? out : undefined
}

/** Validate a card from an agent's tool call; null when it isn't usable. */
export function normalizeCard(value: unknown): StatusCard | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const title = typeof v.title === 'string' ? v.title.trim().slice(0, MAX_TITLE) : ''
  if (!title) return null
  const status = (CARD_STATUSES as readonly string[]).includes(v.status as string) ? (v.status as CardStatus) : 'working'
  const steps = cleanStrings(v.steps, MAX_STEPS, MAX_STEP_LEN)
  const links = Array.isArray(v.links)
    ? v.links
        .filter((l): l is { label?: unknown; url: string } => !!l && typeof (l as any).url === 'string' && /^https?:\/\//i.test((l as any).url))
        .map((l) => ({ label: (typeof l.label === 'string' && l.label.trim() ? l.label.trim() : l.url).slice(0, 80), url: l.url.slice(0, 500) }))
        .slice(0, MAX_LINKS)
    : []
  const step = typeof v.step === 'number' && Number.isFinite(v.step) && steps ? Math.max(0, Math.min(Math.floor(v.step), steps.length)) : undefined
  const criteria = cleanStrings(v.criteria, MAX_CRITERIA, MAX_CRITERION_LEN)
  const summary = typeof v.summary === 'string' && v.summary.trim() ? v.summary.trim().slice(0, MAX_SUMMARY) : undefined
  return {
    title,
    status,
    ...(steps ? { steps } : {}),
    ...(step !== undefined ? { step } : {}),
    ...(links.length ? { links } : {}),
    ...(criteria ? { criteria } : {}),
    ...(summary ? { summary } : {}),
  }
}

const STATUS_LABEL: Record<CardStatus, string> = { working: 'In progress', blocked: 'Blocked', done: 'Done', failed: 'Failed' }

/** Per-step state implied by the card: done before `step`, current at `step`, pending after. */
export function stepStates(card: StatusCard): Array<'done' | 'current' | 'pending'> {
  const steps = card.steps ?? []
  const at = card.status === 'done' ? steps.length : card.step ?? 0
  return steps.map((_, i) => (i < at ? 'done' : i === at ? 'current' : 'pending'))
}

/** Markdown for providers and transcripts that can't render the card. */
export function cardToMarkdown(card: StatusCard): string {
  const lines = [`**${card.title}** — ${STATUS_LABEL[card.status]}`]
  if (card.steps?.length) {
    const marks = { done: '✅', current: '🔄', pending: '⬜' } as const
    const states = stepStates(card)
    lines.push(card.steps.map((s, i) => `${marks[states[i]]} ${s}`).join('\n'))
  }
  if (card.criteria?.length) lines.push(`**Done when**\n${card.criteria.map((c) => `- ${c}`).join('\n')}`)
  if (card.links?.length) lines.push(card.links.map((l) => `[${l.label}](${l.url})`).join(' · '))
  if (card.summary) lines.push(card.summary)
  return lines.join('\n\n')
}

/** `blocks` for an agent message with the given kind and card; undefined when it has neither. */
export function blocksForKind(input: { kind?: MessageKind | null; card?: StatusCard | null; existing?: unknown }): MessageBlocks | undefined {
  const base = input.existing && typeof input.existing === 'object' ? { ...(input.existing as MessageBlocks) } : {}
  if (input.kind) base.messageKind = input.kind
  if (input.card) {
    base.type = 'status_card'
    base.card = input.card
  }
  return Object.keys(base).length ? base : undefined
}

export function kindOf(blocks: unknown): MessageKind | null {
  return normalizeKind((blocks as MessageBlocks | null | undefined)?.messageKind)
}

/** True when a message from an agent should interrupt people who haven't opted in to every message. */
export function interrupts(blocks: unknown): boolean {
  const kind = kindOf(blocks)
  return kind ? NOTIFYING_KINDS.has(kind) : true
}
