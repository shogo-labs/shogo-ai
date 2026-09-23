// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { prisma } from '../lib/prisma'

export const GOAL_STATUSES = ['active', 'paused', 'done'] as const
export const GOAL_EVENT_KINDS = ['progress', 'blocker', 'approval', 'note', 'deliverable'] as const

export type GoalStatus = (typeof GOAL_STATUSES)[number]
export type GoalEventKind = (typeof GOAL_EVENT_KINDS)[number]

export function isGoalStatus(value: unknown): value is GoalStatus {
  return typeof value === 'string' && (GOAL_STATUSES as readonly string[]).includes(value)
}

export function isGoalEventKind(value: unknown): value is GoalEventKind {
  return typeof value === 'string' && (GOAL_EVENT_KINDS as readonly string[]).includes(value)
}

export async function getOrCreateAgentProfile(workspaceId: string) {
  return prisma.workspaceAgentProfile.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      name: 'Shogo',
      tagline: 'Your personal AI companion',
    },
    update: {},
  })
}

export async function updateAgentProfile(
  workspaceId: string,
  changes: {
    name?: string
    avatarUrl?: string | null
    tagline?: string | null
    personality?: string | null
    statusText?: string | null
  },
) {
  const data = {
    ...changes,
    ...(changes.statusText !== undefined ? { statusUpdatedAt: new Date() } : {}),
  }

  return prisma.workspaceAgentProfile.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      name: changes.name ?? 'Shogo',
      tagline: changes.tagline ?? 'Your personal AI companion',
      avatarUrl: changes.avatarUrl,
      personality: changes.personality,
      statusText: changes.statusText,
      ...(changes.statusText !== undefined ? { statusUpdatedAt: new Date() } : {}),
    },
    update: data,
  })
}

/**
 * Store an uploaded agent-avatar image for local mode. Cloud mode injects the
 * S3-backed implementation at the route boundary so the local API never
 * evaluates the AWS SDK.
 */
export async function saveAgentAvatar(workspaceId: string, imageBuffer: Buffer): Promise<string> {
  void workspaceId
  return `data:image/png;base64,${imageBuffer.toString('base64')}`
}

export async function listGoals(workspaceId: string, status?: GoalStatus) {
  return prisma.goal.findMany({
    where: { workspaceId, ...(status ? { status } : {}) },
    include: {
      schedules: {
        orderBy: [{ enabled: 'desc' }, { nextRunAt: 'asc' }],
      },
    },
    orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
  })
}

export async function getGoal(workspaceId: string, goalId: string) {
  return prisma.goal.findFirst({
    where: { id: goalId, workspaceId },
    include: {
      events: { orderBy: { createdAt: 'desc' } },
      agentTasks: { orderBy: { updatedAt: 'desc' } },
      schedules: {
        orderBy: [{ enabled: 'desc' }, { nextRunAt: 'asc' }],
      },
    },
  })
}

export async function createGoal(
  workspaceId: string,
  input: {
    title: string
    why?: string | null
    status?: GoalStatus
    plan?: unknown
    deliverables?: unknown
    nextCheckInAt?: Date | null
  },
) {
  return prisma.goal.create({
    data: {
      workspaceId,
      title: input.title,
      why: input.why ?? undefined,
      status: input.status ?? 'active',
      plan: (input.plan ?? []) as any,
      deliverables: (input.deliverables ?? []) as any,
      nextCheckInAt: input.nextCheckInAt ?? undefined,
    },
  })
}

export async function updateGoal(
  workspaceId: string,
  goalId: string,
  changes: {
    title?: string
    why?: string | null
    status?: GoalStatus
    plan?: unknown
    deliverables?: unknown
    nextCheckInAt?: Date | null
    lastProgressAt?: Date | null
  },
) {
  const existing = await prisma.goal.findFirst({
    where: { id: goalId, workspaceId },
    select: { id: true },
  })
  if (!existing) return null

  const goal = await prisma.goal.update({
    where: { id: goalId },
    data: {
      ...changes,
      plan: changes.plan === undefined ? undefined : (changes.plan as any),
      deliverables: changes.deliverables === undefined ? undefined : (changes.deliverables as any),
    },
  })
  if (changes.status === 'done') {
    await prisma.agentSchedule.updateMany({
      where: { goalId, enabled: true },
      data: { enabled: false, lastError: 'Disabled because the goal was marked done.' },
    })
  }
  return goal
}

export async function listGoalEvents(workspaceId: string, goalId: string) {
  return prisma.goalEvent.findMany({
    where: { goalId, goal: { workspaceId } },
    orderBy: { createdAt: 'desc' },
  })
}

export async function createGoalEvent(
  workspaceId: string,
  goalId: string,
  input: {
    kind: GoalEventKind
    message: string
    metadata?: unknown
  },
) {
  const goal = await prisma.goal.findFirst({
    where: { id: goalId, workspaceId },
    select: { id: true },
  })
  if (!goal) return null

  const now = new Date()
  const event = await prisma.goalEvent.create({
    data: {
      goalId,
      kind: input.kind,
      message: input.message,
      metadata: input.metadata === undefined ? undefined : (input.metadata as any),
    },
  })

  if (input.kind === 'progress' || input.kind === 'deliverable') {
    await prisma.goal.update({
      where: { id: goalId },
      data: { lastProgressAt: now },
    })
  }

  return event
}

export type GoalApprovalDecision = 'approved' | 'declined'

/**
 * Mark an `approval`-kind goal event as resolved by stamping
 * `metadata.resolvedAt`/`metadata.decision`. There is deliberately no
 * separate "resolved" column on `GoalEvent` — events are an append-only
 * log, and `metadata` already exists for exactly this kind of event-
 * specific detail. `isApprovalPending` (below) is the read-side match:
 * an approval event with no `metadata.resolvedAt` is still open.
 *
 * Returns null when the event doesn't exist, isn't scoped to this
 * workspace/goal, or isn't an `approval` event (resolving a non-approval
 * event is a no-op by design — there's nothing to approve).
 */
export async function resolveGoalEventApproval(
  workspaceId: string,
  goalId: string,
  eventId: string,
  decision: GoalApprovalDecision,
) {
  const event = await prisma.goalEvent.findFirst({
    where: { id: eventId, goalId, goal: { workspaceId } },
  })
  if (!event || event.kind !== 'approval') return null

  const existingMetadata =
    event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
      ? (event.metadata as Record<string, unknown>)
      : {}

  return prisma.goalEvent.update({
    where: { id: eventId },
    data: {
      metadata: {
        ...existingMetadata,
        decision,
        resolvedAt: new Date().toISOString(),
      } as any,
    },
  })
}

/** An `approval` event with no recorded decision yet — surfaced as "Needs your OK". */
export function isApprovalPending(event: { kind: string; metadata?: unknown }): boolean {
  if (event.kind !== 'approval') return false
  const metadata =
    event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
      ? (event.metadata as Record<string, unknown>)
      : null
  return !metadata?.resolvedAt
}

export async function listWorkspaceActivity(workspaceId: string, limit = 100) {
  const [events, tasks] = await Promise.all([
    prisma.goalEvent.findMany({
      where: { goal: { workspaceId } },
      include: { goal: { select: { id: true, title: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    prisma.agentTask.findMany({
      where: { workspaceId },
      select: {
        id: true,
        goalId: true,
        title: true,
        status: true,
        currentStep: true,
        resultSummary: true,
        errorMessage: true,
        createdAt: true,
        updatedAt: true,
        completedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    }),
  ])

  return [
    ...events.map((event) => ({
      type: 'goal_event' as const,
      id: event.id,
      goalId: event.goalId,
      goalTitle: event.goal.title,
      kind: event.kind,
      message: event.message,
      metadata: event.metadata,
      createdAt: event.createdAt,
    })),
    ...tasks.map((task) => ({
      type: 'agent_task' as const,
      id: task.id,
      goalId: task.goalId,
      title: task.title,
      status: task.status,
      currentStep: task.currentStep,
      resultSummary: task.resultSummary,
      errorMessage: task.errorMessage,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      completedAt: task.completedAt,
    })),
  ]
    .sort((a, b) => {
      const aTime = a.type === 'goal_event' ? a.createdAt : a.updatedAt
      const bTime = b.type === 'goal_event' ? b.createdAt : b.updatedAt
      return bTime.getTime() - aTime.getTime()
    })
    .slice(0, limit)
}
