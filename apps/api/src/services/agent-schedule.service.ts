// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Cron } from 'croner'
import { prisma } from '../lib/prisma'

export const MAX_AGENT_SCHEDULES = 25
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
 * Validate a standard five-field cron expression and return its next two
 * occurrences. Keeping this in one place ensures the API and dispatcher use
 * the exact same timezone semantics.
 */
export function nextCronRuns(
  cronExpression: string,
  timezone: string,
  from = new Date(),
): Date[] {
  const expression = cronExpression.trim()
  if (expression.split(/\s+/).length !== 5) {
    throw new AgentScheduleError(
      'Cron expressions must use five fields: minute hour day-of-month month day-of-week',
      'invalid_cron',
    )
  }
  validateTimezone(timezone)

  let cron: Cron
  try {
    cron = new Cron(expression, { timezone })
  } catch (error) {
    throw new AgentScheduleError(
      error instanceof Error ? error.message : 'Invalid cron expression',
      'invalid_cron',
    )
  }

  const runs = cron.nextRuns(2, from)
  if (runs.length < 2) {
    throw new AgentScheduleError('Cron expression has no future occurrences', 'invalid_cron')
  }
  if (runs[1].getTime() - runs[0].getTime() < MIN_AGENT_SCHEDULE_INTERVAL_MS) {
    throw new AgentScheduleError(
      'Schedules must run no more often than every five minutes',
      'schedule_too_frequent',
    )
  }
  return runs
}

export function nextAgentScheduleRun(
  cronExpression: string,
  timezone: string,
  from = new Date(),
): Date {
  return nextCronRuns(cronExpression, timezone, from)[0]
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
  await assertGoal(input.workspaceId, input.goalId)
  if (input.enabled !== false) await assertScheduleCapacity(input.workspaceId)
  const nextRunAt = nextAgentScheduleRun(cronExpression, timezone)

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

  if (cadenceChanged || (enabled && !existing.enabled)) {
    nextCronRuns(cronExpression, timezone)
  }

  return prisma.agentSchedule.update({
    where: { id: scheduleId },
    data: {
      ...(changes.goalId !== undefined ? { goalId: changes.goalId } : {}),
      ...(changes.name !== undefined ? { name: changes.name.trim() } : {}),
      ...(changes.prompt !== undefined ? { prompt: changes.prompt.trim() } : {}),
      ...(changes.cronExpression !== undefined ? { cronExpression } : {}),
      ...(changes.timezone !== undefined ? { timezone } : {}),
      ...(changes.enabled !== undefined ? { enabled } : {}),
      ...(cadenceChanged || (enabled && !existing.enabled)
        ? { nextRunAt: nextAgentScheduleRun(cronExpression, timezone), runningAt: null }
        : {}),
    },
  })
}

export async function deleteSchedule(workspaceId: string, scheduleId: string): Promise<boolean> {
  const deleted = await prisma.agentSchedule.deleteMany({
    where: { id: scheduleId, workspaceId },
  })
  return deleted.count > 0
}
