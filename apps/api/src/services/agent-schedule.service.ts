// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Cron } from 'croner'
import { prisma } from '../lib/prisma'

export const MAX_AGENT_SCHEDULES = 25
export const MAX_TOTAL_AGENT_SCHEDULES = 100
export const MIN_AGENT_SCHEDULE_INTERVAL_MS = 5 * 60 * 1000

export type AgentScheduleInput = {
  workspaceId: string
  userId: string
  goalId?: string | null
  name: string
  prompt: string
  cronExpression: string
  timezone?: string
  enabled?: boolean
}

export type AgentScheduleChanges = {
  goalId?: string | null
  name?: string
  prompt?: string
  cronExpression?: string
  timezone?: string
  enabled?: boolean
}

export class AgentScheduleError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'invalid_cron'
      | 'invalid_timezone'
      | 'schedule_too_frequent'
      | 'schedule_limit_reached'
      | 'goal_not_found',
    public readonly status: 400 | 409 | 404 = 400,
  ) {
    super(message)
    this.name = 'AgentScheduleError'
  }
}

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
  } catch {
    throw new AgentScheduleError(`Unknown timezone: ${timezone}`, 'invalid_timezone')
  }
}

/**
 * Occurrences inspected when enforcing the minimum interval. Cron gaps come
 * from the minute/hour lists and the day-of-month/day-of-week boundaries, so
 * a few hundred occurrences cover every distinct gap of a practical schedule
 * regardless of when validation happens to run.
 */
const MIN_INTERVAL_CHECK_RUNS = 200

function parseAgentCron(cronExpression: string, timezone: string): Cron {
  const expression = cronExpression.trim()
  if (expression.split(/\s+/).length !== 5) {
    throw new AgentScheduleError(
      'Cron expressions must use five fields: minute hour day-of-month month day-of-week',
      'invalid_cron',
    )
  }
  validateTimezone(timezone)

  try {
    return new Cron(expression, { timezone })
  } catch (error) {
    throw new AgentScheduleError(
      error instanceof Error ? error.message : 'Invalid cron expression',
      'invalid_cron',
    )
  }
}

/**
 * Parse a standard five-field cron expression and return its next
 * occurrences. Keeping this in one place ensures the API and dispatcher use
 * the exact same timezone semantics.
 */
export function nextCronRuns(
  cronExpression: string,
  timezone: string,
  from = new Date(),
  count = 2,
): Date[] {
  const runs = parseAgentCron(cronExpression, timezone).nextRuns(count, from)
  if (runs.length === 0) {
    throw new AgentScheduleError('Cron expression has no future occurrences', 'invalid_cron')
  }
  return runs
}

/**
 * Next occurrence of an already-accepted schedule. Only an unparseable
 * expression or timezone is an error here; cadence limits are enforced when
 * the schedule is created or changed (see `validateAgentSchedule`).
 */
export function nextAgentScheduleRun(
  cronExpression: string,
  timezone: string,
  from = new Date(),
): Date {
  return nextCronRuns(cronExpression, timezone, from, 1)[0]
}

/**
 * Validate a schedule for create/update, including the minimum interval
 * between any two consecutive occurrences, and return its next run.
 */
export function validateAgentSchedule(
  cronExpression: string,
  timezone: string,
  from = new Date(),
): Date {
  const cron = parseAgentCron(cronExpression, timezone)
  const first = cron.nextRun(from)
  if (!first) {
    throw new AgentScheduleError('Cron expression has no future occurrences', 'invalid_cron')
  }
  let previous = first
  for (let i = 1; i < MIN_INTERVAL_CHECK_RUNS; i++) {
    const next = cron.nextRun(previous)
    if (!next) break
    if (next.getTime() - previous.getTime() < MIN_AGENT_SCHEDULE_INTERVAL_MS) {
      throw new AgentScheduleError(
        'Schedules must run no more often than every five minutes',
        'schedule_too_frequent',
      )
    }
    previous = next
  }
  return first
}

export function describeAgentSchedule(cronExpression: string, timezone: string): string {
  return `${cronExpression.trim()} (${timezone})`
}

async function assertGoal(
  workspaceId: string,
  goalId: string | null | undefined,
): Promise<void> {
  if (!goalId) return
  const goal = await prisma.goal.findFirst({
    where: { id: goalId, workspaceId },
    select: { id: true },
  })
  if (!goal) {
    throw new AgentScheduleError('Goal not found in this workspace', 'goal_not_found', 404)
  }
}

async function assertTotalScheduleCapacity(workspaceId: string): Promise<void> {
  const total = await prisma.agentSchedule.count({ where: { workspaceId } })
  if (total >= MAX_TOTAL_AGENT_SCHEDULES) {
    throw new AgentScheduleError(
      `A workspace can have at most ${MAX_TOTAL_AGENT_SCHEDULES} schedules, including disabled ones`,
      'schedule_limit_reached',
      409,
    )
  }
}

async function assertScheduleCapacity(
  workspaceId: string,
  scheduleId?: string,
): Promise<void> {
  const enabledCount = await prisma.agentSchedule.count({
    where: {
      workspaceId,
      enabled: true,
      ...(scheduleId ? { NOT: { id: scheduleId } } : {}),
    },
  })
  if (enabledCount >= MAX_AGENT_SCHEDULES) {
    throw new AgentScheduleError(
      `A workspace can have at most ${MAX_AGENT_SCHEDULES} enabled schedules`,
      'schedule_limit_reached',
      409,
    )
  }
}

export async function listSchedules(workspaceId: string, goalId?: string) {
  return prisma.agentSchedule.findMany({
    where: { workspaceId, ...(goalId ? { goalId } : {}) },
    orderBy: [{ enabled: 'desc' }, { nextRunAt: 'asc' }, { createdAt: 'asc' }],
  })
}

export async function getSchedule(workspaceId: string, scheduleId: string) {
  return prisma.agentSchedule.findFirst({
    where: { id: scheduleId, workspaceId },
  })
}

export async function createSchedule(input: AgentScheduleInput) {
  const timezone = input.timezone?.trim() || 'UTC'
  const cronExpression = input.cronExpression.trim()
  const nextRunAt = validateAgentSchedule(cronExpression, timezone)
  await assertGoal(input.workspaceId, input.goalId)
  await assertTotalScheduleCapacity(input.workspaceId)
  if (input.enabled !== false) await assertScheduleCapacity(input.workspaceId)

  return prisma.agentSchedule.create({
    data: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      goalId: input.goalId ?? null,
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      cronExpression,
      timezone,
      enabled: input.enabled !== false,
      nextRunAt,
    },
  })
}

export async function updateSchedule(
  workspaceId: string,
  scheduleId: string,
  changes: AgentScheduleChanges,
) {
  const existing = await getSchedule(workspaceId, scheduleId)
  if (!existing) return null

  await assertGoal(workspaceId, changes.goalId)
  if (changes.enabled === true && !existing.enabled) {
    await assertScheduleCapacity(workspaceId, scheduleId)
  }

  const cronExpression = changes.cronExpression?.trim() || existing.cronExpression
  const timezone = changes.timezone?.trim() || existing.timezone
  const cadenceChanged =
    changes.cronExpression !== undefined || changes.timezone !== undefined
  const enabled = changes.enabled ?? existing.enabled
  const reenabled = enabled && !existing.enabled
  const nextRunAt =
    cadenceChanged || reenabled ? validateAgentSchedule(cronExpression, timezone) : null

  return prisma.agentSchedule.update({
    where: { id: scheduleId },
    data: {
      ...(changes.goalId !== undefined ? { goalId: changes.goalId } : {}),
      ...(changes.name !== undefined ? { name: changes.name.trim() } : {}),
      ...(changes.prompt !== undefined ? { prompt: changes.prompt.trim() } : {}),
      ...(changes.cronExpression !== undefined ? { cronExpression } : {}),
      ...(changes.timezone !== undefined ? { timezone } : {}),
      ...(changes.enabled !== undefined ? { enabled } : {}),
      // runningAt is the in-flight run's lease; leave it for that run to
      // release so a re-enable or cadence edit cannot start a duplicate.
      ...(nextRunAt ? { nextRunAt } : {}),
      ...(reenabled ? { consecutiveFailures: 0 } : {}),
    },
  })
}

export async function deleteSchedule(workspaceId: string, scheduleId: string): Promise<boolean> {
  const deleted = await prisma.agentSchedule.deleteMany({
    where: { id: scheduleId, workspaceId },
  })
  return deleted.count > 0
}
