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
  /** The block being folded, so a rewrite condenses it instead of restarting. */
  previous?: string | null
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

/**
 * The append-only form of `extractiveSummary`: one digest line per message, no
 * heading, so covering a few more messages costs no model call.
 */
export function extractiveDigest(messages: SeedMessage[]): string {
  const lines: string[] = []
  for (const message of messages) {
    const body = message.text.replace(/\s+/g, ' ').trim()
    if (!body) continue
    const speaker = message.role === 'user' ? 'Asked' : 'Answered'
    lines.push(`- ${speaker}: ${body.length > 220 ? `${body.slice(0, 219).trimEnd()}…` : body}`)
    if (lines.length >= 400) break
  }
  return lines.join('\n')
}

function summaryHeading(label: string): string {
  return `Conversation so far (${label}):`
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
  previous?: string | null
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
    prompt:
      `Conversation: ${input.label}\n\n` +
      (input.previous ? `What is already recorded about the earlier part:\n${input.previous}\n\n` : '') +
      `Newly folded part:\n${transcript}`,
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
  /** How many of this session's messages that summary already stands in for. */
  existingThrough: number
  /** How many of this session's messages the summary must cover now. */
  through: number
  /**
   * Every message up to `through`, oldest first (`covered[i]` is message `i+1`
   * of the session). The messages after `existingThrough` are the ones this
   * call has to fold in — no message may be skipped: the tail starts exactly
   * after `through`, so anything not folded here is in neither place.
   */
  covered: SeedMessage[]
  /** Where `covered[0]` sits in the session, when only a window was loaded. */
  coveredOffset?: number
}

function persistSummary(sessionId: string, summary: string, through: number): Promise<void> {
  return prisma.chatSession
    .update({
      where: { id: sessionId },
      data: { contextSummary: summary, contextSummaryThroughCount: through },
    })
    .then(() => undefined)
    .catch((err: any) => {
      // A failed write must not cost the turn: the summary still ships.
      console.warn(`[ChatContext] could not persist summary for ${sessionId}:`, err?.message ?? err)
    })
}

/**
 * The shortest a fallback digest line may be cut to before it stops carrying
 * an identity (`u: turn-042`): the floor that decides how many messages fit.
 */
const DIGEST_LINE_MIN_CHARS = 12

function digestLine(message: SeedMessage): string | null {
  const body = normalizeText(message.text)
  if (!body) return null
  return `${message.role === 'user' ? 'u' : 'a'}: ${body}`
}

/**
 * One line per message inside `budget` characters.
 *
 * Full length when it fits; otherwise every line is cut to the same per-message
 * share, so a batch that has to fall back to digests still shows *all* of its
 * turns instead of the ones that happened to fit — truncating the joined block
 * kept the oldest bytes and dropped everything after them while the watermark
 * claimed the lot (SHO-137 round 4, B3). When not even
 * `DIGEST_LINE_MIN_CHARS` per message fits, the surplus is left off the end and
 * `kept` says how many lines are really there, so the caller can keep the
 * watermark honest rather than claim messages that are not in the block.
 */
function renderDigest(lines: string[], budget: number): { text: string; kept: number } {
  if (lines.length === 0) return { text: '', kept: 0 }
  const room = Math.max(0, budget)
  const joined = lines.join('\n')
  if (joined.length <= room) return { text: joined, kept: lines.length }

  // Each line also costs its newline, so a line's share is the room minus the
  // separators, over the number of lines.
  const perLine = Math.floor((room - (lines.length - 1)) / lines.length)
  if (perLine >= DIGEST_LINE_MIN_CHARS) {
    return {
      text: lines
        .map((line) => (line.length > perLine ? `${line.slice(0, perLine - 1).trimEnd()}…` : line))
        .join('\n'),
      kept: lines.length,
    }
  }

  const fit = Math.max(0, Math.floor((room + 1) / (DIGEST_LINE_MIN_CHARS + 1)))
  return {
    text: lines
      .slice(0, fit)
      .map((line) => `${line.slice(0, DIGEST_LINE_MIN_CHARS - 1).trimEnd()}…`)
      .join('\n'),
    kept: fit,
  }
}

/**
 * Fold `messages` (oldest first) into `previous`, in summarizer-sized batches.
 *
 * The summarizer takes at most `SUMMARY_INPUT_LIMIT` messages per call, so a
 * turn that elides more than that used to be folded from its *newest* 150 while
 * the watermark advanced over all of them — everything older sat in neither the
 * summary nor the tail (SHO-137 round 4, B2). Walking oldest-first in batches,
 * passing the running block as `previous` each time, covers every message and
 * keeps the result a briefing rather than a transcript.
 *
 * With no model, the batch is still covered: one digest line per message,
 * compressed to fit (`renderDigest`) rather than truncated, so an outage costs
 * detail and never coverage. `covered` reports how many of `messages` the block
 * really holds; a caller must not advance its watermark beyond that.
 */
async function foldInBatches(args: {
  sessionId: string
  label: string
  previous: string | null
  messages: SeedMessage[]
}): Promise<{ summary: string; covered: number }> {
  const heading = summaryHeading(args.label)
  const previous = args.previous ?? ''
  // A block we wrote as digests is re-rendered line by line, so each message
  // keeps a share of the budget. Anything else (a model briefing) is prose we
  // must not re-cut: new digest lines are fitted into the room it leaves.
  const isDigestBlock = previous === '' || previous.startsWith(`${heading}\n`)
  let prose = isDigestBlock ? '' : previous
  let lines = isDigestBlock && previous ? previous.slice(heading.length + 1).split('\n').filter(Boolean) : []
  // Digest lines the block arrived with are messages an earlier turn already
  // claimed; only the surplus over them is ours to claim now.
  let baseline = lines.length
  let proseCovered = 0
  let covered = 0

  const render = () => {
    const room = CONTEXT_SUMMARY_MAX_CHARS - (prose ? prose.length + 1 : heading.length + 1)
    const rendered = renderDigest(lines, room)
    const body = prose && rendered.text ? `${prose}\n${rendered.text}` : prose || rendered.text
    return { text: body ? `${prose ? '' : `${heading}\n`}${body}` : '', kept: rendered.kept }
  }

  for (let i = 0; i < args.messages.length; i += SUMMARY_INPUT_LIMIT) {
    const batch = args.messages.slice(i, i + SUMMARY_INPUT_LIMIT)
    let folded: string | null = null
    try {
      folded = await summarizer({
        sessionId: args.sessionId,
        label: args.label,
        messages: batch,
        previous: render().text || null,
      })
    } catch (err: any) {
      console.warn(`[ChatContext] summarizer failed for ${args.sessionId}:`, err?.message ?? err)
    }
    if (folded) {
      // The model read the whole block plus this batch, so the briefing it
      // returns stands in for the digest lines and covers everything so far.
      prose = folded.slice(0, CONTEXT_SUMMARY_MAX_CHARS)
      lines = []
      baseline = 0
      proseCovered = i + batch.length
      covered = proseCovered
    } else {
      for (const message of batch) {
        const line = digestLine(message)
        if (line) lines.push(line)
      }
      covered = proseCovered + Math.max(0, render().kept - baseline)
    }
  }
  return { summary: render().text, covered }
}

/**
 * The stored summary, advanced so it covers exactly `through` messages.
 *
 * Round 1 of SHO-137 regenerated the summary only every 20 messages, which left
 * up to 19 messages covered by neither the summary nor the verbatim tail — lost
 * from the turn entirely. Now the two always meet: the tail begins right after
 * `through`, and every message up to `through` is folded into the summary on
 * the turn that elides it.
 *
 * The fold runs with the model, `previous` included, in batched calls (see
 * `foldInBatches`) — so no elided message is skipped and the block condenses
 * instead of restarting. A summarizer outage appends digests for the same
 * messages rather than dropping them.
 *
 * Last resort: if the model fails *and* the digests do not fit, the block is
 * truncated. The messages themselves stay in `ChatMessage` for good; only the
 * per-turn block is bounded.
 */
export async function ensureDurableSummary(
  args: DurableSummaryArgs,
): Promise<{ summary: string | null; through: number }> {
  const { existing, existingThrough, through } = args
  if (through <= existingThrough) return { summary: existing, through: existingThrough }

  const offset = args.coveredOffset ?? 0
  const from = Math.max(0, existingThrough - offset)
  const newlyElided = args.covered.slice(from, Math.max(0, through - offset)).filter((m) => m.text.trim())
  if (newlyElided.length === 0) {
    return { summary: existing, through }
  }
  if (existingThrough < offset) {
    // The stored summary lags behind the window this turn loaded. It cannot
    // happen while every elided message is folded on the turn that elides it,
    // so say so loudly rather than pretend the block is complete.
    console.warn(
      `[ChatContext] summary_gap session=${args.sessionId} coveredFrom=${offset} watermark=${existingThrough}`,
    )
  }

  // Fold with the model — `previous` included, so a fold condenses instead of
  // restarting — in batches that cover every newly elided message. Anything
  // cheaper (appending digests without the model) is the *fallback*, used when
  // the summarizer is unavailable, so the block always covers these messages.
  const folded = await foldInBatches({
    sessionId: args.sessionId,
    label: args.label,
    previous: existing,
    messages: newlyElided,
  })

  // The watermark follows the block, not the input: when the summarizer is down
  // and even compressed digests cannot hold every message, the surplus stays
  // above the watermark and is folded again next turn rather than being claimed
  // and lost (SHO-137 round 4, B3).
  const base = Math.max(existingThrough, offset)
  const nextThrough = base + folded.covered
  if (folded.covered < newlyElided.length) {
    console.warn(
      `[ChatContext] summary_shortfall session=${args.sessionId} folded=${folded.covered}/${newlyElided.length} watermark=${nextThrough}`,
    )
  }

  await persistSummary(args.sessionId, folded.summary, nextThrough)
  return { summary: folded.summary, through: nextThrough }
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
    const elidedPrepared = prepared.slice(0, start)
    const elidedRows = elidedPrepared.map((entry) => entry.row)
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
      // Everything before the retained tail, in conversation order, plus where
      // that window starts in the session — the summary has to account for
      // both, or the messages between the watermark and the tail vanish.
      covered: elidedPrepared.map((entry) => ({
        role: entry.row.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        text: entry.text,
      })),
      coveredOffset: Math.max(0, olderThanRetained - elidedRows.length),
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

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * The seed for a *typed* turn (SHO-137 round 3, R4).
 *
 * A turn typed into the app sends the messages the client happens to have
 * loaded — pages of 50 — so anything older than that window was invisible to a
 * runtime whose session had been evicted. The durable seed fills that gap, and
 * the runtime only uses it when its own session is empty.
 *
 * The request body already carries the message being sent, so a trailing user
 * row that duplicates it is dropped rather than replayed twice.
 */
export async function historySeedForTurn(
  chatSessionId: string | null | undefined,
  incomingPrompt?: string | null,
): Promise<{ summary: string | null; messages: SeedMessage[] } | null> {
  if (!chatSessionId) return null
  const seed = await historySeedFor(chatSessionId).catch((err: Error) => {
    console.warn(`[ChatContext] history seed for ${chatSessionId} failed:`, err.message)
    return null
  })
  if (!seed) return null
  const prompt = normalizeText(incomingPrompt ?? '')
  if (prompt) {
    while (seed.messages.length > 0) {
      const last = seed.messages[seed.messages.length - 1]!
      if (last.role !== 'user' || normalizeText(last.text) !== prompt) break
      seed.messages.pop()
    }
  }
  if (seed.messages.length === 0 && !seed.summary) return null
  return seed
}

/** The text of the last user message in a chat request body, if any. */
export function lastUserPromptText(body: any): string | null {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.role !== 'user') continue
    if (typeof message.content === 'string' && message.content.trim()) return message.content
    const parts = Array.isArray(message.parts) ? message.parts : []
    const text = parts
      .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
      .map((part: any) => part.text)
      .join('\n')
    if (text.trim()) return text
  }
  return null
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

/**
 * R3: a warm team-chat turn carries only the traffic since this agent's last
 * reply. The older conversation is covered by `historySeed` (summary + tail),
 * and an agent that needs more can read it with `team_chat_read` /
 * `work_item_get` — re-sending the whole thread every turn is what made tokens
 * grow quadratically in long threads.
 *
 * When the trigger predates that reply (a reply that landed after the message
 * being answered), the cut falls back to the trigger so nothing that follows it
 * is dropped.
 */
export function newSinceLastAgentReply<T extends { id: string; authorType?: string }>(
  history: T[],
  triggerId?: string | null,
): T[] {
  const lastAgentIdx = history.map((m) => m.authorType).lastIndexOf('agent')
  if (lastAgentIdx < 0) return history
  const triggerIdx = triggerId ? history.findIndex((m) => m.id === triggerId) : -1
  return triggerIdx > lastAgentIdx || triggerIdx < 0
    ? history.slice(lastAgentIdx + 1)
    : history.slice(triggerIdx)
}

/** Test seam: forget what the previous turn carried. */
export function resetCarriedContext(): void {
  lastCarried.clear()
}

/**
 * Fit a thread's messages into the prompt budget.
 *
 * Pure and synchronous on purpose (SHO-137 round 3, R2): this function used to
 * write the chat's durable summary too, keyed by the *channel* sequence while
 * the seed keyed the same column by a `ChatMessage` count. Two units in one
 * column meant whichever wrote last won, so the seed could reuse a team-chat
 * summary forever and team chat regenerated on traffic anywhere in the channel.
 *
 * There is now exactly one writer of `ChatSession.contextSummary` —
 * `ensureDurableSummary`, over the session's own messages — and this only
 * decides how much of the *new* thread traffic a prompt can carry. What does
 * not fit is reported, never stored: the durable summary attached as
 * `historySeed` is what stands in for the older conversation.
 */
export function fitThreadBudget<T extends ThreadMessage>(
  history: T[],
  budgetChars: number = THREAD_CONTEXT_BUDGET_CHARS,
  tailMessages: number = THREAD_CONTEXT_TAIL_MESSAGES,
): { kept: T[]; elided: number } {
  const { start } = fitTranscriptTail(
    history.map((m) => ({ text: typeof m.text === 'string' ? m.text : '' })),
    budgetChars,
    tailMessages,
  )
  if (start === 0) return { kept: history, elided: 0 }
  return { kept: history.slice(start), elided: start }
}

/**
 * "Summarize now" for a session the runtime no longer holds (SHO-137 round 3,
 * R5).
 *
 * The dock's button used to be a proxy to the runtime, which answered
 * `unknown-session` for anything idle for over an hour — exactly the state a
 * user is in when they come back to a long chat. The rows are all in
 * `ChatMessage`, so the summary is built from those with the same summarizer
 * and the same fold the seed uses, stored on the `ChatSession` where it is
 * durable, and pushed to the runtime when that runtime does hold the session.
 *
 * Returns null when the chat has nothing foldable.
 */
export async function summarizeSessionFromDb(
  chatSessionId: string,
  options: { keepTailChars?: number } = {},
): Promise<{
  summary: string
  through: number
  messagesBefore: number
  messagesAfter: number
} | null> {
  const session = await prisma.chatSession
    .findUnique({
      where: { id: chatSessionId },
      select: { id: true, inferredName: true, contextSummary: true },
    })
    .catch(() => null)
  if (!session) return null

  const rows = (await prisma.chatMessage
    .findMany({
      where: { sessionId: chatSessionId },
      orderBy: { createdAt: 'asc' },
      take: SUMMARY_INPUT_LIMIT * 8,
      select: { role: true, content: true },
    })
    .catch(() => [])) as Array<{ role: string; content: string }>
  const messages: SeedMessage[] = rows
    .map((row) => ({
      role: row.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      text: normalizeText(row.content ?? ''),
    }))
    .filter((m) => m.text.length > 0)
  if (messages.length === 0) return null

  // Everything except the newest block is folded; the newest block stays
  // verbatim in the transcript the next turn sends. The fold always takes at
  // least one message and leaves at least the newest one out: a short chat fits
  // under `keepTailChars` entirely, and folding nothing made the button's DB
  // path a silent no-op — the one thing a user pressing "Summarize now" cannot
  // be told (round 4).
  const keepTailChars = options.keepTailChars ?? 12_000
  let carried = 0
  let split = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    carried += messages[i]!.text.length
    if (carried > keepTailChars) {
      split = i + 1
      break
    }
    split = i
  }
  // The whole chat fits the tail, so the loop never broke: fold everything
  // except the newest turn rather than nothing at all.
  if (split === 0 && messages.length > 1) split = messages.length - 1
  const fold = messages.slice(0, split)
  if (fold.length === 0) return null

  // Every folded message is covered, in batches: this path can elide a whole
  // long chat in one press, and slicing to the newest 150 while the watermark
  // claimed all of them lost the rest (SHO-137 round 4, B2).
  const folded = await foldInBatches({
    sessionId: chatSessionId,
    label: session.inferredName || 'chat',
    previous: session.contextSummary,
    messages: fold,
  })

  await persistSummary(chatSessionId, folded.summary, folded.covered)

  return {
    summary: folded.summary,
    through: folded.covered,
    messagesBefore: messages.length,
    messagesAfter: messages.length - folded.covered,
  }
}
