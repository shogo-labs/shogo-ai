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
const SCHEDULE_BATCH_SIZE = 25
const SCHEDULE_STALE_AFTER_MS = 30 * 60_000

async function consumeResponse(response: Response): Promise<void> {
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    let message = body || `Scheduled agent request failed with HTTP ${response.status}`
    try {
      const payload = JSON.parse(body)
      message = payload?.error?.message || payload?.message || message
    } catch {
      // Keep the raw response when it is not JSON.
    }
    throw new Error(message)
  }
  if (!response.body) return
  const reader = response.body.getReader()
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
    }
  } finally {
    reader.releaseLock()
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

async function runAgentSchedule(scheduleId: string, runtimeManager?: RuntimeManager): Promise<void> {
  const schedule = await prisma.agentSchedule.findUnique({
    where: { id: scheduleId },
    include: { goal: { select: { title: true, status: true } } },
  })
  if (!schedule || !schedule.enabled || !schedule.runningAt) return

  try {
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
    const response = await router.fetch(
      new Request(`http://internal/workspaces/${encodeURIComponent(schedule.workspaceId)}/chat`, {
        method: 'POST',
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
    )
    await consumeResponse(response)

    const summary = await latestAssistantSummary(sessionId, startedAt)
    await prisma.agentSchedule.updateMany({
      where: { id: schedule.id, runningAt: schedule.runningAt },
      data: {
        lastRunStatus: 'ok',
        lastRunSummary: summary?.slice(0, 8_000) || 'The scheduled run completed.',
        lastError: null,
        runningAt: null,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await prisma.agentSchedule.updateMany({
      where: { id: schedule.id, runningAt: schedule.runningAt },
      data: {
        lastRunStatus: 'failed',
        lastRunSummary: null,
        lastError: message.slice(0, 2_000),
        runningAt: null,
      },
    }).catch((updateError) => {
      console.error(`[AgentSchedule] Failed to persist failure for ${schedule.id}:`, updateError)
    })
    console.error(`[AgentSchedule] ${schedule.id} failed:`, message)
  }
}

export async function dispatchDueSchedules(runtimeManager?: RuntimeManager): Promise<void> {
  const now = new Date()
  const staleBefore = new Date(now.getTime() - SCHEDULE_STALE_AFTER_MS)
  const homeFilter = homeRegionWorkspaceWhere()
  const workspaceFilter = homeFilter ? { workspace: homeFilter } : {}

  const due = await prisma.agentSchedule.findMany({
    where: {
      enabled: true,
      nextRunAt: { lte: now },
      OR: [{ runningAt: null }, { runningAt: { lt: staleBefore } }],
      ...workspaceFilter,
    },
    orderBy: [{ nextRunAt: 'asc' }, { createdAt: 'asc' }],
    take: SCHEDULE_BATCH_SIZE,
  })

  for (const schedule of due) {
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
          lastError: `Invalid stored schedule: ${message}`.slice(0, 2_000),
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
    if (claimed.count > 0) void runAgentSchedule(schedule.id, runtimeManager)
  }
}

let scheduleDispatcherTimer: ReturnType<typeof setInterval> | null = null

export async function runAgentScheduleDispatch(runtimeManager?: RuntimeManager): Promise<void> {
  await dispatchDueSchedules(runtimeManager)
}

export function startAgentScheduleWorker(runtimeManager?: RuntimeManager): () => void {
  if (scheduleDispatcherTimer) return stopAgentScheduleWorker

  const tick = () => {
    void runAgentScheduleDispatch(runtimeManager).catch((error) => {
      console.error('[AgentSchedule] Dispatcher tick failed:', error)
    })
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
