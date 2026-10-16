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
 * of kind `task_notification` is dispatched through the normal chat queue.
 * The runtime also hands over its own finished tasks (`notifyLocalTasks`) when
 * the session is idle, so the queue is the one wake path.
 */

import { prisma } from '../lib/prisma'

const db = prisma as any

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
 * Longest a finished card watch waits for agents still working the card's
 * thread. Outlasts a channel agent run (`AGENT_REPLY_TIMEOUT_MS`), so it only
 * fires when a run hangs or ends without reporting back.
 */
export const CARD_HOLD_MS = 31 * 60_000

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
  heldUntil?: Date | null
  finishedAt: Date | null
  expiresAt: Date
  createdAt: Date
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

export function viewOf(row: BackgroundTaskRow, matched?: boolean): BackgroundTaskView {
  return {
    id: row.id,
    source: row.source,
    title: row.title,
    status: row.status,
    output: row.output,
    result: isFinal(row.status) ? { summary: row.summary ?? row.status } : null,
    ...(matched ? { matched: true } : {}),
    startedAt: new Date(row.createdAt).toISOString(),
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
  const row = await db.backgroundTask.create({
    data: {
      id: input.id,
      chatSessionId: input.chatSessionId,
      source: input.source,
      targetRef: input.targetRef.trim().slice(0, 500),
      title: String(input.title || input.source).slice(0, 300),
      until: input.until ?? null,
      expiresAt: new Date(Date.now() + (input.source === 'work_item' ? CARD_TASK_TTL_MS : TASK_TTL_MS)),
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

/** The agent saw these results (it waited, or they were injected into a turn): never wake for them. */
export async function consumeTasks(ids: string[]): Promise<number> {
  const clean = ids.filter((id) => typeof id === 'string' && id.length <= 64).slice(0, 200)
  if (!clean.length) return 0
  const res = await db.backgroundTask.updateMany({ where: { id: { in: clean } }, data: { consumed: true } })
  return res.count
}

// ─── Events ───────────────────────────────────────────────────────────────────

export interface TaskEvent {
  status?: Exclude<BackgroundTaskStatus, 'running'>
  line?: string
  summary?: string
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

async function applyEvent(row: BackgroundTaskRow, event: TaskEvent): Promise<BackgroundTaskRow> {
  let current = row
  if (event.line) {
    const output = capOutput(current.output ? `${current.output}\n${event.line}` : event.line)
    current = await db.backgroundTask.update({ where: { id: row.id }, data: { output } })
  }
  if (event.status) return settle(current, event.status, event.summary)
  const until = compileUntil(current.until)
  if (until && until.test(current.output)) return settle(current, 'completed', `matched ${current.until}`)
  signal(row.id)
  return current
}

/**
 * Something happened to `targetRef`. Every running task watching it gets the
 * line; a status settles it. Never throws: producers call this inline.
 */
export async function emitTaskEvent(source: string, targetRef: string, event: TaskEvent): Promise<number> {
  try {
    const rows: BackgroundTaskRow[] = await db.backgroundTask.findMany({
      where: { source, targetRef, status: 'running' },
      take: 50,
    })
    for (const row of rows) await applyEvent(row, event)
    return rows.length
  } catch (err) {
    console.warn(`[BackgroundTasks] emit ${source}:${targetRef} failed:`, (err as Error).message)
    return 0
  }
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
): Promise<Array<{ task_id: string; title: string; status: 'running' }>> {
  const out: Array<{ task_id: string; title: string; status: 'running' }> = []
  for (const agent of agents) {
    const row = await createTask({
      id: newTaskId(),
      chatSessionId,
      source: 'agent_reply',
      targetRef: replyTargetRef(triggerMessageId, agent.projectId),
      title: `@${agent.name} reply`,
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

export async function notifyLocalTasks(chatSessionId: string, tasks: LocalTaskNotice[]): Promise<number> {
  let n = 0
  for (const task of tasks.slice(0, 50)) {
    if (typeof task?.id !== 'string' || !/^t_[A-Za-z0-9]{4,32}$/.test(task.id)) continue
    const status: BackgroundTaskStatus = isFinal(task.status) ? task.status as BackgroundTaskStatus : 'completed'
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
 * Queue one wake message for every finished, unseen task in the session. The
 * dispatcher re-checks `consumed` just before sending it, so a turn the person
 * started in the meantime (which already saw the results) cancels the wake.
 */
export async function enqueueTaskWake(chatSessionId: string): Promise<boolean> {
  const session = await db.chatSession.findUnique({
    where: { id: chatSessionId },
    select: { id: true, createdByUserId: true, workspaceId: true, contextType: true, contextId: true },
  })
  if (!session) return false
  const tasks: BackgroundTaskRow[] = await db.backgroundTask.findMany({
    where: {
      chatSessionId, status: { not: 'running' }, notify: true, consumed: false, notifiedAt: null,
      OR: [{ heldUntil: null }, { heldUntil: { lte: new Date() } }],
    },
    orderBy: { finishedAt: 'asc' },
    take: 20,
  })
  if (!tasks.length) return false
  const userId = await wakeUserFor(session)
  if (!userId) return false
  const taskIds = tasks.map((t) => t.id)
  const claimed = await db.backgroundTask.updateMany({
    where: { id: { in: taskIds }, notifiedAt: null },
    data: { notifiedAt: new Date() },
  })
  if (claimed.count === 0) return false

  const text = tasks.map(formatTaskNote).join('\n\n')
  const latest = await db.chatQueuedMessage.findFirst({
    where: { sessionId: chatSessionId },
    orderBy: [{ position: 'desc' }, { createdAt: 'desc' }],
    select: { position: true },
  })
  await db.chatQueuedMessage.create({
    data: {
      sessionId: chatSessionId,
      userId,
      position: (latest?.position ?? -1) + 1,
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
  const { dispatchNext } = await import('./chat-queue-dispatcher.service')
  void dispatchNext(chatSessionId).catch(() => {})
  return true
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
