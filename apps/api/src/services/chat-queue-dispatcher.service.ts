// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { randomUUID } from 'node:crypto'
import { prisma } from '../lib/prisma'
import { homeRegionWorkspaceWhere } from '../lib/region'
import { MAX_WAKE_ATTEMPTS, taskWakeBodyResetsRun, taskWakeIdsFromBody, WAKE_PAUSED, WAKE_PAUSED_MARKERS, WAKE_WORKSPACE_PAUSED, type WakeRelease } from './background-tasks.service'

/** Well above TURN_REATTACH_AFTER_MS, so the reattach job gets to a dead tracker's turn first. */
const ACTIVE_TURN_STALE_AFTER_MS = 10 * 60 * 1000

/**
 * A queued task wake older than this is history, not news. When delivery stalls
 * (the app was closed, the API wedged) the backlog must not replay as one burst
 * of turns the moment the queue moves again: on 2026-10-27 a desktop restart
 * started ~100 turns in 90 s (37 for one agent) for updates up to 2.5 days old,
 * most about cards that were already Done.
 */
export const STALE_TASK_WAKE_MS = 6 * 60 * 60 * 1000

/** A wake about cards that are all closed now has nothing to act on after this long. */
export const STALE_CLOSED_CARD_WAKE_MS = 30 * 60 * 1000

/**
 * Automatic wakes one agent may start per drain tick, and in total. A restart
 * with a backlog drains it over a few ticks instead of spawning every turn at
 * once. A person's own queued message is never held by this.
 */
export const MAX_WAKES_PER_AGENT_PER_TICK = 2
export const MAX_WAKES_PER_TICK = 8

const WAKE_STALE = 'stale'

/**
 * `chat_queued_messages` replicates between regions, and the claim below is a
 * conditional UPDATE that only serializes writers on one database. Every queue
 * write (claim, user-message persist, turn start, delete, stuck reset) must
 * therefore happen in the session's home region only; otherwise two regions
 * claim the same row and insert the same `chat_messages.id`, which stops
 * logical replication on `insert_exists`. Null in single-region / local mode.
 */
function homeSessionWhere() {
  const home = homeRegionWorkspaceWhere()
  if (!home) return null
  return { OR: [{ project: { workspace: home } }, { workspace: home }] }
}

/**
 * Which of these sessions may run on the cloud (SHO-185).
 *
 * A session belongs to a workspace either through its project or directly, and
 * either can be a machine copy — whose agent runs on the desktop. Asking here
 * keeps the dispatcher's own home-region where intact instead of folding two
 * relation shapes into one filter.
 */
async function cloudSessionIds(sessionIds: string[]): Promise<Set<string>> {
  if (!sessionIds.length) return new Set()
  const rows = await (prisma as any).chatSession.findMany({
    where: { id: { in: sessionIds } },
    select: { id: true, workspaceId: true, project: { select: { workspaceId: true } } },
  })
  const workspaceIds = new Set<string>()
  for (const row of rows) {
    if (row.workspaceId) workspaceIds.add(row.workspaceId)
    if (row.project?.workspaceId) workspaceIds.add(row.project.workspaceId)
  }
  if (!workspaceIds.size) return new Set(sessionIds)
  const copies = await (prisma as any).workspace.findMany({
    where: { id: { in: [...workspaceIds] }, machineInstanceId: { not: null } },
    select: { id: true },
  })
  if (!copies.length) return new Set(sessionIds)
  const blocked = new Set<string>(copies.map((copy: { id: string }) => copy.id))
  return new Set(
    rows
      .filter((row: { workspaceId: string | null; project: { workspaceId: string } | null }) =>
        !(row.workspaceId && blocked.has(row.workspaceId)) &&
        !(row.project?.workspaceId && blocked.has(row.project.workspaceId)),
      )
      .map((row: { id: string }) => row.id),
  )
}

export async function isHomeRegionSession(chatSessionId: string): Promise<boolean> {
  const home = homeSessionWhere()
  if (!home) return true
  const count = await (prisma as any).chatSession.count({
    where: { id: chatSessionId, ...home },
  })
  return count > 0
}

type QueueBody = {
  text?: string
  featureId?: string
  phase?: string
  chatSessionId?: string
  chatSessionName?: string
  workspaceId?: string
  userId?: string
  projectId?: string
  focusedProjectId?: string
  agentMode?: string
  dualPlan?: boolean
  timezone?: string
  clientTurnId?: string
  viewer?: Record<string, unknown>
  confirmedPlan?: unknown
  ideContext?: unknown
  references?: unknown
  [key: string]: unknown
}

type QueueRow = {
  id: string
  sessionId: string
  userId: string
  content: string
  parts: string | null
  body: string
  kind?: string | null
  createdAt?: Date | string | null
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

async function consumeResponse(response: Response): Promise<void> {
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Chat runtime returned ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`)
  }

  // The proxy owns stream tracking and persistence, but consuming the returned
  // body prevents a server-side internal fetch from applying backpressure to
  // the runtime stream. The queue row is deleted as soon as the proxy accepts
  // the turn; completion is handled by the proxy's turn-finally hook.
  if (response.body) {
    const reader = response.body.getReader()
    try {
      while (!(await reader.read()).done) {
        // Intentionally discard the server-side SSE copy.
      }
    } finally {
      reader.releaseLock()
    }
  }
}

async function isSessionIdle(chatSessionId: string): Promise<boolean> {
  const session = await (prisma as any).chatSession.findUnique({
    where: { id: chatSessionId },
    select: { activeTurnId: true, activeTurnHeartbeatAt: true },
  })
  if (!session) return false
  if (!session.activeTurnId) return true

  const heartbeat = session.activeTurnHeartbeatAt
    ? new Date(session.activeTurnHeartbeatAt).getTime()
    : 0
  if (heartbeat > Date.now() - ACTIVE_TURN_STALE_AFTER_MS) return false

  // A dead API process can leave the activity marker behind. Clear only the
  // stale marker; a fresh turn is never touched by this recovery path.
  await (prisma as any).chatSession.updateMany({
    where: { id: chatSessionId, activeTurnId: session.activeTurnId },
    data: {
      activeTurnId: null,
      activeTurnStartedAt: null,
      activeTurnHeartbeatAt: null,
    },
  })
  return true
}

async function claimNext(chatSessionId: string): Promise<QueueRow | null> {
  const candidate = await (prisma as any).chatQueuedMessage.findFirst({
    where: { sessionId: chatSessionId, status: 'pending' },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  })
  if (!candidate) return null

  const claimed = await (prisma as any).chatQueuedMessage.updateMany({
    where: { id: candidate.id, sessionId: chatSessionId, status: 'pending' },
    data: { status: 'dispatching', error: null },
  })
  if (claimed.count !== 1) return null
  return candidate as QueueRow
}

async function persistQueuedUserMessage(row: QueueRow, body: QueueBody): Promise<void> {
  const parts = row.parts || JSON.stringify([{ type: 'text', text: row.content }])
  await (prisma as any).chatMessage.upsert({
    where: { id: row.id },
    create: {
      id: row.id,
      sessionId: row.sessionId,
      role: 'user',
      content: row.content,
      parts,
      agent: 'technical',
      model: typeof body.agentMode === 'string' ? body.agentMode : null,
      // Same rule as the chat-message hook: a prompt belongs to the person who
      // queued it. A wake note (`task_notification`) belongs to nobody.
      authorUserId: row.kind === 'task_notification' ? null : row.userId,
    },
    update: {},
  })
  await (prisma as any).chatSession.update({
    where: { id: row.sessionId },
    data: { lastActiveAt: new Date(), updatedAt: new Date() },
  })
}

async function dispatchRow(row: QueueRow): Promise<void> {
  const session = await (prisma as any).chatSession.findUnique({
    where: { id: row.sessionId },
    select: {
      id: true,
      contextType: true,
      contextId: true,
      workspaceId: true,
      name: true,
      inferredName: true,
    },
  })
  if (!session) throw new Error('Chat session no longer exists')

  const body = parseJson<QueueBody>(row.body, {})
  const parts = parseJson<Array<Record<string, unknown>>>(row.parts, [
    { type: 'text', text: row.content },
  ])
  const clientTurnId = `queue-${row.id}-${randomUUID()}`
  // A queued turn (a wake, a message typed while the agent was busy) is a
  // single message. If the runtime no longer holds this session — idle
  // eviction, pod restart — the model would see one line and nothing else, so
  // the stored conversation rides along (SHO-137).
  const historySeed = await import('./chat-history-seed.service')
    .then((m) => m.historySeedFor(row.sessionId, { excludeNewestUserMessage: true }))
    .catch((err: Error) => {
      console.warn(`[chat-queue] history seed for ${row.sessionId} failed:`, err.message)
      return null
    })
  const requestBody = {
    ...body,
    messages: [{ role: 'user', parts }],
    ...(historySeed ? { historySeed } : {}),
    chatSessionId: row.sessionId,
    userId: row.userId,
    clientTurnId,
    // The queue stores the display text separately from the enriched wire
    // text. If the caller did not store a wire text, the raw prompt is safe.
    text: typeof body.text === 'string' ? body.text : row.content,
  }
  const headers = {
    'Content-Type': 'application/json',
    'X-Chat-Session-Id': row.sessionId,
    'X-Billing-User-Id': row.userId,
    'X-Queue-User-Id': row.userId,
  }
  // Keep the runtime manager out of the module-load graph. This dispatcher is
  // imported by both chat routers, including isolated tests that intentionally
  // mock the runtime boundary. It is only needed when a row is actually
  // dispatched, keeping the runtime graph out of chat-route consumers.
  const { getRuntimeManager } = await import('../lib/runtime')
  const runtimeManager = getRuntimeManager()

  let response: Response
  if (session.contextType === 'project' && session.contextId) {
    const { projectChatRoutes } = await import('../routes/project-chat')
    const router = projectChatRoutes({
      runtimeManager,
      suppressCompletionPush: true,
    })
    response = await router.fetch(
      new Request(`http://internal/projects/${encodeURIComponent(session.contextId)}/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      }),
    )
  } else if (session.workspaceId) {
    const { workspaceChatRoutes } = await import('../routes/workspace-chat')
    const router = workspaceChatRoutes({
      runtimeManager,
      alwaysEnabled: true,
      resolveUserId: async (c) =>
        c.req.header('X-Queue-User-Id') || c.req.header('X-Billing-User-Id') || null,
    })
    response = await router.fetch(
      new Request(`http://internal/workspaces/${encodeURIComponent(session.workspaceId)}/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      }),
    )
  } else {
    throw new Error('Chat session has no dispatchable project or workspace')
  }

  // Fail synchronously on a rejected proxy response, then drain its body in
  // the background so the server-side tracker can finish independently of UI.
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Chat proxy returned ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`)
  }
  void consumeResponse(response).catch((error) => {
    console.warn(`[ChatQueue] Internal stream consume failed for ${row.id}:`, error)
  })
}

/** The tasks a task-notification row was queued for. */
function taskWakeIds(row: QueueRow): string[] {
  return taskWakeIdsFromBody(row.body)
}

/**
 * Why a queued task wake should not run: every task in it was already seen
 * (`consumed`), or the session has auto-woken too many times in a row. Either
 * way the row goes; the caller decides whether the tasks are still owed a wake.
 *
 * A wake a person resumed from the composer (`wakeRunReset`) is never paused:
 * resuming *is* the pause lifting, and its turn starts the count again.
 */
async function taskWakeSkipReason(row: QueueRow): Promise<'consumed' | string | null> {
  const ids = taskWakeIds(row)
  let cardsOnly = false
  if (ids.length) {
    const tasks: Array<{ consumed: boolean; source: string }> = await (prisma as any).backgroundTask.findMany({
      where: { id: { in: ids } },
      select: { consumed: true, source: true },
    })
    if (!tasks.some((t) => !t.consumed)) return 'consumed'
    cardsOnly = tasks.every((t) => t.source === 'work_item')
  }
  if (taskWakeBodyResetsRun(row.body)) return null
  // A workspace-wide pause holds every automatic wake — task updates, schedules,
  // card hand-offs, team-chat tags. A person's own message is not a
  // `task_notification` row, so it never reaches here and still runs (SHO-118).
  if (await sessionWorkspacePaused(row.sessionId)) return WAKE_WORKSPACE_PAUSED
  const { MAX_CONSECUTIVE_WAKES, MAX_CONSECUTIVE_CARD_WAKES, consecutiveWakeWaits } =
    await import('./background-tasks.service')
  const limit = cardsOnly ? MAX_CONSECUTIVE_CARD_WAKES : MAX_CONSECUTIVE_WAKES
  if ((await consecutiveWakeWaits(row.sessionId, limit)) >= limit) return WAKE_PAUSED
  return null
}

/**
 * Is this queued wake too old to start a turn for? Only the automatic drain
 * asks: a person resuming or sending a row now still runs it.
 */
async function isStaleWake(row: QueueRow): Promise<boolean> {
  if (taskWakeBodyResetsRun(row.body)) return false
  const created = row.createdAt ? new Date(row.createdAt).getTime() : NaN
  if (!Number.isFinite(created)) return false
  const age = Date.now() - created
  if (age > STALE_TASK_WAKE_MS) return true
  if (age <= STALE_CLOSED_CARD_WAKE_MS) return false
  const ids = taskWakeIds(row)
  if (!ids.length) return false
  const tasks: Array<{ source: string; targetRef: string }> = await (prisma as any).backgroundTask.findMany({
    where: { id: { in: ids } },
    select: { source: true, targetRef: true },
  })
  if (!tasks.length || !tasks.every((t) => t.source === 'work_item')) return false
  const items: Array<{ archivedAt: Date | null; column: { category: string | null } | null }> =
    await (prisma as any).workItem.findMany({
      where: { id: { in: tasks.map((t) => t.targetRef) } },
      select: { archivedAt: true, column: { select: { category: true } } },
    })
  const { isClosedCategory } = await import('./background-tasks.service')
  return items.length === new Set(tasks.map((t) => t.targetRef)).size &&
    items.every((item) => item.archivedAt !== null || isClosedCategory(item.column?.category))
}

/** Is every automatic agent start held in the workspace this session lives in? */
async function sessionWorkspacePaused(chatSessionId: string): Promise<boolean> {
  const { isChatSessionWorkspacePaused } = await import('./workspace-pause.service')
  return isChatSessionWorkspacePaused(chatSessionId)
}

/**
 * Mark a paused wake on the row itself, so the composer can show it as a
 * waiting update with a Resume action instead of as a queued chat message that
 * failed. Read off `body.taskNotification.paused` by the client.
 */
function pausedBody(body: string | null | undefined): string {
  const parsed = parseJson<Record<string, any>>(body, {})
  const taskNotification = parsed.taskNotification && typeof parsed.taskNotification === 'object' ? parsed.taskNotification : {}
  return JSON.stringify({ ...parsed, taskNotification: { ...taskNotification, paused: true } })
}

/**
 * Keep one paused row per session instead of one per wake.
 *
 * The owed updates are held (`holdTaskWakes`), so a paused session produces one
 * marker row per wake it could not deliver; a second marker for the same batch
 * would only be a duplicate. The newest row is the signal; older copies (and
 * the signal itself, once a wake lands and the session is evidently awake
 * again) are dropped.
 */
async function clearPausedWakeRows(chatSessionId: string, keepId?: string): Promise<void> {
  await (prisma as any).chatQueuedMessage.deleteMany({
    where: {
      sessionId: chatSessionId,
      status: 'failed',
      error: { in: WAKE_PAUSED_MARKERS },
      ...(keepId ? { id: { not: keepId } } : {}),
    },
  }).catch(() => {})
}

/**
 * How many times this `kind: 'resume'` row has already failed to start. Kept on
 * the row's body so a resume run by another API instance — or by the instance
 * that replaced the one that noticed the death — still counts the same attempts.
 */
function resumeAttempts(body: string | null | undefined): number {
  const value = parseJson<Record<string, unknown>>(body, {}).resumeAttempts
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function withResumeAttempts(body: string | null | undefined, attempts: number): string {
  return JSON.stringify({ ...parseJson<Record<string, unknown>>(body, {}), resumeAttempts: attempts })
}

/** The tool the resume was queued for, so the stopped-resume note names it too. */
function resumeToolName(parts: string | null | undefined): string | null {
  const list = parseJson<Array<Record<string, any>>>(parts, [])
  if (!Array.isArray(list)) return null
  for (const part of list) {
    if (!part || part.type !== 'data-resume') continue
    const name = part.data && typeof part.data.toolName === 'string' ? part.data.toolName.trim() : ''
    if (name) return name
  }
  return null
}

/**
 * Hand a dropped wake's tasks back to the sweep, which queues the message
 * again once the session can take it. A message persisted for a dispatch that
 * never started a turn is removed with it, so the retry is not a second copy.
 */
async function releaseTaskWake(row: QueueRow, opts: { dropPersisted?: boolean } = {}): Promise<WakeRelease> {
  const { releaseTaskWakes } = await import('./background-tasks.service')
  const outcome = await releaseTaskWakes(taskWakeIds(row)).catch(() => ({ released: 0, capped: [] }))
  if (!opts.dropPersisted) return outcome
  const session = await (prisma as any).chatSession.findUnique({
    where: { id: row.sessionId },
    select: { activeTurnId: true },
  })
  if (!session?.activeTurnId) {
    await (prisma as any).chatMessage.deleteMany({ where: { id: row.id } }).catch(() => {})
  }
  return outcome
}

/**
 * A paused session's wake is held, not retried: `holdTaskWakes` parks the tasks
 * until the session's pause lifts (see `releaseLiftedPauseHolds`), so a session
 * nobody writes in keeps one row instead of one per five-minute attempt.
 */
async function holdPausedWake(row: QueueRow): Promise<void> {
  const { holdTaskWakes } = await import('./background-tasks.service')
  await holdTaskWakes(taskWakeIds(row)).catch(() => {})
}

/**
 * One failed row per wake, not one per attempt: a wake that keeps failing wrote
 * a copy of itself into the queue on every retry, and the row a person needs is
 * the latest one. The pause marker is left alone — that is the client's state.
 */
async function collapseFailedWakeRows(chatSessionId: string, keepId: string, taskIds: string[]): Promise<void> {
  const wanted = new Set(taskIds)
  if (!wanted.size) return
  const rows: Array<{ id: string; body: string | null }> = await (prisma as any).chatQueuedMessage
    .findMany({
      where: {
        sessionId: chatSessionId,
        kind: 'task_notification',
        status: 'failed',
        id: { not: keepId },
        NOT: { error: { in: WAKE_PAUSED_MARKERS } },
      },
      select: { id: true, body: true },
      take: 100,
    })
    .catch(() => [])
  const stale = rows.filter((row) => taskWakeIdsFromBody(row.body).some((id) => wanted.has(id))).map((row) => row.id)
  if (!stale.length) return
  await (prisma as any).chatQueuedMessage.deleteMany({ where: { id: { in: stale } } }).catch(() => {})
}

/** What starting one claimed row came to. */
export type QueueRowOutcome =
  | { started: true; rowId: string }
  | { started: false; rowId: string; error: string }

/**
 * Drop or hold a wake nobody should run now, and say why in a line a person can
 * read. Returns that reason.
 */
async function settleSkippedWake(row: QueueRow, skip: string): Promise<string> {
  if (skip === 'consumed') {
    await (prisma as any).chatQueuedMessage.delete({ where: { id: row.id } }).catch(() => {})
    return 'This update has already been delivered'
  }
  if (skip === WAKE_STALE) {
    // Seen-by-expiry: the sweep must not queue it again, and a live card watch
    // keeps listening for the next milestone (`consumeTasks` leaves it running).
    const { consumeTasks } = await import('./background-tasks.service')
    await consumeTasks(taskWakeIds(row)).catch(() => 0)
    await (prisma as any).chatQueuedMessage.delete({ where: { id: row.id } }).catch(() => {})
    console.log(`[ChatQueue] Dropped stale task wake ${row.id} for session ${row.sessionId}`)
    return 'This update is too old to start a turn for'
  }
  await (prisma as any).chatQueuedMessage.updateMany({
    where: { id: row.id, status: 'dispatching' },
    data: { status: 'failed', error: skip, body: pausedBody(row.body) },
  }).catch(() => {})
  await clearPausedWakeRows(row.sessionId, row.id)
  await holdPausedWake(row)
  return skip
}

/**
 * The oldest row of a session that may actually run: wakes whose tasks the
 * agent already saw (a turn started in between) are dropped, and a paused one
 * is held so it survives the pause without being retried while it lasts.
 */
async function claimNextDispatchableRow(chatSessionId: string): Promise<QueueRow | null> {
  let row = await claimNext(chatSessionId)
  while (row && row.kind === 'task_notification') {
    const skip = (await taskWakeSkipReason(row)) ?? ((await isStaleWake(row)) ? WAKE_STALE : null)
    if (!skip) break
    await settleSkippedWake(row, skip)
    row = await claimNext(chatSessionId)
  }
  return row
}

/**
 * Claim one named row — the one a person is acting on — instead of the head.
 * Conditional on it still being `pending`, so two clicks, or a click racing the
 * turn-end drain, still start it exactly once.
 */
async function claimRow(chatSessionId: string, rowId: string): Promise<QueueRow | null> {
  const candidate = await (prisma as any).chatQueuedMessage.findFirst({
    where: { id: rowId, sessionId: chatSessionId, status: 'pending' },
  })
  if (!candidate) return null
  const claimed = await (prisma as any).chatQueuedMessage.updateMany({
    where: { id: rowId, sessionId: chatSessionId, status: 'pending' },
    data: { status: 'dispatching', error: null },
  })
  if (claimed.count !== 1) return null
  return candidate as QueueRow
}

/**
 * Persist and start a row this process has claimed, and settle the row with the
 * outcome: deleted when its turn started, `failed` with the reason when it did
 * not. Returns that outcome, so the caller that has a person waiting on the
 * answer can say what happened instead of guessing.
 */
async function startClaimedRow(row: QueueRow): Promise<QueueRowOutcome> {
  try {
    const body = parseJson<QueueBody>(row.body, {})
    await persistQueuedUserMessage(row, body)
    await dispatchRow(row)
    // A wake that ran is consumed even when the reply saved no text: the note
    // was part of the turn that just started, and leaving it unconsumed lets the
    // next release queue it again for work the session has already been told
    // about (the repeat every sweep tick that reads as an empty-reply loop).
    if (row.kind === 'task_notification') {
      const { consumeTasks } = await import('./background-tasks.service')
      await consumeTasks(taskWakeIds(row)).catch(() => {})
    }
    await (prisma as any).chatQueuedMessage.delete({ where: { id: row.id } })
    // A wake landed (or a person's message went through): the pause is over.
    await clearPausedWakeRows(row.sessionId)
    return { started: true, rowId: row.id }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await (prisma as any).chatQueuedMessage.updateMany({
      where: { id: row.id, status: 'dispatching' },
      data: { status: 'failed', error: message.slice(0, 4_000) },
    }).catch(() => {})
    // A wake that never ran hands its tasks back: the drain sweep queues the
    // message again once the runtime answers, so the results are not lost — up
    // to `MAX_WAKE_ATTEMPTS`, where it stops and says so once.
    if (row.kind === 'task_notification') {
      const taskIds = taskWakeIds(row)
      const { capped } = await releaseTaskWake(row, { dropPersisted: true })
      await collapseFailedWakeRows(row.sessionId, row.id, taskIds)
      if (capped.length) {
        await (prisma as any).chatQueuedMessage.updateMany({
          where: { id: row.id, status: 'failed' },
          data: { error: `Could not deliver this update after ${MAX_WAKE_ATTEMPTS} attempts: ${message}`.slice(0, 4_000) },
        }).catch(() => {})
      }
    }
    // A resume nobody dropped is a promise the transcript already made: the note
    // above the row says the turn is picking itself back up. Dropping it where a
    // wake gets retried left that promise standing with nothing behind it, so it
    // is retried the same way — and at the cap the last note is replaced with the
    // one that says the turn is stopped.
    if (row.kind === 'resume') {
      const attempts = resumeAttempts(row.body) + 1
      if (attempts < MAX_WAKE_ATTEMPTS) {
        await (prisma as any).chatQueuedMessage.updateMany({
          where: { id: row.id, status: 'failed' },
          data: {
            status: 'pending',
            error: message.slice(0, 4_000),
            body: withResumeAttempts(row.body, attempts),
          },
        }).catch(() => {})
      } else {
        await (prisma as any).chatQueuedMessage.updateMany({
          where: { id: row.id, status: 'failed' },
          data: { error: `Could not resume this turn after ${MAX_WAKE_ATTEMPTS} attempts: ${message}`.slice(0, 4_000) },
        }).catch(() => {})
        const { postInterruptedResume } = await import('./chat-resume.service')
        await postInterruptedResume(row.sessionId, { resume: false, toolName: resumeToolName(row.parts) }).catch((err: any) =>
          console.warn(`[ChatQueue] Stopped-resume note for ${row.sessionId} failed:`, err?.message ?? err),
        )
      }
    }
    console.error(`[ChatQueue] Failed to dispatch ${row.id}:`, error)
    return { started: false, rowId: row.id, error: message }
  }
}

/**
 * Claim and start the oldest pending message for a session.
 *
 * The database claim is deliberately conditional. Multiple API instances may
 * observe the same idle session after a turn completes, but only one can move
 * a row from pending to dispatching. In multi-region mode only the session's
 * home region dispatches; peers return false and the home region's turn-end
 * hook or drain worker picks the replicated row up.
 */
export async function dispatchNext(chatSessionId: string): Promise<boolean> {
  if (!(await isHomeRegionSession(chatSessionId))) return false
  if (!(await isSessionIdle(chatSessionId))) return false
  const row = await claimNextDispatchableRow(chatSessionId)
  if (!row) return false
  return (await startClaimedRow(row)).started
}

/**
 * Start one named row now — the row a person pressed Send now on — and report
 * what happened to it.
 *
 * Not gated on `isSessionIdle`: the stop that preceded this call *is* the
 * preemption, and the runtime's `/agent/chat` waits on its live-turn gate while
 * the stopped turn unwinds. Waiting for the session to read idle instead is
 * what left the row promoted and unclaimed, with the only starter left being a
 * timer (SHO-198) or nothing at all (SHO-205).
 */
export async function dispatchQueuedRow(chatSessionId: string, rowId: string): Promise<QueueRowOutcome> {
  if (!(await isHomeRegionSession(chatSessionId))) {
    return { started: false, rowId, error: 'This chat is served from another region — try again there' }
  }
  const row = await claimRow(chatSessionId, rowId)
  if (row) {
    if (row.kind === 'task_notification') {
      const skip = await taskWakeSkipReason(row)
      if (skip) return { started: false, rowId, error: await settleSkippedWake(row, skip) }
    }
    return startClaimedRow(row)
  }
  // Somebody else has it: the turn-end drain, another click or another pod
  // claimed it between the click and here. That is the row starting, not the
  // row failing — the claim is what makes it one turn either way.
  const current = await (prisma as any).chatQueuedMessage.findUnique({
    where: { id: rowId },
    select: { status: true, error: true },
  })
  if (!current) return { started: true, rowId }
  if (current.status === 'dispatching') return { started: true, rowId }
  return { started: false, rowId, error: current.error ?? 'This message could not be started' }
}

export async function resetStuckDispatching(
  olderThan: Date = new Date(Date.now() - 2 * 60 * 1000),
): Promise<number> {
  const home = homeSessionWhere()
  const result = await (prisma as any).chatQueuedMessage.updateMany({
    where: {
      status: 'dispatching',
      updatedAt: { lt: olderThan },
      ...(home ? { session: home } : {}),
    },
    data: { status: 'pending', error: 'Recovered after an interrupted dispatch' },
  })
  return result.count
}

export async function dispatchPendingSessions(): Promise<number> {
  const home = homeSessionWhere()
  const rows: Array<{ sessionId: string }> = await (prisma as any).chatQueuedMessage.findMany({
    where: { status: 'pending', ...(home ? { session: home } : {}) },
    distinct: ['sessionId'],
    select: { sessionId: true },
  })
  const allowed = await cloudSessionIds(rows.map((row) => row.sessionId))
  const sessionIds = rows.map((row) => row.sessionId).filter((id) => allowed.has(id))
  if (!sessionIds.length) return 0
  // A session with a person's message waiting is never held back by the cap.
  const personRows: Array<{ sessionId: string }> = await (prisma as any).chatQueuedMessage.findMany({
    where: { status: 'pending', sessionId: { in: sessionIds }, NOT: { kind: 'task_notification' } },
    distinct: ['sessionId'],
    select: { sessionId: true },
  })
  const hasPerson = new Set(personRows.map((row) => row.sessionId))
  const sessions: Array<{ id: string; contextType: string | null; contextId: string | null; workspaceId: string | null }> =
    await (prisma as any).chatSession.findMany({
      where: { id: { in: sessionIds } },
      select: { id: true, contextType: true, contextId: true, workspaceId: true },
    })
  const agentOf = new Map(sessions.map((s) => [
    s.id,
    s.contextType === 'project' && s.contextId ? `project:${s.contextId}` : `workspace:${s.workspaceId ?? s.id}`,
  ]))
  const perAgent = new Map<string, number>()
  let wakes = 0
  let dispatched = 0
  for (const sessionId of sessionIds) {
    const person = hasPerson.has(sessionId)
    const agent = agentOf.get(sessionId) ?? sessionId
    if (!person && (wakes >= MAX_WAKES_PER_TICK || (perAgent.get(agent) ?? 0) >= MAX_WAKES_PER_AGENT_PER_TICK)) continue
    if (!(await dispatchNext(sessionId))) continue
    dispatched++
    if (!person) {
      wakes++
      perAgent.set(agent, (perAgent.get(agent) ?? 0) + 1)
    }
  }
  return dispatched
}
