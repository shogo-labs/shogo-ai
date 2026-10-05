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
import { nextAgentScheduleRun } from '../services/agent-schedule.service'
import {
  AgentTurnError,
  ensureWorkspaceChatSession,
  latestAssistantSummary,
  executeWorkspaceAgentTurn,
  startLease,
  type RuntimeManager,
} from './agent-turn-runner'

export { finalAnswerOf } from './agent-turn-runner'

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

const ScheduleRunError = AgentTurnError

function startScheduleLease(scheduleId: string, runningAt: Date, onLost: () => void) {
  return startLease(
    runningAt,
    async (current, next) => {
      const renewed = await prisma.agentSchedule.updateMany({
        where: { id: scheduleId, runningAt: current },
        data: { runningAt: next },
      })
      return renewed.count > 0
    },
    onLost,
    SCHEDULE_HEARTBEAT_INTERVAL_MS,
    `schedule ${scheduleId}`,
  )
}

function ensureScheduleChatSession(schedule: {
  id: string
  workspaceId: string
  name: string
  chatSessionId: string | null
}): Promise<string> {
  return ensureWorkspaceChatSession({
    workspaceId: schedule.workspaceId,
    existingSessionId: schedule.chatSessionId,
    name: `Schedule: ${schedule.name}`,
    persist: (sessionId) => prisma.agentSchedule.update({ where: { id: schedule.id }, data: { chatSessionId: sessionId } }),
  })
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
  let sessionId: string | null = null
  try {
    sessionId = await ensureScheduleChatSession(schedule)
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

    const turn = await executeWorkspaceAgentTurn({
      runtimeManager,
      workspaceId: schedule.workspaceId,
      userId: schedule.userId,
      sessionId,
      prompt,
      clientTurnId: `agent-schedule-${schedule.id}-${crypto.randomUUID()}`,
      signal: controller.signal,
      label: 'Scheduled agent',
    })
    if (turn.loopPattern) {
      throw new ScheduleRunError(
        `The run was stopped early by the loop detector and may be incomplete: ${turn.loopPattern}`,
        'failed',
      )
    }

    // A schedule that reports into a channel posts one clean message, not its running commentary.
    const summary = await latestAssistantSummary(sessionId, startedAt, !!schedule.notifyConversationId)
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
  const runKey = schedule.runningAt.toISOString()
  void import('../services/conversation-activity').then((m) => m.recordScheduleOutcome(
    { ...schedule, chatSessionId: sessionId },
    {
      status: String(outcome.lastRunStatus),
      summary: outcome.lastRunSummary as string | null | undefined,
      error: outcome.lastError as string | null | undefined,
      runKey,
    },
  )).catch(() => {})
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
