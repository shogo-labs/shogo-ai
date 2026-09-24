// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Database-backed dispatcher for agent-owned recurring schedules.
 *
 * Schedules are workspace-owned, so every API region may run this worker but
 * only the workspace home region claims a given row. The claim advances the
 * next occurrence before the runtime turn starts, making a missed tick
 * fire-once and safe across API replicas.
 */

import { prisma } from '../lib/prisma'
import { homeRegionWorkspaceWhere } from '../lib/region'
import { workspaceChatRoutes } from '../routes/workspace-chat'
import { nextAgentScheduleRun } from '../services/agent-schedule.service'

type RuntimeManager = Parameters<typeof workspaceChatRoutes>[0]['runtimeManager']

const SCHEDULE_DISPATCH_INTERVAL_MS = 30_000
const SCHEDULE_DISPATCH_JITTER_MS = 5_000
const SCHEDULE_BATCH_SIZE = 25
/** A live run refreshes runningAt this often; see `startScheduleLease`. */
const SCHEDULE_HEARTBEAT_INTERVAL_MS = 60_000
/** Several missed heartbeats means the owning API process died. */
const SCHEDULE_STALE_AFTER_MS = 5 * 60_000
/** Must stay below CHAT_UPSTREAM_FETCH_TIMEOUT_MS (4h by default). */
const SCHEDULE_MAX_RUN_MS = 2 * 60 * 60_000
const MAX_CONSECUTIVE_SCHEDULE_FAILURES = 5
const MAX_CONCURRENT_SCHEDULE_RUNS = 10

const inFlightRuns = new Set<Promise<void>>()

class ScheduleRunError extends Error {
  constructor(
    message: string,
    public readonly kind: 'failed' | 'forbidden' | 'timed_out',
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'ScheduleRunError'
  }
}

function abortError(signal: AbortSignal): ScheduleRunError {
  return signal.reason instanceof ScheduleRunError
    ? signal.reason
    : new ScheduleRunError('The scheduled run was aborted', 'failed')
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

type TurnOutcome = { loopPattern: string | null }

/** Reads the runtime's `data-usage` frame, which reports a loop-detector abort. */
function readUsageFrame(line: string, outcome: TurnOutcome): void {
  if (!line.startsWith('data:')) return
  const payload = line.slice(5).trim()
  if (!payload.includes('"data-usage"')) return
  try {
    const frame = JSON.parse(payload)
    if (frame?.type === 'data-usage' && frame.data?.loopDetected === true) {
      outcome.loopPattern = typeof frame.data.loopPattern === 'string'
        ? frame.data.loopPattern
        : 'repeated tool calls without progress'
    }
  } catch {
    // Ignore frames that are not JSON.
  }
}

async function consumeResponse(response: Response, signal: AbortSignal): Promise<TurnOutcome> {
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    let message = body || `Scheduled agent request failed with HTTP ${response.status}`
    try {
      const payload = JSON.parse(body)
      message = payload?.error?.message || payload?.message || message
    } catch {
      // Keep the raw response when it is not JSON.
    }
    const forbidden = response.status === 401 || response.status === 403
    throw new ScheduleRunError(message, forbidden ? 'forbidden' : 'failed', response.status)
  }
  const outcome: TurnOutcome = { loopPattern: null }
  if (!response.body) return outcome
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  const cancel = () => void reader.cancel(signal.reason).catch(() => {})
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      const next = await untilAborted(reader.read(), signal)
      if (next.done) break
      buffered += decoder.decode(next.value, { stream: true })
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) readUsageFrame(line, outcome)
    }
    buffered += decoder.decode()
    if (buffered) readUsageFrame(buffered, outcome)
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
  return outcome
}

/**
 * Hold the claim on a schedule while its run is in flight. `runningAt` is
 * the lease token: every heartbeat swaps it for a fresh timestamp only if it
 * still matches the value this run holds, so a reclaimed or deleted schedule
 * is detected instead of overwritten. `release` returns the current token for
 * the final conditional write.
 */
function startScheduleLease(scheduleId: string, runningAt: Date, onLost: () => void) {
  let current = runningAt
  let lost = false
  let pending: Promise<void> = Promise.resolve()
  const timer = setInterval(() => {
    pending = pending
      .then(async () => {
        if (lost) return
        const next = new Date()
        const renewed = await prisma.agentSchedule.updateMany({
          where: { id: scheduleId, runningAt: current },
          data: { runningAt: next },
        })
        if (renewed.count > 0) {
          current = next
        } else {
          lost = true
          onLost()
        }
      })
      .catch((error) => {
        console.error(`[AgentSchedule] Failed to heartbeat ${scheduleId}:`, error)
      })
  }, SCHEDULE_HEARTBEAT_INTERVAL_MS)
  ;(timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.()

  return {
    get lost() {
      return lost
    },
    async release(): Promise<Date> {
      clearInterval(timer)
      await pending
      return current
    },
  }
}

async function ensureScheduleChatSession(schedule: {
  id: string
  workspaceId: string
  name: string
  chatSessionId: string | null
}): Promise<string> {
  if (schedule.chatSessionId) {
    const existing = await prisma.chatSession.findUnique({
      where: { id: schedule.chatSessionId },
      select: { contextType: true, workspaceId: true },
    })
    if (existing?.contextType === 'workspace' && existing.workspaceId === schedule.workspaceId) {
      return schedule.chatSessionId
    }
  }

  const session = await prisma.chatSession.create({
    data: {
      inferredName: `Schedule: ${schedule.name}`.slice(0, 120),
      contextType: 'workspace',
      workspaceId: schedule.workspaceId,
    },
    select: { id: true },
  })
  await prisma.agentSchedule.update({
    where: { id: schedule.id },
    data: { chatSessionId: session.id },
  })
  return session.id
}

async function latestAssistantSummary(sessionId: string, after: Date): Promise<string | null> {
  const message = await prisma.chatMessage.findFirst({
    where: {
      sessionId,
      role: 'assistant',
      createdAt: { gt: after },
    },
    orderBy: { createdAt: 'desc' },
    select: { content: true },
  })
  return message?.content?.trim() || null
}

function failureUpdate(
  schedule: { consecutiveFailures: number },
  error: unknown,
): Record<string, unknown> {
  const runError =
    error instanceof ScheduleRunError
      ? error
      : new ScheduleRunError(error instanceof Error ? error.message : String(error), 'failed')
  const failures = schedule.consecutiveFailures + 1
  const base = {
    lastRunStatus: runError.kind === 'timed_out' ? 'timed_out' : 'failed',
    lastRunSummary: null,
    consecutiveFailures: failures,
    runningAt: null,
  }
  if (runError.kind === 'forbidden') {
    return {
      ...base,
      enabled: false,
      lastError: `Disabled: the schedule's creator can no longer run it in this workspace (HTTP ${runError.status}). ${runError.message}`.slice(0, 2_000),
    }
  }
  if (failures >= MAX_CONSECUTIVE_SCHEDULE_FAILURES) {
    return {
      ...base,
      enabled: false,
      lastError: `Disabled after ${failures} consecutive failed runs. Last error: ${runError.message}`.slice(0, 2_000),
    }
  }
  return { ...base, lastError: runError.message.slice(0, 2_000) }
}

async function runAgentSchedule(scheduleId: string, runtimeManager?: RuntimeManager): Promise<void> {
  const schedule = await prisma.agentSchedule.findUnique({
    where: { id: scheduleId },
    include: { goal: { select: { title: true, status: true } } },
  })
  if (!schedule || !schedule.enabled || !schedule.runningAt) return

  if (schedule.goal && schedule.goal.status !== 'active') {
    await prisma.agentSchedule.updateMany({
      where: { id: schedule.id, runningAt: schedule.runningAt },
      data: {
        lastRunStatus: 'skipped',
        lastRunSummary: `Skipped because goal "${schedule.goal.title}" is ${schedule.goal.status}.`,
        lastError: null,
        runningAt: null,
      },
    })
    return
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort(new ScheduleRunError(
      `Timed out after ${Math.round(SCHEDULE_MAX_RUN_MS / 60_000)} minutes`,
      'timed_out',
    ))
  }, SCHEDULE_MAX_RUN_MS)
  ;(timeout as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()
  const lease = startScheduleLease(schedule.id, schedule.runningAt, () => {
    controller.abort(new ScheduleRunError('The schedule was reclaimed or deleted during the run', 'failed'))
  })

  let outcome: Record<string, unknown>
  try {
    const sessionId = await ensureScheduleChatSession(schedule)
    const startedAt = new Date()
    const goalInstruction = schedule.goal
      ? `This schedule is attached to the goal "${schedule.goal.title}" (${schedule.goal.status}). Record meaningful progress or blockers with goal_log for goal ${schedule.goalId}.`
      : 'If this run advances a tracked goal, record the result with goal_log.'
    const prompt = [
      `Run the recurring schedule "${schedule.name}".`,
      `Schedule: ${schedule.cronExpression} (${schedule.timezone})`,
      '',
      schedule.prompt,
      '',
      goalInstruction,
      'Return a concise summary of what you checked or changed.',
    ].join('\n')

    const router = workspaceChatRoutes({
      runtimeManager,
      alwaysEnabled: true,
      resolveUserId: async (c) => c.req.header('X-Schedule-User-Id') || null,
    })
    const response = await untilAborted(Promise.resolve(router.fetch(
      new Request(`http://internal/workspaces/${encodeURIComponent(schedule.workspaceId)}/chat`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Schedule-User-Id': schedule.userId,
          'X-Billing-User-Id': schedule.userId,
          'X-Chat-Session-Id': sessionId,
        },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: prompt }] }],
          chatSessionId: sessionId,
          userId: schedule.userId,
          agentMode: 'auto',
          interactionMode: 'agent',
          clientTurnId: `agent-schedule-${schedule.id}-${crypto.randomUUID()}`,
        }),
      }),
    )), controller.signal)
    const turn = await consumeResponse(response, controller.signal)
    if (turn.loopPattern) {
      throw new ScheduleRunError(
        `The run was stopped early by the loop detector and may be incomplete: ${turn.loopPattern}`,
        'failed',
      )
    }

    const summary = await latestAssistantSummary(sessionId, startedAt)
    outcome = {
      lastRunStatus: 'ok',
      lastRunSummary: summary?.slice(0, 8_000) || 'The scheduled run completed.',
      lastError: null,
      consecutiveFailures: 0,
      runningAt: null,
    }
  } catch (error) {
    outcome = failureUpdate(schedule, error)
    console.error(`[AgentSchedule] ${schedule.id} ${outcome.lastRunStatus}:`, {
      workspaceId: schedule.workspaceId,
      consecutiveFailures: outcome.consecutiveFailures,
      disabled: outcome.enabled === false,
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    clearTimeout(timeout)
  }

  const runningAt = await lease.release()
  if (lease.lost) return
  await prisma.agentSchedule.updateMany({
    where: { id: schedule.id, runningAt },
    data: outcome,
  }).catch((updateError) => {
    console.error(`[AgentSchedule] Failed to persist run result for ${schedule.id}:`, updateError)
  })
}

function trackRun(run: Promise<void>): void {
  const tracked = run
    .catch((error) => {
      console.error('[AgentSchedule] Run crashed:', error)
    })
    .finally(() => {
      inFlightRuns.delete(tracked)
    })
  inFlightRuns.add(tracked)
}

/** Resolves once every run started by this process has finished. */
export async function waitForAgentScheduleRuns(): Promise<void> {
  while (inFlightRuns.size > 0) await Promise.all([...inFlightRuns])
}

export async function dispatchDueSchedules(runtimeManager?: RuntimeManager): Promise<void> {
  const now = new Date()
  const staleBefore = new Date(now.getTime() - SCHEDULE_STALE_AFTER_MS)
  const homeFilter = homeRegionWorkspaceWhere()
  const workspaceFilter = homeFilter ? { workspace: homeFilter } : {}

  const capacity = MAX_CONCURRENT_SCHEDULE_RUNS - inFlightRuns.size
  if (capacity <= 0) return

  const due = await prisma.agentSchedule.findMany({
    where: {
      enabled: true,
      nextRunAt: { lte: now },
      AND: [
        { OR: [{ runningAt: null }, { runningAt: { lt: staleBefore } }] },
        { OR: [{ goalId: null }, { goal: { status: 'active' } }] },
      ],
      ...workspaceFilter,
    },
    orderBy: [{ nextRunAt: 'asc' }, { createdAt: 'asc' }],
    take: Math.min(SCHEDULE_BATCH_SIZE, capacity),
  })

  for (const schedule of due) {
    if (inFlightRuns.size >= MAX_CONCURRENT_SCHEDULE_RUNS) break
    let nextRunAt: Date
    try {
      nextRunAt = nextAgentScheduleRun(schedule.cronExpression, schedule.timezone, now)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await prisma.agentSchedule.updateMany({
        where: { id: schedule.id, nextRunAt: schedule.nextRunAt },
        data: {
          enabled: false,
          lastRunStatus: 'failed',
          lastError: `Disabled: the stored cron expression or timezone is invalid. ${message}`.slice(0, 2_000),
          runningAt: null,
        },
      })
      continue
    }

    const claimed = await prisma.agentSchedule.updateMany({
      where: {
        id: schedule.id,
        enabled: true,
        nextRunAt: schedule.nextRunAt,
        OR: [{ runningAt: null }, { runningAt: { lt: staleBefore } }],
      },
      data: {
        nextRunAt,
        lastRunAt: now,
        lastRunStatus: 'running',
        lastError: null,
        runningAt: now,
      },
    })
    if (claimed.count > 0) trackRun(runAgentSchedule(schedule.id, runtimeManager))
  }
}

let scheduleDispatcherTimer: ReturnType<typeof setInterval> | null = null

export async function runAgentScheduleDispatch(runtimeManager?: RuntimeManager): Promise<void> {
  await dispatchDueSchedules(runtimeManager)
}

export function startAgentScheduleWorker(runtimeManager?: RuntimeManager): () => void {
  if (scheduleDispatcherTimer) return stopAgentScheduleWorker

  // Jitter each tick so replicas started together don't race every claim.
  const tick = () => {
    const jitter = setTimeout(() => {
      void runAgentScheduleDispatch(runtimeManager).catch((error) => {
        console.error('[AgentSchedule] Dispatcher tick failed:', error)
      })
    }, Math.random() * SCHEDULE_DISPATCH_JITTER_MS)
    ;(jitter as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()
  }
  tick()
  scheduleDispatcherTimer = setInterval(tick, SCHEDULE_DISPATCH_INTERVAL_MS)
  ;(scheduleDispatcherTimer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.()
  return stopAgentScheduleWorker
}

export function stopAgentScheduleWorker(): void {
  if (scheduleDispatcherTimer) clearInterval(scheduleDispatcherTimer)
  scheduleDispatcherTimer = null
}
