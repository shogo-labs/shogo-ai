// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Routines that report into a channel or a thread: a schedule's result lands
 * under the thread it was pointed at, as a result (quiet) or an alert (failed).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes } = await import('../routes/conversations')
const { workspaceAgentRoutes, sessionAuthorize } = await import('../routes/workspace-agent')
const bus = await import('../lib/conversation-bus')
const activity = await import('../services/conversation-activity')
const teamChannels = await import('../services/conversation-team-channels')

const db = prisma as any
let seed: SeededWorkspace
let channel: string
let otherChannel: string
let root: string

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
app.route('/api', workspaceAgentRoutes({ authorize: sessionAuthorize(async (c: any) => c.req.header('x-user') ?? null) }))

async function call(user: string | null, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...(user ? { 'x-user': user } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

const schedulesPath = () => `/workspaces/${seed.workspaceId}/schedules`
const create = (extra: Record<string, unknown> = {}) =>
  call(seed.owner, 'POST', schedulesPath(), {
    name: 'Morning briefing', prompt: 'Summarize what shipped', cronExpression: '0 9 * * 1-5', timezone: 'UTC',
    notifyConversationId: channel, ...extra,
  })

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  const mk = async (name: string) => (await teamChannels.upsertTeamChannel(seed.workspaceId, { name, agents: [], userEmails: [] })).channel.id as string
  channel = await mk('eng')
  otherChannel = await mk('random')
  root = (await call(seed.owner, 'POST', `/conversations/${channel}/messages`, { text: 'Weekly status' })).json.message.id
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

const repliesIn = (threadRootId: string) =>
  db.conversationMessage.findMany({ where: { threadRootId, authorType: 'agent' }, orderBy: { seq: 'asc' } })

describe('schedule notify thread', () => {
  test('a schedule can be pointed at a thread in its channel', async () => {
    const res = await create({ notifyThreadRootId: root })
    expect(res.status).toBe(201)
    expect(res.json.schedule.notifyConversationId).toBe(channel)
    expect(res.json.schedule.notifyThreadRootId).toBe(root)
  })

  test('the thread must be a top-level message of the notify channel', async () => {
    const reply = (await call(seed.owner, 'POST', `/conversations/${channel}/messages`, { text: 'a reply', threadRootId: root })).json.message.id
    const elsewhere = (await call(seed.owner, 'POST', `/conversations/${otherChannel}/messages`, { text: 'other' })).json.message.id
    for (const bad of [reply, elsewhere, 'nope']) {
      const res = await create({ notifyThreadRootId: bad })
      expect(res.status).toBe(400)
      expect(res.json.error.code).toBe('invalid_notify_thread')
    }
    expect((await create({ notifyConversationId: null, notifyThreadRootId: root })).status).toBe(400)
  })

  test('changing the channel drops the thread unless a new one is given', async () => {
    const made = await create({ notifyThreadRootId: root })
    const id = made.json.schedule.id
    const moved = await call(seed.owner, 'PATCH', `${schedulesPath()}/${id}`, { notifyConversationId: otherChannel })
    expect(moved.json.schedule.notifyConversationId).toBe(otherChannel)
    expect(moved.json.schedule.notifyThreadRootId).toBeNull()
    const otherRoot = (await call(seed.owner, 'POST', `/conversations/${otherChannel}/messages`, { text: 'standup' })).json.message.id
    const pinned = await call(seed.owner, 'PATCH', `${schedulesPath()}/${id}`, { notifyThreadRootId: otherRoot })
    expect(pinned.json.schedule.notifyThreadRootId).toBe(otherRoot)
    const cleared = await call(seed.owner, 'PATCH', `${schedulesPath()}/${id}`, { notifyThreadRootId: null })
    expect(cleared.json.schedule.notifyThreadRootId).toBeNull()
    expect(cleared.json.schedule.notifyConversationId).toBe(otherChannel)
  })
})

describe('schedule results', () => {
  const outcome = (schedule: Record<string, unknown>, status: string, extra: Record<string, unknown> = {}) =>
    activity.recordScheduleOutcome(
      { id: 'sch-t', workspaceId: seed.workspaceId, userId: seed.owner, name: 'Morning briefing', ...schedule } as any,
      { status, runKey: `run-${crypto.randomUUID()}`, ...extra },
    )

  test('a finished run posts its summary under the thread as a quiet result', async () => {
    await outcome({ notifyConversationId: channel, notifyThreadRootId: root }, 'ok', { summary: 'Shipped: #12. Waiting on you: #14.' })
    const replies = await repliesIn(root)
    const posted = replies.find((r: any) => r.text.includes('Shipped: #12'))
    expect(posted).toBeTruthy()
    expect(posted.blocks.messageKind).toBe('result')
    expect(posted.threadRootId).toBe(root)
  })

  test('a failed run is an alert in the thread', async () => {
    await outcome({ notifyConversationId: channel, notifyThreadRootId: root }, 'failed', { error: 'runtime offline' })
    const posted = (await repliesIn(root)).find((r: any) => r.text.includes('runtime offline'))
    expect(posted.blocks.messageKind).toBe('alert')
    expect(posted.agentStatus).toBe('error')
  })

  test('without a thread the result goes to the channel itself', async () => {
    await outcome({ notifyConversationId: channel }, 'ok', { summary: 'Top-level briefing' })
    const row = await db.conversationMessage.findFirst({ where: { conversationId: channel, text: { contains: 'Top-level briefing' } } })
    expect(row.threadRootId).toBeNull()
  })

  test('a thread that has since been deleted falls back to the channel', async () => {
    const gone = (await call(seed.owner, 'POST', `/conversations/${channel}/messages`, { text: 'temporary thread' })).json.message.id
    await call(seed.owner, 'DELETE', `/conversation-messages/${gone}`)
    await outcome({ notifyConversationId: channel, notifyThreadRootId: gone }, 'ok', { summary: 'Fallback briefing' })
    const row = await db.conversationMessage.findFirst({ where: { conversationId: channel, text: { contains: 'Fallback briefing' } } })
    expect(row).toBeTruthy()
    expect(row.threadRootId).toBeNull()
  })

  describe('run now', () => {
    test('marks the schedule due without changing its cadence', async () => {
      const id = (await create()).json.schedule.id
      const before = await db.agentSchedule.findUnique({ where: { id } })
      expect(before.nextRunAt.getTime()).toBeGreaterThan(Date.now() - 1000)
      const res = await call(seed.owner, 'POST', `${schedulesPath()}/${id}/run`)
      expect(res.status).toBe(202)
      const after = await db.agentSchedule.findUnique({ where: { id } })
      expect(after.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now())
      expect(after.cronExpression).toBe('0 9 * * 1-5')
    })

    test('refuses a disabled schedule and one that is already running', async () => {
      const disabled = (await create({ enabled: false })).json.schedule.id
      const off = await call(seed.owner, 'POST', `${schedulesPath()}/${disabled}/run`)
      expect(off.status).toBe(409)
      expect(off.json.error.code).toBe('schedule_disabled')

      const busy = (await create()).json.schedule.id
      await db.agentSchedule.update({ where: { id: busy }, data: { runningAt: new Date() } })
      const running = await call(seed.owner, 'POST', `${schedulesPath()}/${busy}/run`)
      expect(running.status).toBe(409)
      expect(running.json.error.code).toBe('schedule_running')
    })

    test('404 for an unknown schedule and 403 for viewers/outsiders', async () => {
      expect((await call(seed.owner, 'POST', `${schedulesPath()}/nope/run`)).status).toBe(404)
      const id = (await create()).json.schedule.id
      expect([401, 403]).toContain((await call(null, 'POST', `${schedulesPath()}/${id}/run`)).status)
    })
  })
})
