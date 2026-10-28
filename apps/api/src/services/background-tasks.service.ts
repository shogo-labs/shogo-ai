// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Background tasks an agent session waits on or is woken by.
 *
 * The runtime keeps its own tasks (shell, subagents) in memory. Rows here are
 * the ones only the API can observe: a project call (`project_call`), a tagged
 * agent's reply in team chat (`agent_reply`), a card (`work_item`). Producers
 * call `emitTaskEvent(source, targetRef, ...)`; every running task with that
 * target gets the output line and, when the event finishes it (or its `until`
 * pattern matches), is settled.
 *
 * A settled task that the agent has not seen yet (`consumed`) wakes its
 * session: finished tasks are coalesced for a moment, then one queued message
 * of kind `task_notification` per task is dispatched through the normal chat
 * queue, so each result arrives as its own [Task update].
 * The runtime also hands over its own finished tasks (`notifyLocalTasks`) when
 * the session is idle, so the queue is the one wake path.
 */

import { prisma } from '../lib/prisma'
import { envInt } from './conversation-agent-chain'

const db = prisma as any

/**
 * Longest a channel agent reply runs before it is given up as timed out. A
 * reply whose stream goes silent is given up sooner (the dispatcher's idle timeout).
 */
export const AGENT_REPLY_TIMEOUT_MS = envInt('SHOGO_CHANNEL_AGENT_TIMEOUT_MS', 2 * 60 * 60_000)

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export const TASK_TTL_MS = 24 * 60 * 60 * 1000
/** A card can sit with an agent for days across a phase of work. */
export const CARD_TASK_TTL_MS = 7 * TASK_TTL_MS
const OUTPUT_CAP = 64_000
const TAIL_CHARS = 2_000
const WAKE_COALESCE_MS = 2_000
const WAIT_POLL_MS = 2_000
export const MAX_WAIT_MS = 30_000
/** Wakes in a row without a person writing in between; past this the session waits for them. */
export const MAX_CONSECUTIVE_WAKES = 3
/**
 * The same cap for wakes that only report cards. Managing handed-off cards is
 * a long run of wakes by design; card hand-offs are separately rate-limited
 * per card, so this only stops a runaway session.
 */
export const MAX_CONSECUTIVE_CARD_WAKES = 40
/**
 * A wake that was queued and never ran hands its tasks back, and the drain
 * sweep re-queues them. The first retry is immediate (a dispatch failure is
 * usually a busy runtime); repeats back off up to five minutes.
 */
const WAKE_RETRY_BACKOFF_MS = [0, 15_000, 30_000, 60_000, 120_000, 300_000]
/** The longest a released wake waits before its next attempt. */
export const MAX_WAKE_BACKOFF_MS = WAKE_RETRY_BACKOFF_MS[WAKE_RETRY_BACKOFF_MS.length - 1]!
/**
 * How many times one wake is re-queued after a dispatch that never ran. A wake
 * the runtime will not take would otherwise be retried on the same backoff for
 * the task's whole 24 h TTL; past this the task is held until it expires and
 * the queue keeps one row saying why it never arrived.
 */
export const MAX_WAKE_ATTEMPTS = 5
/** An `agent_reply` task whose run never reports back is given up this long after its timeout. */
export const AGENT_REPLY_RECONCILE_MS = AGENT_REPLY_TIMEOUT_MS + 5 * 60_000
/**
 * Longest a finished card watch waits for agents still working the card's
 * thread. Outlasts the longest channel agent run (`AGENT_REPLY_TIMEOUT_MS`), so it only
 * fires when a run hangs or ends without reporting back.
 */
export const CARD_HOLD_MS = AGENT_REPLY_TIMEOUT_MS + 60_000

export interface BackgroundTaskRow {
  id: string
  chatSessionId: string
  source: string
  targetRef: string
  title: string
  status: BackgroundTaskStatus
  output: string
  summary: string | null
  until: string | null
  note: string | null
  notify: boolean
  consumed: boolean
  notifiedAt: Date | null
  attempts?: number
  nextAttemptAt?: Date | null
  heldUntil?: Date | null
  /** Where the task's work is happening (channel thread, card, project session, log). */
  link?: unknown
  finishedAt: Date | null
  expiresAt: Date
  createdAt: Date
}

/**
 * Where a task's thread lives, carried from the runtime that created it to the
 * chat dock that shows it. Kept as plain data (not a union class) because it
 * round-trips through `background_tasks.link`.
 */
export type TaskLink =
  | { kind: 'log'; path?: string }
  | { kind: 'project_session'; projectId: string; chatSessionId?: string; name?: string }
  | { kind: 'subagent'; projectId?: string; chatSessionId?: string; toolCallId: string }
  | { kind: 'channel_thread'; workspaceId?: string; conversationId: string; threadRootId: string; title?: string }
  | {
      kind: 'card'
      workspaceId?: string
      conversationId: string
      threadRootId: string
      itemId: string
      itemKey: string
      board: string
    }

function str(value: unknown, max = 200): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined
}

/** Validate a link posted by a runtime, dropping anything malformed. */
export function normalizeTaskLink(input: unknown): TaskLink | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  const kind = str(raw.kind, 32)
  if (kind === 'log') {
    const path = str(raw.path, 1000)
    return path ? { kind: 'log', path } : { kind: 'log' }
  }
  if (kind === 'project_session') {
    const projectId = str(raw.projectId)
    if (!projectId) return null
    const chatSessionId = str(raw.chatSessionId)
    const name = str(raw.name)
    return { kind: 'project_session', projectId, ...(chatSessionId ? { chatSessionId } : {}), ...(name ? { name } : {}) }
  }
  if (kind === 'subagent') {
    const toolCallId = str(raw.toolCallId)
    if (!toolCallId) return null
    const projectId = str(raw.projectId)
    const chatSessionId = str(raw.chatSessionId)
    return { kind: 'subagent', toolCallId, ...(projectId ? { projectId } : {}), ...(chatSessionId ? { chatSessionId } : {}) }
  }
  if (kind === 'channel_thread') {
    const conversationId = str(raw.conversationId)
    const threadRootId = str(raw.threadRootId)
    if (!conversationId || !threadRootId) return null
    const workspaceId = str(raw.workspaceId)
    const title = str(raw.title)
    return {
      kind: 'channel_thread',
      conversationId,
      threadRootId,
      ...(workspaceId ? { workspaceId } : {}),
      ...(title ? { title } : {}),
    }
  }
  if (kind === 'card') {
    const conversationId = str(raw.conversationId)
    const threadRootId = str(raw.threadRootId)
    const itemId = str(raw.itemId)
    if (!conversationId || !threadRootId || !itemId) return null
    const workspaceId = str(raw.workspaceId)
    return {
      kind: 'card',
      conversationId,
      threadRootId,
      itemId,
      itemKey: str(raw.itemKey) ?? itemId,
      board: str(raw.board) ?? '',
      ...(workspaceId ? { workspaceId } : {}),
    }
  }
  return null
}

export interface BackgroundTaskView {
  id: string
  source: string
  title: string
  status: BackgroundTaskStatus
  output: string
  result: { summary: string } | null
  matched?: boolean
  startedAt: string
  /** Where the task's thread lives, so the dock can open it. */
  link?: TaskLink | null
  /** The wake text, once the task settled — the runtime falls back to it when it has no output. */
  note?: string | null
}

export class BackgroundTaskError extends Error {
  constructor(public status: 400 | 404, public code: string, message: string) {
    super(message)
  }
}

// ─── In-process signals (long-poll wakeups; other replicas fall back to polling) ──

const waiters = new Map<string, Set<() => void>>()

function signal(id: string): void {
  const set = waiters.get(id)
  if (!set) return
  waiters.delete(id)
  for (const fn of set) fn()
}

function nextSignal(id: string, ms: number, abort?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let set = waiters.get(id)
    if (!set) waiters.set(id, (set = new Set()))
    const done = () => {
      clearTimeout(timer)
      set!.delete(done)
      abort?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    ;(timer as any).unref?.()
    set.add(done)
    abort?.addEventListener('abort', done, { once: true })
  })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function compileUntil(pattern: string | null | undefined): RegExp | null {
  if (!pattern) return null
  try {
    return new RegExp(pattern, 'i')
  } catch {
    return null
  }
}

function capOutput(text: string): string {
  return text.length > OUTPUT_CAP ? text.slice(-OUTPUT_CAP) : text
}

function isFinal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

/** Columns a card is finished in: a watch on it has nothing left to hear. */
export function isClosedCategory(category: string | null | undefined): boolean {
  return category === 'done' || category === 'dismissed'
}

/**
 * A session that auto-woke too many times in a row waits for a person instead
 * of starting another turn. This is the text its queued wake carries, and the
 * signal the composer and the task list read to show what is waiting.
 */
export const WAKE_PAUSED =
  'Paused: background tasks finished several times in a row without anyone writing. Send a message to continue.'

/**
 * The same marker for a different reason: every automatic agent start in the
 * workspace is held, so this wake is parked rather than delivered (SHO-118).
 * Both are "paused" rows — the composer shows them the same way, and resuming
 * either comes from a person or from `agent_run_stop({ resume: true })`.
 */
export const WAKE_WORKSPACE_PAUSED =
  'Paused: agents are paused in this workspace. Resume them and this update will run.'

/** Error markers on a queued row that mean "held, not failed". */
export const WAKE_PAUSED_MARKERS = [WAKE_PAUSED, WAKE_WORKSPACE_PAUSED]

export function viewOf(row: BackgroundTaskRow, matched?: boolean): BackgroundTaskView {
  const link = normalizeTaskLink(row.link)
  return {
    id: row.id,
    source: row.source,
    title: row.title,
    status: row.status,
    output: row.output,
    result: isFinal(row.status) ? { summary: row.summary ?? row.status } : null,
    ...(matched ? { matched: true } : {}),
    startedAt: new Date(row.createdAt).toISOString(),
    ...(link ? { link } : {}),
    ...(isFinal(row.status) && row.note ? { note: row.note } : {}),
  }
}

/** Same shape the runtime uses for its own notes, so the agent sees one format. */
export function formatTaskNote(row: Pick<BackgroundTaskRow, 'id' | 'title' | 'status' | 'output' | 'summary' | 'note'>): string {
  if (row.note) return row.note
  const outcome = row.status === 'cancelled' ? 'was cancelled' : row.status
  const lines = [`[Task update] ${row.title} (${row.id}) ${outcome}.`]
  const tail = (row.output || row.summary || '').trim()
  if (tail) lines.push('Last output:', tail.length > TAIL_CHARS ? `…${tail.slice(-TAIL_CHARS)}` : tail)
  return lines.join('\n')
}

async function expireStale(chatSessionId?: string): Promise<void> {
  const now = new Date()
  await db.backgroundTask.updateMany({
    where: { status: 'running', expiresAt: { lt: now }, ...(chatSessionId ? { chatSessionId } : {}) },
    data: { status: 'failed', summary: 'Stopped tracking: it ran past its time limit.', finishedAt: now, notify: false },
  }).catch(() => {})
  await db.backgroundTask.deleteMany({
    where: { expiresAt: { lt: new Date(now.getTime() - TASK_TTL_MS) } },
  }).catch(() => {})
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export interface CreateTaskInput {
  id: string
  chatSessionId: string
  source: string
  targetRef: string
  title: string
  until?: string | null
  /** Where the task's thread lives, so the dock can open it instead of an empty log. */
  link?: unknown
}

const REMOTE_SOURCES = new Set(['project_call', 'agent_reply', 'work_item'])

export async function createTask(input: CreateTaskInput): Promise<BackgroundTaskRow> {
  if (!/^t_[A-Za-z0-9]{4,32}$/.test(input.id)) throw new BackgroundTaskError(400, 'invalid_id', 'Task ids look like t_xxxxxxxx')
  if (!REMOTE_SOURCES.has(input.source)) throw new BackgroundTaskError(400, 'invalid_source', `Unknown task source ${input.source}`)
  if (!input.targetRef?.trim()) throw new BackgroundTaskError(400, 'invalid_target', 'targetRef is required')
  if (input.until && !compileUntil(input.until)) throw new BackgroundTaskError(400, 'invalid_until', 'until must be a valid regex')
  await expireStale(input.chatSessionId)
  const existing = await db.backgroundTask.findUnique({ where: { id: input.id } })
  if (existing) return existing
  const link = normalizeTaskLink(input.link)
  const row = await db.backgroundTask.create({
    data: {
      id: input.id,
      chatSessionId: input.chatSessionId,
      source: input.source,
      targetRef: input.targetRef.trim().slice(0, 500),
      title: String(input.title || input.source).slice(0, 300),
      until: input.until ?? null,
      ...(link ? { link: link as any } : {}),
      // A background project call has no time limit, so its task lives as long as a card's.
      expiresAt: new Date(
        Date.now() + (input.source === 'work_item' || input.source === 'project_call' ? CARD_TASK_TTL_MS : TASK_TTL_MS),
      ),
    },
  })
  return (await settleIfAlreadyDone(row)) ?? row
}

/**
 * A project call can finish before the runtime registers its task (the
 * runtime only learns the run id after the call returns). Catch up from the
 * call's own record.
 */
async function settleIfAlreadyDone(row: BackgroundTaskRow): Promise<BackgroundTaskRow | null> {
  if (row.source === 'project_call') {
    const [projectId, runId] = splitRef(row.targetRef)
    if (!projectId || !runId) return null
    const { getAgentCall } = await import('../lib/agent-call-store')
    const record = await getAgentCall(projectId, runId).catch(() => undefined)
    if (!record || record.status === 'running') return null
    return applyEvent(row, {
      status: record.status === 'completed' ? 'completed' : 'failed',
      line: record.reply ?? record.error?.message ?? undefined,
      summary: record.status === 'completed' ? 'replied' : record.error?.message,
    })
  }
  return null
}

function splitRef(ref: string): [string, string] {
  const i = ref.lastIndexOf(':')
  return i === -1 ? [ref, ''] : [ref.slice(0, i), ref.slice(i + 1)]
}

export async function getTask(id: string): Promise<BackgroundTaskRow | null> {
  return db.backgroundTask.findUnique({ where: { id } })
}

export async function listTasks(chatSessionId: string): Promise<BackgroundTaskRow[]> {
  await expireStale(chatSessionId)
  return db.backgroundTask.findMany({
    where: { chatSessionId, status: 'running' },
    orderBy: { createdAt: 'asc' },
    take: 100,
  })
}

/**
 * Long-poll a task: returns once it settles, its output matches `until`, or
 * `waitMs` passes. Passing `until` also stores it, so a match after the agent
 * stops waiting still finishes the task and wakes the session.
 */
export async function waitForTask(
  id: string,
  opts: { waitMs?: number; until?: string | null; signal?: AbortSignal } = {},
): Promise<{ row: BackgroundTaskRow; matched: boolean } | null> {
  let row = await getTask(id)
  if (!row) return null
  const until = compileUntil(opts.until)
  if (opts.until && !until) throw new BackgroundTaskError(400, 'invalid_until', 'until must be a valid regex')
  if (opts.until && row.status === 'running' && row.until !== opts.until) {
    row = await db.backgroundTask.update({ where: { id }, data: { until: opts.until } })
  }
  const deadline = Date.now() + Math.max(0, Math.min(opts.waitMs ?? 0, MAX_WAIT_MS))
  for (;;) {
    if (!row) return null
    if (isFinal(row.status)) return { row, matched: false }
    if (until && until.test(row.output)) {
      if (row.source === 'work_item') {
        const settled = await settle(row, 'completed', `matched ${opts.until}`)
        return { row: settled, matched: true }
      }
      return { row, matched: true }
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0 || opts.signal?.aborted) return { row, matched: false }
    await nextSignal(id, Math.min(remaining, WAIT_POLL_MS), opts.signal)
    row = await getTask(id)
  }
}

export async function cancelTask(id: string): Promise<BackgroundTaskRow | null> {
  const row = await getTask(id)
  if (!row) return null
  if (isFinal(row.status)) return row
  const updated = await db.backgroundTask.update({
    where: { id },
    data: { status: 'cancelled', summary: 'cancelled', finishedAt: new Date(), consumed: true },
  })
  signal(id)
  return updated
}

/**
 * A stopped session stays stopped: nothing it was watching may wake it again.
 * The watched work itself (another agent, a card, a project call) carries on.
 * Wakes already queued for these tasks are dropped when the queue reaches them.
 */
export async function silenceSessionTasks(chatSessionId: string): Promise<number> {
  for (const timers of [wakeTimers, holdTimers]) {
    const timer = timers.get(chatSessionId)
    if (timer) clearTimeout(timer)
    timers.delete(chatSessionId)
  }
  const res = await db.backgroundTask.updateMany({ where: { chatSessionId, consumed: false }, data: { consumed: true } })
  return res.count
}

/**
 * The agent saw these results (it waited, or they were injected into a turn): never wake for them.
 *
 * A live card watch is the exception: it is still running, so the *next*
 * milestone on that card is news it has not seen. Marking it consumed would
 * silence the watch for the rest of the card's life (`settle` only wakes an
 * unconsumed row), which is the one-shot behaviour this watch exists to avoid.
 */
export async function consumeTasks(ids: string[]): Promise<number> {
  const clean = ids.filter((id) => typeof id === 'string' && id.length <= 64).slice(0, 200)
  if (!clean.length) return 0
  const res = await db.backgroundTask.updateMany({
    where: { id: { in: clean }, NOT: { AND: [{ source: 'work_item' }, { status: 'running' }] } },
    data: { consumed: true },
  })
  return res.count
}

// ─── Events ───────────────────────────────────────────────────────────────────

export interface TaskEvent {
  status?: Exclude<BackgroundTaskStatus, 'running'>
  line?: string
  summary?: string
  /**
   * Machine-readable card state for a `work_item` event: where the move landed
   * and who holds the card now. A watch reads this to tell a terminal move from
   * a milestone, instead of re-parsing the rendered line.
   */
  card?: CardEventState
  /**
   * The agent whose run produced this event (`project:<id>` / `workspace`).
   * A watch never hears its own agent: the run that just ended knows what it
   * did, so waking it for that is a wake that buys another wake — the loop
   * that made one mention re-run an agent a dozen times (SHO-129).
   */
  fromAgentRef?: string
}

export interface CardEventState {
  to?: { columnId?: string; column?: string; category?: string }
  assigneeAgentRef?: string | null
  columnAgentRef?: string | null
  /**
   * The card was closed outright (archived, dismissed) rather than moved on:
   * the watch is done with it either way.
   */
  terminal?: boolean
}

export function replyEvent(agentStatus: string | null | undefined, text: string | null | undefined): TaskEvent {
  const status = agentStatus === 'error' ? 'failed' : agentStatus === 'stopped' ? 'cancelled' : 'completed'
  return { status, line: text?.trim() || undefined, summary: agentStatus === 'error' ? 'the agent hit an error' : 'replied' }
}

async function settle(row: BackgroundTaskRow, status: Exclude<BackgroundTaskStatus, 'running'>, summary?: string): Promise<BackgroundTaskRow> {
  const updated = await db.backgroundTask.update({
    where: { id: row.id },
    data: { status, summary: summary ?? status, finishedAt: new Date() },
  })
  signal(row.id)
  if (!updated.notify || updated.consumed) return updated
  if (updated.source === 'work_item' && (await cardThreadBusy(updated.targetRef))) return holdTasks([updated]).then(() => updated)
  scheduleTaskWake(updated.chatSessionId)
  return updated
}

/** An agent is mid-run in the card's thread, so whatever it does next (a tag, a move) is still coming. */
async function cardThreadBusy(itemId: string): Promise<boolean> {
  const item = await db.workItem.findUnique({ where: { id: itemId }, select: { threadRootMessageId: true } }).catch(() => null)
  if (!item?.threadRootMessageId) return false
  const running = await db.conversationMessage.findFirst({
    where: { threadRootId: item.threadRootMessageId, authorType: 'agent', agentStatus: 'running', deletedAt: null },
    select: { id: true },
  }).catch(() => null)
  return !!running
}

/**
 * Finished card watches waiting for the card's thread to go quiet, plus any
 * that finished `since` and have not woken their session yet.
 */
export async function heldCardTasks(itemId: string, since?: Date): Promise<BackgroundTaskRow[]> {
  return db.backgroundTask.findMany({
    where: {
      source: 'work_item', targetRef: itemId, status: { not: 'running' }, notifiedAt: null, consumed: false, notify: true,
      OR: [{ heldUntil: { not: null } }, ...(since ? [{ finishedAt: { gte: since } }] : [])],
    },
    take: 50,
  })
}

/** Hold (or keep holding) finished watches for another `CARD_HOLD_MS`; the hold's end wakes them regardless. */
export async function holdTasks(rows: BackgroundTaskRow[]): Promise<void> {
  if (!rows.length) return
  await db.backgroundTask.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { heldUntil: new Date(Date.now() + CARD_HOLD_MS) },
  })
  for (const session of new Set(rows.map((r) => r.chatSessionId))) scheduleHoldExpiry(session)
}

/** The thread went quiet: wake the watchers, with what the last agent said when there is one. */
export async function releaseTasks(rows: BackgroundTaskRow[], line?: string): Promise<void> {
  for (const row of rows) {
    const output = line ? capOutput(row.output ? `${row.output}\n${line}` : line) : row.output
    await db.backgroundTask.update({ where: { id: row.id }, data: { heldUntil: null, output } })
  }
  for (const session of new Set(rows.map((r) => r.chatSessionId))) scheduleTaskWake(session)
}

/**
 * Put a card watch back to watching, in place, once the milestone that woke it
 * is safely in the queue.
 *
 * A hand-off watch is for the card's whole life: QA → Review and the bounce
 * back to Changes Requested must wake the assigner too, not just the first
 * column it reached. Re-arming the same row (not a successor) keeps one task id
 * for the card, so `consecutiveWakeWaits` does not count each milestone as a
 * new wait and the card-only wake cap is not burned by a five-column board; the
 * row's `expiresAt` (`CARD_TASK_TTL_MS`) bounds the chain.
 *
 * The guard is the card's state right now, not the text of the event: a closed
 * or archived card, a cleared holder, or a watch past its expiry all end it for
 * good.
 */
export async function rearmCardWatch(row: BackgroundTaskRow): Promise<BackgroundTaskRow | null> {
  if (row.source !== 'work_item' || !row.until) return null
  if (row.expiresAt.getTime() <= Date.now()) return null
  const item = await db.workItem
    .findFirst({
      where: { id: row.targetRef, archivedAt: null },
      select: { assigneeAgentRef: true, column: { select: { category: true, agentRef: true } } },
    })
    .catch(() => null)
  if (!item || isClosedCategory(item.column?.category)) return null
  if (!(item.assigneeAgentRef ?? item.column?.agentRef)) return null
  return db.backgroundTask.update({
    where: { id: row.id },
    data: {
      status: 'running',
      consumed: false,
      notifiedAt: null,
      attempts: 0,
      finishedAt: null,
      heldUntil: null,
      summary: null,
      // Start the timeline fresh: a re-armed watch that kept the line it already
      // matched would settle again on the next comment about the card.
      output: '',
    },
  })
}

async function applyEvent(row: BackgroundTaskRow, event: TaskEvent): Promise<BackgroundTaskRow> {
  let current = row
  if (event.line) {
    const output = capOutput(current.output ? `${current.output}\n${event.line}` : event.line)
    current = await db.backgroundTask.update({ where: { id: row.id }, data: { output } })
  }
  if (event.status) return settle(current, event.status, event.summary)
  // The card was closed outright (archived): the watch is done with it whether
  // or not the rendered line matched the pattern.
  if (event.card?.terminal === true) return settle(current, 'completed', 'the card is closed')
  const until = compileUntil(current.until)
  if (until && until.test(current.output)) {
    // A card watch that the card has closed is done; anything else is a
    // milestone, and `rearmCardWatch` puts the same row back to watching once
    // this wake is safely in the queue.
    const closed = isClosedCategory(event.card?.to?.category)
    return settle(current, 'completed', closed ? 'the card is closed' : `matched ${current.until}`)
  }
  signal(row.id)
  return current
}

/**
 * Something happened to `targetRef`. Every task watching it gets the line; a
 * status settles it. Never throws: producers call this inline.
 *
 * A card watch is live from the moment it matches until its wake is *claimed*
 * (`notifiedAt`), not just while its row says `running`: a milestone settles the
 * row, and the re-arm waits for the coalesce timer, so a second move landing in
 * that window would otherwise be dropped — a card that goes QA → Done inside it
 * would never tell the watcher it finished. Joining the queued wake is the
 * point: the agent is told the latest state, once.
 */
export async function emitTaskEvent(source: string, targetRef: string, event: TaskEvent): Promise<number> {
  try {
    const rows: BackgroundTaskRow[] = await db.backgroundTask.findMany({
      where: {
        source,
        targetRef,
        OR: [
          { status: 'running' },
          // Already matched, wake queued (or held), nobody told yet.
          { status: 'completed', notify: true, consumed: false, notifiedAt: null, until: { not: null } },
        ],
      },
      take: 50,
    })
    const own = await watchedByAgent(rows, event.fromAgentRef)
    let applied = 0
    for (const row of rows) {
      // The run that wrote this line is the one watching: it already knows, and
      // settling it would queue a wake whose run writes the next line.
      if (own.has(row.id)) continue
      await applyEvent(row, event)
      applied++
    }
    if (own.size) {
      console.log(`[BackgroundTasks] ${source}:${targetRef} ignored by ${own.size} watch(es) of its own agent ${event.fromAgentRef}`)
    }
    return applied
  } catch (err) {
    console.warn(`[BackgroundTasks] emit ${source}:${targetRef} failed:`, (err as Error).message)
    return 0
  }
}

/**
 * The watches in `rows` held by `agentRef`, i.e. sitting in one of its chat
 * sessions. The session is the only record of who owns a watch.
 */
async function watchedByAgent(rows: BackgroundTaskRow[], agentRef: string | undefined): Promise<Set<string>> {
  if (!agentRef || !rows.length) return new Set()
  const sessions: Array<{ id: string; contextType: string | null; contextId: string | null }> = await db.chatSession
    .findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.chatSessionId))] } },
      select: { id: true, contextType: true, contextId: true },
    })
    .catch(() => [])
  const mine = new Set(
    sessions
      .filter((s) => (s.contextType === 'project' && s.contextId ? `project:${s.contextId}` : 'workspace') === agentRef)
      .map((s) => s.id),
  )
  return new Set(rows.filter((row) => mine.has(row.chatSessionId)).map((row) => row.id))
}

export function newTaskId(): string {
  return `t_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`
}

export function replyTargetRef(triggerMessageId: string, projectId: string | null): string {
  return `${triggerMessageId}:${projectId ?? 'ws'}`
}

/** One task per agent a post hands work to; each settles when that agent's reply does. */
export async function createReplyTasks(
  chatSessionId: string,
  triggerMessageId: string,
  agents: Array<{ projectId: string | null; name: string }>,
  where?: { conversationId?: string | null; threadRootId?: string | null; workspaceId?: string | null },
): Promise<Array<{ task_id: string; title: string; status: 'running' }>> {
  const out: Array<{ task_id: string; title: string; status: 'running' }> = []
  // The thread the tags were posted in: that is where the replies land, so it
  // is what the dock opens instead of an empty log.
  const link = where?.conversationId
    ? {
        kind: 'channel_thread' as const,
        conversationId: where.conversationId,
        threadRootId: where.threadRootId ?? triggerMessageId,
        ...(where.workspaceId ? { workspaceId: where.workspaceId } : {}),
      }
    : undefined
  for (const agent of agents) {
    const row = await createTask({
      id: newTaskId(),
      chatSessionId,
      source: 'agent_reply',
      targetRef: replyTargetRef(triggerMessageId, agent.projectId),
      title: `@${agent.name} reply`,
      ...(link ? { link } : {}),
    })
    out.push({ task_id: row.id, title: row.title, status: 'running' })
  }
  return out
}

// ─── Local tasks handed over by the runtime ───────────────────────────────────

export interface LocalTaskNotice {
  id: string
  source: string
  title: string
  status: string
  text: string
}

/**
 * Ids the runtime has already been told about, so a looping notice logs once
 * instead of once per copy (SHO-196).
 */
const ignoredRuntimeNotices = new Set<string>()

/**
 * A runtime's own finished task, handed over so the API can queue its wake.
 *
 * The gate in here is what makes delivery idempotent (SHO-196). The runtime can
 * re-send a note whose task entry it has already evicted, and that note's text
 * is a snapshot of an old milestone; writing it would overwrite the current
 * state of the row and wake the session again on every turn end.
 */
export async function notifyLocalTasks(chatSessionId: string, tasks: LocalTaskNotice[]): Promise<number> {
  let n = 0
  for (const task of tasks.slice(0, 50)) {
    if (typeof task?.id !== 'string' || !/^t_[A-Za-z0-9]{4,32}$/.test(task.id)) continue
    const status: BackgroundTaskStatus = isFinal(task.status) ? task.status as BackgroundTaskStatus : 'completed'
    const existing = await db.backgroundTask.findUnique({ where: { id: task.id } })
    // The API owns these rows (`project_call`, `agent_reply`, `work_item`): it
    // re-arms the watch and formats the wake from the row's own output, so a
    // runtime notice about one of them is never its to write.
    if (existing && REMOTE_SOURCES.has(existing.source)) {
      if (!ignoredRuntimeNotices.has(task.id)) {
        if (ignoredRuntimeNotices.size >= 500) ignoredRuntimeNotices.clear()
        ignoredRuntimeNotices.add(task.id)
        console.warn(`[BackgroundTasks] ignored runtime notice for API-tracked ${existing.source} task ${task.id}`)
      }
      continue
    }
    // A local task finishes once. A second notice for the same id in the same
    // state is a replay: it must not rewrite the row or queue another wake. A
    // row that was never delivered is still owed its wake, so it passes through.
    if (existing && existing.status === status && (existing.notifiedAt !== null || existing.consumed)) continue
    const now = new Date()
    await db.backgroundTask.upsert({
      where: { id: task.id },
      create: {
        id: task.id,
        chatSessionId,
        source: String(task.source || 'shell').slice(0, 40),
        targetRef: task.id,
        title: String(task.title || task.id).slice(0, 300),
        status,
        summary: status,
        note: String(task.text || '').slice(0, 8_000),
        finishedAt: now,
        expiresAt: new Date(now.getTime() + TASK_TTL_MS),
      },
      update: { status, note: String(task.text || '').slice(0, 8_000), finishedAt: now },
    })
    n++
  }
  if (n) scheduleTaskWake(chatSessionId)
  return n
}

// ─── Wake ─────────────────────────────────────────────────────────────────────

const wakeTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Finished tasks arriving close together wake the session once. */
export function scheduleTaskWake(chatSessionId: string, delayMs = WAKE_COALESCE_MS): void {
  if (wakeTimers.has(chatSessionId)) return
  const timer = setTimeout(() => {
    wakeTimers.delete(chatSessionId)
    void enqueueTaskWake(chatSessionId).catch((err) =>
      console.warn(`[BackgroundTasks] wake for ${chatSessionId} failed:`, (err as Error).message))
  }, delayMs)
  ;(timer as any).unref?.()
  wakeTimers.set(chatSessionId, timer)
}

const holdTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** A held watch whose thread never reported back still wakes its session when the hold runs out. */
function scheduleHoldExpiry(chatSessionId: string): void {
  const existing = holdTimers.get(chatSessionId)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    holdTimers.delete(chatSessionId)
    scheduleTaskWake(chatSessionId)
  }, CARD_HOLD_MS + WAKE_COALESCE_MS)
  ;(timer as any).unref?.()
  holdTimers.set(chatSessionId, timer)
}

async function wakeUserFor(session: { id: string; createdByUserId?: string | null; workspaceId?: string | null; contextType?: string; contextId?: string | null }): Promise<string | null> {
  if (session.createdByUserId) return session.createdByUserId
  const queued = await db.chatQueuedMessage.findFirst({ where: { sessionId: session.id }, orderBy: { createdAt: 'desc' }, select: { userId: true } })
  if (queued?.userId) return queued.userId
  let workspaceId = session.workspaceId ?? null
  if (!workspaceId && session.contextType === 'project' && session.contextId) {
    workspaceId = (await db.project.findUnique({ where: { id: session.contextId }, select: { workspaceId: true } }))?.workspaceId ?? null
  }
  if (!workspaceId) return null
  const owner = await db.member.findFirst({ where: { workspaceId, role: 'owner' }, orderBy: { createdAt: 'asc' }, select: { userId: true } })
  return owner?.userId ?? null
}

/**
 * These two live in `workspace-pause.service` so the dispatcher, the sweep and
 * the wake producer all read the flag the same way.
 */
const isSessionWorkspacePaused = (session: {
  workspaceId?: string | null
  contextType?: string | null
  contextId?: string | null
}): Promise<boolean> =>
  import('./workspace-pause.service').then((module) => module.isSessionWorkspacePaused(session))

/**
 * Queue one wake message per finished, unseen task in the session, in finish
 * order: one [Task update] per message, so the agent acts on each result as it
 * lands instead of on a batch. The dispatcher re-checks `consumed` just before
 * sending a row, and the turn-end hook chains the rest, so a burst is delivered
 * one turn each. The coalesce timers upstream only delay the burst.
 */
export async function enqueueTaskWake(chatSessionId: string, opts: { dispatch?: boolean } = {}): Promise<boolean> {
  const session = await db.chatSession.findUnique({
    where: { id: chatSessionId },
    select: { id: true, createdByUserId: true, workspaceId: true, contextType: true, contextId: true },
  })
  if (!session) return false
  // A workspace-wide pause holds every automatic wake at the source: no row is
  // written, so the task stays finished-and-unseen and is delivered once the
  // pause lifts (`sweepUnnotifiedWakes` re-derives it, nothing is lost).
  if (await isSessionWorkspacePaused(session)) return false
  const tasks: BackgroundTaskRow[] = await db.backgroundTask.findMany({
    where: {
      chatSessionId, status: { not: 'running' }, notify: true, consumed: false, notifiedAt: null,
      OR: [{ heldUntil: null }, { heldUntil: { lte: new Date() } }],
    },
    orderBy: [{ finishedAt: 'asc' }, { createdAt: 'asc' }],
    take: 20,
  })
  if (!tasks.length) return false
  const userId = await wakeUserFor(session)
  if (!userId) return false
  const latest = await db.chatQueuedMessage.findFirst({
    where: { sessionId: chatSessionId },
    orderBy: [{ position: 'desc' }, { createdAt: 'desc' }],
    select: { position: true },
  })
  let position = latest?.position ?? -1
  let queued = 0
  for (const task of tasks) {
    const claimed = await db.backgroundTask.updateMany({
      where: { id: task.id, notifiedAt: null },
      data: { notifiedAt: new Date() },
    })
    if (claimed.count === 0) continue

    // Read it again: a milestone can land between the batch read above and this
    // claim, and the agent must hear the state now rather than the one that was
    // true a moment ago.
    const fresh = (await getTask(task.id)) ?? task
    const text = formatTaskNote(fresh)
    const taskIds = [fresh.id]
    position += 1
    await db.chatQueuedMessage.create({
      data: {
        sessionId: chatSessionId,
        userId,
        position,
        status: 'pending',
        kind: 'task_notification',
        content: text,
        parts: JSON.stringify([
          { type: 'text', text },
          { type: 'data-task-notification', data: { taskIds } },
        ]),
        body: JSON.stringify({ text, taskNotification: { taskIds } }),
      },
    })
    // The milestone is in the queue, so the watch can go back to watching the
    // same card without losing this wake (see `rearmCardWatch`).
    await rearmCardWatch(fresh).catch(() => null)
    queued++
  }
  if (queued === 0) return false
  // The drain sweeps and then dispatches in one pass, so it asks for the row
  // without racing its own dispatcher for the claim.
  if (opts.dispatch !== false) {
    const { dispatchNext } = await import('./chat-queue-dispatcher.service')
    void dispatchNext(chatSessionId).catch(() => {})
  }
  return true
}

// ─── Wake pause: waits, not messages ─────────────────────────────────────────

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/**
 * A user message that is a queued background-task wake.
 *
 * A resume queued after a killed run (`kind: 'resume'`, SHO-121) carries a
 * `data-resume` part and no `data-task-notification`, so it is deliberately not
 * one of these and cannot pause wakes.
 */
export function isTaskWakeMessage(parts: string | null | undefined): boolean {
  return parseJson<Array<{ type?: string }>>(parts, []).some((p) => p?.type === 'data-task-notification')
}

/**
 * The part types the queue writes for the machine's own bookkeeping: a task
 * wake, and a resume after an interrupted turn.
 *
 * They persist as `role: 'user'` rows because that is how the queue delivers a
 * turn, but nobody typed them — so neither may count as a person. Two rules
 * read this: the one-resume-per-person rule (`postInterruptedResume`) and the
 * wake pause (`consecutiveWakeWaits`). Add a new synthetic kind here, once.
 */
const AUTONOMOUS_USER_PART_TYPES = new Set(['data-task-notification', 'data-resume'])

/**
 * Whether a user message was written by the system rather than a person.
 *
 * Not the same as `isTaskWakeMessage`: a resume is autonomous but is not a
 * wake, and before SHO-227 that difference is exactly what reset both caps.
 */
export function isAutonomousUserMessage(parts: string | null | undefined): boolean {
  return parseJson<Array<{ type?: string }>>(parts, []).some(
    (p) => typeof p?.type === 'string' && AUTONOMOUS_USER_PART_TYPES.has(p.type),
  )
}

/** The tasks a wake message's `parts` were queued for. */
export function taskWakeIdsFromParts(parts: string | null | undefined): string[] {
  for (const part of parseJson<Array<{ type?: string; data?: { taskIds?: unknown } }>>(parts, [])) {
    if (part?.type !== 'data-task-notification') continue
    const ids = part.data?.taskIds
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
  }
  return []
}

/** The tasks a queued wake row was queued for. */
export function taskWakeIdsFromBody(body: string | null | undefined): string[] {
  const parsed = parseJson<{ taskNotification?: { taskIds?: unknown } }>(body, {})
  const ids = parsed.taskNotification?.taskIds
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
}

/**
 * A person resumed this wake from the composer: it ends the run of automatic
 * wakes, so the pause is over and this wake starts the count again. Stored on
 * the message `parts` (what `consecutiveWakeWaits` reads) and on the queued
 * row's `body` (what the dispatcher reads before it sends it).
 */
export function taskWakeResetsRun(parts: string | null | undefined): boolean {
  return parseJson<Array<{ type?: string; data?: { wakeRunReset?: unknown } }>>(parts, []).some(
    (p) => p?.type === 'data-task-notification' && p.data?.wakeRunReset === true,
  )
}

/** Same mark, read off a queued wake row's body. */
export function taskWakeBodyResetsRun(body: string | null | undefined): boolean {
  return parseJson<{ taskNotification?: { wakeRunReset?: unknown } }>(body, {}).taskNotification?.wakeRunReset === true
}

/**
 * How many distinct waits the trailing run of wake turns adds up to.
 *
 * With one wake message per finished task, counting messages pauses a session
 * that merely had four tasks finish. What matters is how many *new* waits the
 * agent woke for: a wake is a continuation of the previous one (no count) when
 * every task in it was already running before that previous wake turn started;
 * it starts a new wait when it introduces a task created after it. A person
 * writing ends the run, and the oldest wake in it always counts as one.
 *
 * A re-armed watch — one row per card, so it keeps its id and its `createdAt` —
 * wakes on the same task again and again. That is a new wait each time, and it is
 * read off the wake messages rather than the row, because re-arming clears the
 * row (`finishedAt`, `notifiedAt`) before the cap is measured. Otherwise a card
 * watch that keeps waking itself could never reach the cap (SHO-129).
 *
 * A wake a person resumed from the composer (`wakeRunReset`) ends the run too:
 * that is the pause lifting, and the wake it delivers starts the count again.
 *
 * A resume after an interrupted turn is skipped rather than treated as a
 * person (SHO-227). It reads as a user message, but nobody wrote it — and
 * letting it end the run is what reset the pause after every restart, so a
 * watch that re-armed itself in the resumed turn could wake forever.
 */
export async function consecutiveWakeWaits(chatSessionId: string, limit: number): Promise<number> {
  // Autonomous rows inside the run are skipped, so the window has to be wider
  // than the number of wakes it must be able to see.
  const recent: Array<{ parts: string | null; createdAt: Date }> = await db.chatMessage.findMany({
    where: { sessionId: chatSessionId, role: 'user' },
    orderBy: { createdAt: 'desc' },
    take: limit * 2 + 2,
    select: { parts: true, createdAt: true },
  })
  const run: Array<{ at: Date; taskIds: string[] }> = []
  let newestWake: string | null = null
  for (const message of recent) {
    if (isTaskWakeMessage(message.parts)) {
      if (newestWake === null) newestWake = message.parts
      run.push({ at: message.createdAt, taskIds: taskWakeIdsFromParts(message.parts) })
      continue
    }
    // A resume is the machine restarting itself, not a person: it neither ends
    // the run nor counts as a wait.
    if (isAutonomousUserMessage(message.parts)) continue
    break
  }
  if (!run.length) return 0
  if (taskWakeResetsRun(newestWake)) return 1

  const ids = [...new Set(run.flatMap((wake) => wake.taskIds))]
  const rows: Array<{ id: string; createdAt: Date }> = ids.length
    ? await db.backgroundTask.findMany({ where: { id: { in: ids } }, select: { id: true, createdAt: true } })
    : []
  const startedAt = new Map(rows.map((row) => [row.id, row.createdAt.getTime()]))

  let waits = 1
  for (let i = 0; i + 1 < run.length; i++) {
    // The same task reporting twice in a row is a re-armed watch waking again.
    const older = new Set(run[i + 1]!.taskIds)
    const rearmed = run[i]!.taskIds.some((id) => older.has(id))
    let newestTaskAt = 0
    for (const id of run[i]!.taskIds) newestTaskAt = Math.max(newestTaskAt, startedAt.get(id) ?? 0)
    if (rearmed || newestTaskAt > run[i + 1]!.at.getTime()) waits++
  }
  return waits
}

export interface SessionWakeWait {
  taskId: string
  source: string
  title: string
  /** When the task finished; null while the task itself is still running (a live card watch). */
  finishedAt: string | null
}

export interface SessionWakeState {
  paused: boolean
  wakesInARow: number
  limit: number
  waiting: SessionWakeWait[]
}

/**
 * What a session is waiting to be told, derived from the queue it could not
 * drain.
 *
 * When a session hits the wake cap the dispatcher leaves one `failed`
 * `task_notification` row holding the pause and hands the tasks back to the
 * sweep, so the results sit finished-and-unseen while nothing tells the agent
 * or the person. This reads that state back: no table, no column. `AgentWake`
 * owns queued *runs*; this is the delivery queue, and `consecutiveWakeWaits`
 * stays the only definition of "paused".
 */
export async function sessionWakeState(chatSessionId: string): Promise<SessionWakeState> {
  const pausedRows: Array<{ body: string | null; content: string }> = await db.chatQueuedMessage.findMany({
    where: { sessionId: chatSessionId, kind: 'task_notification', status: 'failed', error: { in: WAKE_PAUSED_MARKERS } },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    take: 50,
    select: { body: true, content: true },
  })
  const taskIds = [...new Set(pausedRows.flatMap((row) => taskWakeIdsFromBody(row.body)))]
  const rows: Array<{ id: string; source: string; title: string; finishedAt: Date | null }> = taskIds.length
    ? await db.backgroundTask.findMany({
        where: { id: { in: taskIds } },
        select: { id: true, source: true, title: true, finishedAt: true },
      })
    : []
  const byId = new Map(rows.map((row) => [row.id, row]))
  const waiting: SessionWakeWait[] = []
  for (const row of pausedRows) {
    for (const id of taskWakeIdsFromBody(row.body)) {
      if (waiting.some((w) => w.taskId === id)) continue
      const task = byId.get(id)
      waiting.push({
        taskId: id,
        source: task?.source ?? 'task',
        title: task?.title ?? row.content.split('\n')[0]!.slice(0, 120),
        finishedAt: task?.finishedAt ? task.finishedAt.toISOString() : null,
      })
    }
  }
  const cardsOnly = rows.length > 0 && rows.every((row) => row.source === 'work_item')
  const limit = cardsOnly ? MAX_CONSECUTIVE_CARD_WAKES : MAX_CONSECUTIVE_WAKES
  return {
    paused: pausedRows.length > 0,
    wakesInARow: await consecutiveWakeWaits(chatSessionId, limit),
    limit,
    waiting,
  }
}

// ─── Durability ───────────────────────────────────────────────────────────────

/**
 * Re-derive wakes that the coalesce timer never got to: a finished, unseen
 * task whose row was never claimed has no queued message behind it, and
 * nothing else would ever create one. Runs from the drain worker, so a
 * restarted API heals itself on its next tick (and a peer region leaves the
 * session to its home region). `enqueueTaskWake`'s conditional claim keeps
 * concurrent sweeps from queueing the same wake twice.
 */
export async function sweepUnnotifiedWakes(limit = 50): Promise<number> {
  const now = new Date()
  // A pause lifts when a person writes, so the updates it held are handed back
  // here rather than only on the turn that ended the pause.
  await releaseLiftedPauseHolds(now).catch((error) =>
    console.warn('[BackgroundTasks] releasing pause-held wakes failed:', (error as Error).message))
  const sessions: Array<{ chatSessionId: string }> = await db.backgroundTask.findMany({
    where: {
      status: { not: 'running' },
      notify: true,
      consumed: false,
      notifiedAt: null,
      expiresAt: { gt: now },
      AND: [
        { OR: [{ heldUntil: null }, { heldUntil: { lte: now } }] },
        { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      ],
    },
    distinct: ['chatSessionId'],
    select: { chatSessionId: true },
    take: limit,
  })
  if (!sessions.length) return 0
  const { isHomeRegionSession } = await import('./chat-queue-dispatcher.service')
  const { isChatSessionWorkspacePaused } = await import('./workspace-pause.service')
  let queued = 0
  for (const row of sessions) {
    if (!(await isHomeRegionSession(row.chatSessionId))) continue
    // A paused workspace is skipped before anything is queued: its updates stay
    // finished-and-unseen and this sweep picks them up on the first tick after
    // the pause lifts.
    if (await isChatSessionWorkspacePaused(row.chatSessionId)) continue
    if (await enqueueTaskWake(row.chatSessionId, { dispatch: false })) queued++
  }
  return queued
}

export interface WakeRelease {
  /** Tasks handed back to the sweep for another attempt. */
  released: number
  /** Tasks that just hit `MAX_WAKE_ATTEMPTS`: held until they expire instead. */
  capped: string[]
}

/**
 * A wake claimed these tasks but never ran: hand them back so the sweep can
 * queue them again once the runtime is healthy. Repeated failures back off
 * instead of hot-looping, and a wake still failing after `MAX_WAKE_ATTEMPTS`
 * stops being retried at all.
 */
export async function releaseTaskWakes(taskIds: string[]): Promise<WakeRelease> {
  const ids = taskIds.filter((id) => typeof id === 'string' && id.length <= 64).slice(0, 200)
  if (!ids.length) return { released: 0, capped: [] }
  const rows: Array<{ id: string; attempts: number; expiresAt: Date }> = await db.backgroundTask.findMany({
    where: { id: { in: ids }, consumed: false, notifiedAt: { not: null } },
    select: { id: true, attempts: true, expiresAt: true },
  })
  if (!rows.length) return { released: 0, capped: [] }
  const byAttempts = new Map<number, string[]>()
  const capped: Array<{ id: string; expiresAt: Date }> = []
  for (const row of rows) {
    if (row.attempts + 1 >= MAX_WAKE_ATTEMPTS) {
      capped.push(row)
      continue
    }
    const group = byAttempts.get(row.attempts) ?? []
    group.push(row.id)
    byAttempts.set(row.attempts, group)
  }
  for (const [attempts, group] of byAttempts) {
    const delay = WAKE_RETRY_BACKOFF_MS[Math.min(attempts, WAKE_RETRY_BACKOFF_MS.length - 1)]!
    await db.backgroundTask.updateMany({
      where: { id: { in: group }, consumed: false, notifiedAt: { not: null } },
      data: { notifiedAt: null, heldUntil: null, attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + delay) },
    })
  }
  for (const row of capped) {
    // Its last attempt is behind it: keep `notifiedAt` so nothing queues it
    // again, and hold it to its own expiry. The queue keeps the failed row that
    // says it could not be delivered.
    await db.backgroundTask.updateMany({
      where: { id: row.id, consumed: false },
      data: { attempts: { increment: 1 }, heldUntil: row.expiresAt },
    })
  }
  return { released: rows.length - capped.length, capped: capped.map((row) => row.id) }
}

/**
 * A wake cannot be delivered because the session's wakes are paused: hold the
 * tasks instead of handing them back.
 *
 * Releasing them re-armed the same wake on the retry backoff, so a session left
 * paused accumulated one failed row per attempt for the task's whole 24 h TTL
 * (1,150 of them across 9 chats on 2026-10-20). Held tasks are out of the
 * sweep's reach until a person writes, and then `releaseLiftedPauseHolds` hands
 * them back once.
 *
 * A pause hold is `heldUntil = expiresAt` — the card hold in `holdTasks` is
 * `now + CARD_HOLD_MS`, so the two never look alike. `notifiedAt` stays: the
 * wake was claimed, and only the release puts it back in the sweep's reach.
 */
export async function holdTaskWakes(taskIds: string[]): Promise<number> {
  const ids = taskIds.filter((id) => typeof id === 'string' && id.length <= 64).slice(0, 200)
  if (!ids.length) return 0
  const rows: Array<{ id: string; expiresAt: Date }> = await db.backgroundTask.findMany({
    where: { id: { in: ids }, consumed: false, notifiedAt: { not: null } },
    select: { id: true, expiresAt: true },
  })
  for (const row of rows) {
    await db.backgroundTask.updateMany({
      where: { id: row.id, consumed: false },
      data: { heldUntil: row.expiresAt },
    })
  }
  // One attempt was made. The counter records that and then stops climbing.
  if (rows.length) {
    await db.backgroundTask.updateMany({
      where: { id: { in: rows.map((row) => row.id) }, attempts: { lt: 1 } },
      data: { attempts: 1 },
    })
  }
  return rows.length
}

/** Tasks held by a pause, as opposed to a card hold. Capped wakes are left out on purpose. */
async function pauseHeldTasks(now: Date): Promise<Array<{ id: string; chatSessionId: string; source: string }>> {
  const rows: Array<{ id: string; chatSessionId: string; source: string; heldUntil: Date | null; expiresAt: Date }> =
    await db.backgroundTask.findMany({
      where: {
        status: { not: 'running' },
        notify: true,
        consumed: false,
        notifiedAt: { not: null },
        heldUntil: { gt: now },
        expiresAt: { gt: now },
        attempts: { lt: MAX_WAKE_ATTEMPTS },
      },
      select: { id: true, chatSessionId: true, source: true, heldUntil: true, expiresAt: true },
      take: 500,
    })
  return rows
    .filter((row) => row.heldUntil?.getTime() === row.expiresAt.getTime())
    .map(({ id, chatSessionId, source }) => ({ id, chatSessionId, source }))
}

/**
 * The pause lifted (a person wrote, or a resumed wake ran): the tasks it held
 * are handed back to the sweep, which queues each waiting update once.
 * `consecutiveWakeWaits` stays the only definition of "paused" — this does not
 * re-implement the cap.
 */
async function releaseLiftedPauseHolds(now: Date): Promise<number> {
  const held = await pauseHeldTasks(now)
  if (!held.length) return 0
  const bySession = new Map<string, Array<{ id: string; source: string }>>()
  for (const row of held) {
    const group = bySession.get(row.chatSessionId) ?? []
    group.push({ id: row.id, source: row.source })
    bySession.set(row.chatSessionId, group)
  }
  let released = 0
  for (const [chatSessionId, rows] of bySession) {
    const limit = rows.every((row) => row.source === 'work_item') ? MAX_CONSECUTIVE_CARD_WAKES : MAX_CONSECUTIVE_WAKES
    if ((await consecutiveWakeWaits(chatSessionId, limit)) >= limit) continue
    const cleared = await db.backgroundTask.updateMany({
      where: { id: { in: rows.map((row) => row.id) }, consumed: false },
      data: { heldUntil: null, notifiedAt: null },
    })
    released += cleared.count
  }
  return released
}

/**
 * Tasks the API tracks itself only settle when their producer reports back. A
 * run that died leaves the row `running` for its whole TTL, so the watcher
 * would never be told anything: give up on it here, with the wake left on.
 */
export async function reconcileStuckTasks(): Promise<number> {
  const now = new Date()
  const stuck: BackgroundTaskRow[] = await db.backgroundTask.findMany({
    where: {
      source: 'agent_reply',
      status: 'running',
      createdAt: { lt: new Date(now.getTime() - AGENT_REPLY_RECONCILE_MS) },
    },
    take: 50,
  })
  let settled = 0
  for (const row of stuck) {
    await settle(row, 'failed', 'the agent run ended without reporting back')
    settled++
  }
  const calls: BackgroundTaskRow[] = await db.backgroundTask.findMany({
    where: { source: 'project_call', status: 'running', createdAt: { lt: new Date(now.getTime() - 5 * 60_000) } },
    take: 50,
  })
  for (const row of calls) {
    if (await settleIfAlreadyDone(row)) settled++
  }
  return settled
}

/** Test seam. */
export const _testing = {
  waiters,
  wakeTimers,
  holdTimers,
  clearTimers() {
    for (const t of wakeTimers.values()) clearTimeout(t)
    wakeTimers.clear()
    for (const t of holdTimers.values()) clearTimeout(t)
    holdTimers.clear()
  },
}
