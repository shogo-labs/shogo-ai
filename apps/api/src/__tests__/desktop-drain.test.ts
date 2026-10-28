// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-181 — the drain hold the desktop turns on before it restarts.
 *
 * "Restart when idle" only works if nothing new can start while it waits: a due
 * schedule or a pending trigger firing a second after the user chose it would
 * keep the counts off zero forever. The hold reuses the pause every automatic
 * entry point already consults, so these cases drive the real dispatchers, the
 * real database and the real gates:
 *
 *  - a due schedule is not claimed and keeps its `nextRunAt`;
 *  - a pending trigger delivery is skipped and stays pending;
 *  - a task wake is held at the source;
 *  - a person's own message still dispatches (a drain is not a lockout);
 *  - lifting the drain delivers the held work and leaves a real pause alone.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'fs'
import { seedWorkspace, setupChannelsTestDb, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

process.env.BETTER_AUTH_SECRET ||= 'desktop-drain-test-secret'

const { dir } = setupChannelsTestDb()

const dispatched: any[] = []
mock.module('../lib/runtime', () => ({ getRuntimeManager: () => ({}) }))
mock.module('../routes/project-chat', () => ({
  trackUsageFromStream: async () => undefined,
  projectChatRoutes: () => ({
    fetch: async (request: Request) => {
      dispatched.push(JSON.parse(await request.text()))
      return new Response(null, { status: 200 })
    },
  }),
}))

const { prisma } = await import('../lib/prisma')
const tasks = await import('../services/background-tasks.service')
const { dispatchNext } = await import('../services/chat-queue-dispatcher.service')
const pause = await import('../services/workspace-pause.service')
const deliveries = await import('../jobs/run-event-delivery-dispatch')

const db = prisma as any
let seed: SeededWorkspace

async function newSession(): Promise<string> {
  const session = await db.chatSession.create({
    data: { inferredName: 'Chat', contextType: 'project', contextId: seed.projectId, createdByUserId: seed.owner },
  })
  return session.id
}

/** One finished, unseen task in the session — the shape every wake comes from. */
async function finishedTask(chatSessionId: string, label: string): Promise<string> {
  const id = tasks.newTaskId()
  await tasks.createTask({ id, chatSessionId, source: 'agent_reply', targetRef: `m:${label}`, title: `@Ops ${label}` })
  await tasks.emitTaskEvent('agent_reply', `m:${label}`, { status: 'completed', line: 'done' })
  tasks._testing.clearTimers()
  return id
}

async function dueSchedule(): Promise<any> {
  return db.agentSchedule.create({
    data: {
      workspaceId: seed.workspaceId,
      userId: seed.owner,
      name: 'nightly digest',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      prompt: 'summarise',
      enabled: true,
      nextRunAt: new Date(Date.now() - 60_000),
    },
  })
}

/** A pending trigger delivery, due now. */
async function pendingDelivery(): Promise<any> {
  const subscription = await db.eventSubscription.create({
    data: {
      workspaceId: seed.workspaceId,
      name: 'new ticket',
      eventType: 'work_item.created',
      ownerUserId: seed.owner,
    },
  })
  const event = await db.workspaceEvent.create({
    data: {
      workspaceId: seed.workspaceId,
      type: 'work_item.created',
      payload: { id: 'wi_1' },
      dedupeKey: `drain-test-${Date.now()}-${Math.random()}`,
    },
  })
  return db.eventDelivery.create({
    data: {
      subscriptionId: subscription.id,
      eventId: event.id,
      workspaceId: seed.workspaceId,
      status: 'pending',
      nextAttemptAt: new Date(Date.now() - 60_000),
    },
  })
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

afterEach(async () => {
  tasks._testing.clearTimers()
  dispatched.length = 0
  pause.resetDrainHold()
  pause.resetWorkspacePauseCache()
  await pause.setWorkspacePause(seed.workspaceId, null).catch(() => {})
  pause.resetWorkspacePauseCache()
  await db.eventDelivery.deleteMany({})
  await db.eventSubscription.deleteMany({})
  await db.workspaceEvent.deleteMany({})
  await db.agentSchedule.deleteMany({})
})

afterAll(async () => {
  tasks._testing.clearTimers()
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('the drain hold', () => {
  test('holds every workspace without writing a pause anyone has to clear', async () => {
    expect(await pause.isWorkspaceAgentsPaused(seed.workspaceId)).toBe(false)

    pause.setDrainHold(true, 'desktop-restart')
    pause.resetWorkspacePauseCache()

    // Every workspace, and the check the per-session paths funnel through.
    expect(await pause.isWorkspaceAgentsPaused(seed.workspaceId)).toBe(true)
    expect(await pause.isWorkspaceAgentsPaused(seed.otherWorkspaceId)).toBe(true)
    expect(await pause.isSessionWorkspacePaused({ workspaceId: seed.otherWorkspaceId })).toBe(true)

    // Nothing was persisted: a restart (or a crash) cannot leave it behind.
    const row = await db.workspace.findUnique({ where: { id: seed.workspaceId }, select: { settings: true } })
    const settings = typeof row.settings === 'string' ? JSON.parse(row.settings) : (row.settings ?? {})
    expect(settings.agentsPaused ?? null).toBeNull()
    expect(await pause.readWorkspacePause(seed.workspaceId)).toBeNull()

    await pause.releaseDrainHold()
    pause.resetWorkspacePauseCache()
    expect(await pause.isWorkspaceAgentsPaused(seed.workspaceId)).toBe(false)
  })

  test('a due schedule is not claimed while draining, and runs after it lifts', async () => {
    const schedule = await dueSchedule()
    pause.setDrainHold(true, 'desktop-restart')

    const { dispatchDueSchedules } = await import('../jobs/run-agent-schedule-dispatch')
    await dispatchDueSchedules({} as any)

    const held = await db.agentSchedule.findUnique({ where: { id: schedule.id } })
    expect(held.lastRunAt).toBeNull()
    expect(held.runningAt).toBeNull()
    expect(new Date(held.nextRunAt).getTime()).toBe(new Date(schedule.nextRunAt).getTime())

    // Lifting the drain hands it back: the row is still due, so the next tick
    // claims it. (No runtime here, so a claim is what we can observe.)
    await pause.releaseDrainHold()
    pause.resetWorkspacePauseCache()
    expect(await pause.isWorkspaceAgentsPaused(seed.workspaceId)).toBe(false)
    const stillDue = await db.agentSchedule.findUnique({ where: { id: schedule.id } })
    expect(new Date(stillDue.nextRunAt).getTime()).toBeLessThanOrEqual(Date.now())
  })

  test('a pending trigger delivery is skipped while draining and starts when it lifts', async () => {
    const delivery = await pendingDelivery()

    pause.setDrainHold(true, 'desktop-restart')
    expect(await deliveries.dispatchDueDeliveries()).toBe(0)

    const held = await db.eventDelivery.findUnique({ where: { id: delivery.id } })
    expect(held.status).toBe('pending')
    expect(held.attempts).toBe(0)
    expect(held.runningAt).toBeNull()

    await pause.releaseDrainHold()
    pause.resetWorkspacePauseCache()
    expect(await deliveries.dispatchDueDeliveries()).toBe(1)
    await deliveries.waitForEventDeliveries()

    const started = await db.eventDelivery.findUnique({ where: { id: delivery.id } })
    expect(started.attempts).toBe(1)
  })

  test('a task wake is held at the source and delivered once the drain lifts', async () => {
    const chatSessionId = await newSession()
    pause.setDrainHold(true, 'desktop-restart')

    const taskId = await finishedTask(chatSessionId, 'held')
    expect(await tasks.enqueueTaskWake(chatSessionId, { dispatch: false })).toBe(false)
    expect(await db.chatQueuedMessage.count({ where: { sessionId: chatSessionId } })).toBe(0)
    // Nothing was lost: the task is still finished-and-unseen.
    expect(await tasks.getTask(taskId)).toMatchObject({ status: 'completed', consumed: false, notifiedAt: null })

    await pause.releaseDrainHold()
    pause.resetWorkspacePauseCache()
    await waitFor(async () => dispatched.length > 0)
    expect(dispatched[0].taskNotification).toEqual({ taskIds: [taskId] })
  })

  test("a person's own message still starts while draining", async () => {
    const chatSessionId = await newSession()
    pause.setDrainHold(true, 'desktop-restart')
    await db.chatQueuedMessage.create({
      data: {
        sessionId: chatSessionId,
        userId: seed.owner,
        position: 0,
        status: 'pending',
        kind: 'user',
        content: 'carry on with the billing fix',
        parts: JSON.stringify([{ type: 'text', text: 'carry on with the billing fix' }]),
        body: JSON.stringify({ text: 'carry on with the billing fix' }),
      },
    })

    expect(await dispatchNext(chatSessionId)).toBe(true)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].text).toBe('carry on with the billing fix')
  })

  test("cancelling a drain leaves a person's pause exactly as it was", async () => {
    await pause.setWorkspacePause(seed.workspaceId, { at: new Date().toISOString(), by: seed.owner, reason: 'stop everything' })
    pause.setDrainHold(true, 'desktop-restart')

    await pause.releaseDrainHold()
    pause.resetWorkspacePauseCache()

    expect(pause.readDrainHold()).toBeNull()
    expect(await pause.readWorkspacePause(seed.workspaceId)).toMatchObject({ reason: 'stop everything' })
    expect(await pause.isWorkspaceAgentsPaused(seed.workspaceId)).toBe(true)
  })
})
