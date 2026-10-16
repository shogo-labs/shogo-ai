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
 *
 * Questions an agent asks people ride along in `blocks.questions`; the text
 * stays the agent's own prose.
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

/** An account the agent needs someone to connect before it can carry on (GitHub, a Composio app). */
export interface IntegrationConnectRequest {
  provider: string
  connectUrl: string
  message?: string
}

export interface MessageBlocks {
  type?: 'status_card' | 'approval_request'
  messageKind?: MessageKind
  card?: StatusCard
  work?: AgentWork
  /** Connect links the agent hit during the run, shown as cards on its reply. */
  connect?: IntegrationConnectRequest[]
  /** Questions this message asks people; see `conversation-questions`. */
  questions?: QuestionBlock[]
  /** Open questions asked again here; the card lives on the original message. */
  questionRefs?: QuestionRef[]
  /** `explicit`: the agent passed questions; `done`: the designer has looked at it. */
  questionScan?: 'explicit' | 'done'
  [key: string]: unknown
}

// ─── Questions ───────────────────────────────────────────────────────────────

export const QUESTION_INTERACTIONS = ['choice', 'confirm', 'text', 'person', 'secret'] as const
export type QuestionInteraction = (typeof QUESTION_INTERACTIONS)[number]
export type QuestionStatus = 'open' | 'answered' | 'superseded' | 'dismissed'
export type QuestionVia = 'mention' | 'run' | 'thread' | 'channel'

export interface QuestionOption {
  label: string
  description?: string
}

export interface QuestionRecipients {
  userIds: string[]
  /** Nobody in particular: any member who can post in the channel may answer. */
  anyone?: boolean
  via: QuestionVia
}

export interface QuestionAnswer {
  text: string
  by: { userId: string | null; name: string }
  at: string
  /** When the answer was posted to the agent; answers to one card go in one reply. */
  relayedAt?: string
}

export interface QuestionBlock {
  id: string
  to: QuestionRecipients
  header: string
  prompt: string
  interaction: QuestionInteraction
  options?: QuestionOption[]
  multiSelect?: boolean
  /** Input hint for `text` questions. */
  hint?: 'number' | 'url'
  /** Environment-style name for `secret` questions, e.g. `ENSEMBLEDATA_API_TOKEN`. */
  secretName?: string
  status: QuestionStatus
  answer?: QuestionAnswer
  closedReason?: string
  closedAt?: string
  source: 'agent' | 'inferred'
  askCount?: number
  lastAskedAt?: string
  /** Encrypted secret answer. Never leaves the API except to the agent that asked. */
  secretCipher?: string
}

export interface QuestionRef {
  messageId: string
  questionId: string
  header: string
  prompt: string
}

/** A question as an agent or the designer proposes it, before it has recipients and an id. */
export interface QuestionDraft {
  header: string
  prompt: string
  interaction: QuestionInteraction
  options?: QuestionOption[]
  multiSelect?: boolean
  hint?: 'number' | 'url'
  secretName?: string
  /** Who it is for, when the asker named people. */
  userIds?: string[]
}

export const CONFIRM_OPTIONS: QuestionOption[] = [
  { label: 'Approve' },
  { label: 'Not yet' },
  { label: 'Discuss' },
]

const MAX_QUESTIONS = 4
const MAX_HEADER = 40
const MAX_PROMPT = 500
const MAX_OPTIONS = 6
const MAX_OPTION_LABEL = 80
const MAX_OPTION_DESCRIPTION = 200
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/

function cleanString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

/** `ENSEMBLEDATA_API_TOKEN` from a name or header the asker gave. */
export function secretNameFrom(value: string): string | null {
  const name = value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[0-9_]+/, '').slice(0, 64)
  return SECRET_NAME_RE.test(name) ? name : null
}

function normalizeDraft(value: unknown): QuestionDraft | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const prompt = cleanString(v.prompt ?? v.question, MAX_PROMPT)
  if (!prompt) return null
  const header = cleanString(v.header, MAX_HEADER) || prompt.slice(0, MAX_HEADER)
  let interaction: QuestionInteraction = (QUESTION_INTERACTIONS as readonly string[]).includes(v.interaction as string)
    ? (v.interaction as QuestionInteraction)
    : Array.isArray(v.options) && v.options.length ? 'choice' : 'text'
  const options = Array.isArray(v.options)
    ? v.options
        .map((o) => (typeof o === 'string' ? { label: o } : o))
        .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
        .map((o) => ({ label: cleanString(o.label, MAX_OPTION_LABEL), description: cleanString(o.description, MAX_OPTION_DESCRIPTION) }))
        .filter((o) => o.label)
        .map((o) => (o.description ? o : { label: o.label }))
        .slice(0, MAX_OPTIONS)
    : []
  // A choice needs something to choose between; with fewer than two it is a free answer.
  if (interaction === 'choice' && options.length < 2) interaction = 'text'
  const draft: QuestionDraft = { header, prompt, interaction }
  if (interaction === 'choice') {
    draft.options = options
    if (v.multiSelect === true) draft.multiSelect = true
  }
  if (interaction === 'text' && (v.hint === 'number' || v.hint === 'url')) draft.hint = v.hint
  if (interaction === 'secret') {
    const name = (typeof v.secretName === 'string' && secretNameFrom(v.secretName)) || secretNameFrom(header)
    if (!name) return null
    draft.secretName = name
  }
  const userIds = Array.isArray(v.userIds) ? v.userIds.filter((id): id is string => typeof id === 'string' && !!id.trim()) : []
  if (userIds.length) draft.userIds = [...new Set(userIds)].slice(0, 20)
  return draft
}

/** Validate questions from an agent's tool call or the designer; drops the ones that aren't usable. */
export function normalizeQuestionDrafts(value: unknown): QuestionDraft[] {
  if (!Array.isArray(value)) return []
  return value.map(normalizeDraft).filter((d): d is QuestionDraft => d !== null).slice(0, MAX_QUESTIONS)
}

export function questionsOf(blocks: unknown): QuestionBlock[] {
  const list = (blocks as MessageBlocks | null | undefined)?.questions
  return Array.isArray(list) ? list.filter((q) => q && typeof q.id === 'string' && typeof q.prompt === 'string') : []
}

export function questionRefsOf(blocks: unknown): QuestionRef[] {
  const list = (blocks as MessageBlocks | null | undefined)?.questionRefs
  return Array.isArray(list) ? list.filter((r) => r && typeof r.messageId === 'string' && typeof r.questionId === 'string') : []
}

/** Options a person picks from: the confirm set for `confirm`, the asker's for `choice`. */
export function questionOptions(q: Pick<QuestionBlock, 'interaction' | 'options'>): QuestionOption[] {
  if (q.interaction === 'confirm') return CONFIRM_OPTIONS
  return q.interaction === 'choice' ? q.options ?? [] : []
}

/** Blocks as clients see them: secret answers stay on the server. */
export function publicBlocks(blocks: unknown): unknown {
  const questions = (blocks as MessageBlocks | null | undefined)?.questions
  if (!Array.isArray(questions) || !questions.some((q) => q?.secretCipher)) return blocks
  return {
    ...(blocks as MessageBlocks),
    questions: questions.map(({ secretCipher: _secret, ...q }) => q),
  }
}

const QUESTION_STATUS_TEXT: Record<Exclude<QuestionStatus, 'open'>, string> = {
  answered: 'Answered',
  superseded: 'No longer needed',
  dismissed: 'Dismissed',
}

/** Markdown for providers and transcripts that can't render question cards. */
export function questionsToMarkdown(questions: QuestionBlock[], names: { users?: Map<string, string> } = {}): string {
  return questions
    .map((q) => {
      const who = q.to.anyone
        ? 'anyone'
        : q.to.userIds.map((id) => `@${names.users?.get(id) ?? 'someone'}`).join(', ')
      const lines = [`❓ **${q.header}** (for ${who}) — ${q.prompt}`]
      const options = questionOptions(q)
      if (q.status === 'open' && options.length) lines.push(options.map((o) => o.label).join(' · '))
      if (q.status === 'answered' && q.answer) lines.push(`_${QUESTION_STATUS_TEXT.answered} by ${q.answer.by.name}: ${q.answer.text}_`)
      else if (q.status !== 'open') lines.push(`_${QUESTION_STATUS_TEXT[q.status]}${q.closedReason ? ` — ${q.closedReason}` : ''}_`)
      return lines.join('\n')
    })
    .join('\n\n')
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
