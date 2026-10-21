// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The conversation a server-initiated turn must carry (SHO-137).
 *
 * A turn a person types resends the whole thread, so the runtime can rebuild an
 * empty session from it. Every other turn — a background-task wake, a queued
 * message, a scheduled run, a team-chat dispatch — sends exactly one message.
 * If the runtime had evicted or lost the session, that turn reached the model as
 * a single line and the agent had no idea what the conversation was about.
 *
 * `ChatSession`/`ChatMessage` is the durable copy of that conversation (it is
 * what the chat panel renders, and it is not on the pod whose session was
 * evicted), so this is where a turn's context is assembled from:
 *
 *   summary            everything older than the retained tail, as one stable
 *                      block, persisted on the ChatSession so it survives a
 *                      restart that takes the runtime's own summary with it
 *   messages           the tail of the conversation, within a char budget
 *
 * Nothing here ever drops a message silently: what is not sent verbatim is
 * covered by the summary, and a summary that cannot be generated falls back to
 * an extractive block rather than to nothing.
 */

import { prisma } from '../lib/prisma'

/** Characters of conversation a single turn restores before summarising. */
export const HISTORY_SEED_BUDGET_CHARS = 60_000
/** Newest messages that are always sent verbatim when they fit. */
export const HISTORY_SEED_TAIL_MESSAGES = 10
/** How many of the newest rows to scan when fitting the budget. */
const HISTORY_SCAN_LIMIT = 400
/** Rows handed to the summarizer in one call. */
const SUMMARY_INPUT_LIMIT = 150
/** The summary is regenerated only once this many more messages fall behind. */
const SUMMARY_MIN_NEW_MESSAGES = 20
/** Hard cap on the stored summary, so the block stays a stable, small prefix. */
export const CONTEXT_SUMMARY_MAX_CHARS = 6_000

export interface SeedMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface ChatHistorySeed {
  /** Everything older than `messages`, already condensed. Stable bytes. */
  summary: string | null
  /** Oldest first, ending with the message before the turn being started. */
  messages: SeedMessage[]
  /** How many stored messages the summary stands in for. */
  summaryThrough: number
}

interface StoredRow {
  id: string
  role: string
  content: string
  createdAt: Date
}

type Summarizer = (input: {
  sessionId: string
  label: string
  messages: SeedMessage[]
}) => Promise<string | null>

function messageText(row: StoredRow): string {
  // A row's `content` is the display text; `parts` can carry tool envelopes
  // that mean nothing to a rebuilt transcript.
  return (row.content ?? '').trim()
}

/**
 * Fit `rows` (oldest first) into `budgetChars` from the tail. Always keeps at
 * least `minMessages` when the conversation is non-empty, so a single huge
 * message cannot leave the turn with nothing.
 */
export function fitTranscriptTail(
  rows: Array<{ text: string }>,
  budgetChars: number,
  minMessages: number,
): { start: number; chars: number } {
  let chars = 0
  let start = rows.length
  while (start > 0) {
    const next = rows[start - 1]!.text.length
    if (start < rows.length && chars + next > budgetChars && rows.length - start >= minMessages) break
    chars += next
    start--
  }
  return { start, chars }
}

/**
 * A summary that needs no model: what each turn asked for and what the agent
 * answered, in order. Used when the summarizer is unavailable, so a large
 * conversation still arrives with its shape rather than as a bare tail.
 */
export function extractiveSummary(label: string, messages: SeedMessage[]): string {
  const lines: string[] = [`Conversation so far (${label}):`]
  for (const message of messages) {
    const body = message.text.replace(/\s+/g, ' ').trim()
    if (!body) continue
    const speaker = message.role === 'user' ? 'Asked' : 'Answered'
    lines.push(`- ${speaker}: ${body.length > 220 ? `${body.slice(0, 219).trimEnd()}…` : body}`)
    if (lines.length >= 60) break
  }
  return lines.join('\n').slice(0, CONTEXT_SUMMARY_MAX_CHARS)
}

const SUMMARY_SYSTEM = [
  'You condense the earlier part of one ongoing conversation so the same agent can continue it later without the full transcript.',
  'Write a plain-text briefing, at most 2200 characters, in these blocks and nothing else:',
  'WHAT THIS IS — one or two sentences on the task or topic.',
  'DECIDED — decisions and constraints that must hold (bullets).',
  'FILES AND TOOLS — paths, repos, branches, commands or tools that matter (bullets).',
  'STATE — what is done, what is in progress, what is blocked (bullets).',
  'OPEN — what still has to happen next (bullets).',
  'Never narrate the conversation, never invent, and never say "the user asked". Facts only.',
].join(' ')

async function modelSummarizer(input: {
  sessionId: string
  label: string
  messages: SeedMessage[]
}): Promise<string | null> {
  const { resolveLanguageModel } = await import('../lib/resolve-language-model')
  const { getSummarizerModelId } = await import('../lib/summarizer-model')
  const { generateText } = await import('ai')
  const modelId = await getSummarizerModelId()
  // Same internal usage tag as title/activity generation: this is platform
  // bookkeeping, not a billed user turn.
  const resolved = resolveLanguageModel(modelId, {
    headers: { 'x-shogo-usage-tag': 'context_summary' },
  })
  if (!resolved) return null
  const transcript = input.messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Agent'}: ${m.text}`)
    .join('\n\n')
  const result = await generateText({
    model: resolved as any,
    system: SUMMARY_SYSTEM,
    prompt: `Conversation: ${input.label}\n\n${transcript}`,
    maxOutputTokens: 900,
  })
  const text = (result.text ?? '').trim()
  return text ? text.slice(0, CONTEXT_SUMMARY_MAX_CHARS) : null
}

let summarizer: Summarizer = modelSummarizer

/** Test seam: replace the model call. Pass null to restore it. */
export function setChatContextSummarizer(next: Summarizer | null): void {
  summarizer = next ?? modelSummarizer
}

export interface DurableSummaryArgs {
  /** The ChatSession the block is stored on. */
  sessionId: string
  /** What this conversation is called, for the summarizer prompt. */
  label: string
  /** The summary already stored, if any. */
  existing: string | null
  /** How much of the conversation that summary covers. */
  existingThrough: number
  /** How much the caller needs covered now. */
  through: number
  /** The messages that will not be sent verbatim. Oldest first. */
  messages: SeedMessage[]
}

/**
 * The stored summary, regenerating it only once it has fallen behind by
 * `SUMMARY_MIN_NEW_MESSAGES`. Reusing the bytes keeps the prompt prefix
 * cacheable and stops every turn paying for a summarization.
 *
 * One summarizer, one block per chat: the team-chat dispatcher and the
 * `historySeed` builder both land here, so a turn never carries two different
 * accounts of the same conversation.
 */
export async function ensureDurableSummary(
  args: DurableSummaryArgs,
): Promise<{ summary: string | null; through: number }> {
  const { existing, existingThrough, through } = args
  if (existing && through - existingThrough < SUMMARY_MIN_NEW_MESSAGES) {
    return { summary: existing, through: existingThrough }
  }
  const window = args.messages.slice(-SUMMARY_INPUT_LIMIT).filter((m) => m.text.trim())
  if (window.length === 0) {
    return { summary: existing, through: Math.max(existingThrough, through) }
  }

  let summary: string | null = null
  try {
    summary = await summarizer({ sessionId: args.sessionId, label: args.label, messages: window })
  } catch (err: any) {
    console.warn(`[ChatContext] summarizer failed for ${args.sessionId}:`, err?.message ?? err)
  }
  if (!summary) summary = extractiveSummary(args.label, window)

  await prisma.chatSession
    .update({
      where: { id: args.sessionId },
      data: { contextSummary: summary, contextSummaryThroughCount: through },
    })
    .catch((err: any) => {
      // A failed write must not cost the turn: the summary still ships.
      console.warn(`[ChatContext] could not persist summary for ${args.sessionId}:`, err?.message ?? err)
    })

  return { summary, through }
}

export interface BuildHistorySeedOptions {
  /**
   * Drop the newest user row. Server-initiated turns write their prompt to
   * `ChatMessage` before calling the runtime, so that row *is* the message the
   * turn is about — restoring it too would send it twice.
   */
  excludeNewestUserMessage?: boolean
  budgetChars?: number
  tailMessages?: number
}

/**
 * The conversation to attach to a one-message turn, or null when this chat has
 * no stored history yet (a brand-new session).
 */
export async function buildChatHistorySeed(
  chatSessionId: string,
  options: BuildHistorySeedOptions = {},
): Promise<ChatHistorySeed | null> {
  const session = await prisma.chatSession
    .findUnique({
      where: { id: chatSessionId },
      select: {
        id: true,
        inferredName: true,
        contextSummary: true,
        contextSummaryThroughCount: true,
      },
    })
    .catch(() => null)
  if (!session) return null

  const rows = (await prisma.chatMessage
    .findMany({
      where: { sessionId: chatSessionId },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_SCAN_LIMIT,
      select: { id: true, role: true, content: true, createdAt: true },
    })
    .catch(() => [])) as StoredRow[]

  let ordered = rows.slice().reverse()
  if (options.excludeNewestUserMessage && ordered.length > 0) {
    const last = ordered[ordered.length - 1]!
    if (last.role === 'user') ordered = ordered.slice(0, -1)
  }
  if (ordered.length === 0) {
    return session.contextSummary
      ? { summary: session.contextSummary, messages: [], summaryThrough: session.contextSummaryThroughCount }
      : null
  }

  const prepared = ordered.map((row) => ({ row, text: messageText(row) }))
  const budgetChars = options.budgetChars ?? HISTORY_SEED_BUDGET_CHARS
  const { start } = fitTranscriptTail(
    prepared,
    budgetChars,
    options.tailMessages ?? HISTORY_SEED_TAIL_MESSAGES,
  )

  const keptRows = prepared.slice(start).filter((entry) => entry.text.length > 0).map((entry) => entry.row)
  const messages: SeedMessage[] = keptRows.map((row) => ({
    role: row.role === 'assistant' ? 'assistant' : 'user',
    text: messageText(row),
  }))

  let summary = session.contextSummary ?? null
  let summaryThrough = session.contextSummaryThroughCount ?? 0
  if (start > 0) {
    const elidedRows = prepared.slice(0, start).map((entry) => entry.row)
    // Everything strictly before the retained tail, so the watermark is a
    // property of the conversation rather than of this window.
    const olderThanRetained = await prisma.chatMessage
      .count({ where: { sessionId: chatSessionId, createdAt: { lt: prepared[start]!.row.createdAt } } })
      .catch(() => elidedRows.length)
    const ensured = await ensureDurableSummary({
      sessionId: chatSessionId,
      label: session.inferredName || 'chat',
      existing: summary,
      existingThrough: summaryThrough,
      through: olderThanRetained,
      messages: elidedRows.map((row) => ({
        role: row.role === 'assistant' ? 'assistant' : 'user',
        text: messageText(row),
      })),
    })
    summary = ensured.summary
    summaryThrough = ensured.through
  }

  return { summary, messages, summaryThrough }
}

/**
 * The `historySeed` field of a turn request: what the runtime seeds an empty
 * session with. Null when there is nothing worth carrying.
 */
export async function historySeedFor(
  chatSessionId: string,
  options: BuildHistorySeedOptions = {},
): Promise<{ summary: string | null; messages: SeedMessage[] } | null> {
  const seed = await buildChatHistorySeed(chatSessionId, options)
  if (!seed) return null
  if (seed.messages.length === 0 && !seed.summary) return null
  return { summary: seed.summary, messages: seed.messages }
}

// ---------------------------------------------------------------------------
// The thread transcript a team-chat agent's prompt is built from
// ---------------------------------------------------------------------------

/** Characters of thread conversation a prompt carries before summarising. */
export const THREAD_CONTEXT_BUDGET_CHARS = 60_000
/** Newest thread messages always carried verbatim when they fit. */
export const THREAD_CONTEXT_TAIL_MESSAGES = 10

/** A rendered-first-order thread row: only what budgeting needs. */
export interface ThreadMessage {
  id: string
  text?: string | null
  seq?: number
  authorType?: string
  [key: string]: unknown
}

const lastCarried = new Map<string, number>()

/**
 * Compare what this turn carries against the previous turn for the same chat
 * and shout when it dropped. Best effort per pod (the map is process-local),
 * which is enough: the turn that collapses and the turn before it are almost
 * always served by the same API replica, and a missed warning is better than
 * a write on every turn.
 */
export function noteCarriedContext(
  chatSessionId: string | null,
  carried: number,
  detail: { elided: number; summarised: boolean },
): void {
  if (!chatSessionId) return
  const previous = lastCarried.get(chatSessionId)
  lastCarried.set(chatSessionId, carried)
  if (carried === 0) {
    console.warn(`[ChatContext] context_collapse session=${chatSessionId} carried=0 cause=empty-transcript`)
    return
  }
  if (previous === undefined) return
  // A summarised window legitimately carries fewer messages, but only down to
  // the tail; losing the tail itself, or losing history with nothing standing
  // in for it, is the collapse.
  const materiallyLess = carried < previous - 4 && (!detail.summarised || carried < THREAD_CONTEXT_TAIL_MESSAGES)
  if (!materiallyLess) return
  console.warn(
    `[ChatContext] context_collapse session=${chatSessionId} carried=${carried} previous=${previous} ` +
      `elided=${detail.elided} summarised=${detail.summarised} cause=${detail.elided > 0 ? 'budget' : 'transcript-shrank'}`,
  )
}

/** Test seam: forget what the previous turn carried. */
export function resetCarriedContext(): void {
  lastCarried.clear()
}

/**
 * Fit a thread's messages into the prompt budget.
 *
 * Everything down to `THREAD_CONTEXT_BUDGET_CHARS` is kept verbatim, always
 * including the newest `THREAD_CONTEXT_TAIL_MESSAGES` that fit. What does not
 * fit is replaced by the chat's durable summary — never dropped on the floor,
 * and never turned into "the runtime already has it" (SHO-137).
 */
export async function budgetThreadContext<T extends ThreadMessage>(
  history: T[],
  chatSessionId: string | null,
  conversation?: { inferredName?: string | null; name?: string | null },
): Promise<{ kept: T[]; elided: number; summary: string | null }> {
  const { start } = fitTranscriptTail(
    history.map((m) => ({ text: typeof m.text === 'string' ? m.text : '' })),
    THREAD_CONTEXT_BUDGET_CHARS,
    THREAD_CONTEXT_TAIL_MESSAGES,
  )
  if (start === 0) return { kept: history, elided: 0, summary: null }

  const elidedRows = history.slice(0, start)
  const kept = history.slice(start)
  const elided = elidedRows.length
  if (!chatSessionId) {
    // No session to store a summary on: the tail is all this turn can carry,
    // and the log says so rather than pretending the prompt is complete.
    console.warn(
      `[ChatContext] context_collapse session=(none) carried=${kept.length} elided=${elided} cause=no-session`,
    )
    return { kept, elided, summary: null }
  }

  const session = await prisma.chatSession
    .findUnique({
      where: { id: chatSessionId },
      select: { contextSummary: true, contextSummaryThroughCount: true, inferredName: true },
    })
    .catch(() => null)

  const { summary } = await ensureDurableSummary({
    sessionId: chatSessionId,
    label: session?.inferredName ?? conversation?.inferredName ?? conversation?.name ?? 'team chat',
    existing: session?.contextSummary ?? null,
    existingThrough: session?.contextSummaryThroughCount ?? 0,
    // The thread's own sequence: monotonic per conversation, so the watermark
    // describes the conversation instead of this particular window.
    through: elidedRows[elidedRows.length - 1]?.seq ?? elided,
    messages: elidedRows.map((m) => ({
      role: m.authorType === 'agent' ? ('assistant' as const) : ('user' as const),
      text: typeof m.text === 'string' ? m.text : '',
    })),
  })

  return { kept, elided, summary }
}
