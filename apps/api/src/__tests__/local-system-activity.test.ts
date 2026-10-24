// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-181 — the local system routes the desktop's restart gate reads.
 *
 * `GET /local/system/activity` is the one honest answer to "will a restart
 * interrupt someone?", so it is driven against a real database: a live turn, a
 * running background task and a team-chat agent reply each show up; a turn whose
 * heartbeat stopped does not, because "restart when idle" would otherwise wait
 * forever on a turn that is already dead.
 *
 * `POST /local/system/drain` and `POST /local/system/shutdown` are switches on
 * the machine's own API, so the refusals are locked here too: a drain body that
 * is not a boolean, and a shutdown without the per-launch token.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

process.env.BETTER_AUTH_SECRET ||= 'local-system-activity-test-secret'

const { dir } = setupChannelsTestDb()

mock.module('../lib/runtime', () => ({ getRuntimeManager: () => ({}) }))
mock.module('../lib/instance-tunnel', () => ({
  startInstanceTunnel: () => {},
  stopInstanceTunnel: () => {},
  isTunnelConnected: () => false,
  getInstanceTunnelStatus: () => [],
}))

const { prisma } = await import('../lib/prisma')
const pause = await import('../services/workspace-pause.service')
const shutdown = await import('../lib/local-shutdown')
const { localSystemRoutes } = await import('../routes/local-system')

const db = prisma as any
let seed: SeededWorkspace

const app = new Hono()
app.route('/api', localSystemRoutes())

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

async function newSession(inferredName = 'Chat'): Promise<string> {
  const session = await db.chatSession.create({
    data: { inferredName, contextType: 'project', contextId: seed.projectId, createdByUserId: seed.owner },
  })
  return session.id
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

afterEach(async () => {
  pause.resetDrainHold()
  shutdown.resetLocalShutdownHandler()
  delete process.env.SHOGO_DESKTOP_SHUTDOWN_TOKEN
  await db.backgroundTask.deleteMany({})
  await db.conversationMessage.deleteMany({})
  await db.chatSession.deleteMany({})
})

afterAll(async () => {
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('GET /api/local/system/activity', () => {
  test('counts nothing when the machine is idle', async () => {
    const res = await call('GET', '/local/system/activity')
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ok: true, liveTurns: 0, runningTasks: 0, runningAgentReplies: 0, sessions: [] })
  })

  test('counts a live turn, a running task and a running team-chat reply, and names the chat', async () => {
    const sessionId = await newSession('Ship the release')
    await db.chatSession.update({
      where: { id: sessionId },
      data: {
        activeTurnId: 'turn-1',
        activeTurnStartedAt: new Date(),
        activeTurnHeartbeatAt: new Date(),
      },
    })
    const taskId = `t_${Date.now()}`
    await db.backgroundTask.create({
      data: {
        id: taskId,
        chatSessionId: sessionId,
        source: 'agent_reply',
        targetRef: 'm:1',
        title: 'build',
        status: 'running',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    })
    const conversation = await db.conversation.create({
      data: { workspaceId: seed.workspaceId, name: 'general', kind: 'public', createdById: seed.owner },
    })
    await db.conversationMessage.create({
      data: {
        conversationId: conversation.id,
        workspaceId: seed.workspaceId,
        seq: 1,
        authorType: 'agent',
        text: 'working on it',
        agentStatus: 'running',
      },
    })

    const res = await call('GET', '/local/system/activity')
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ok: true, liveTurns: 1, runningTasks: 1, runningAgentReplies: 1 })
    expect(res.json.sessions).toHaveLength(1)
    expect(res.json.sessions[0]).toMatchObject({ id: sessionId, title: 'Ship the release' })
  })

  test('a turn whose heartbeat stopped is not live, so "when idle" can still fire', async () => {
    const { TURN_REATTACH_AFTER_MS } = await import('../services/chat-turn-state.service')
    const sessionId = await newSession()
    await db.chatSession.update({
      where: { id: sessionId },
      data: {
        activeTurnId: 'turn-dead',
        activeTurnStartedAt: new Date(Date.now() - TURN_REATTACH_AFTER_MS - 60_000),
        activeTurnHeartbeatAt: new Date(Date.now() - TURN_REATTACH_AFTER_MS - 60_000),
      },
    })

    const res = await call('GET', '/local/system/activity')
    expect(res.json).toMatchObject({ liveTurns: 0, runningTasks: 0, runningAgentReplies: 0 })
    expect(res.json.sessions).toEqual([])
  })
})

describe('POST /api/local/system/drain', () => {
  test('requires a boolean', async () => {
    const res = await call('POST', '/local/system/drain', { on: 'yes' })
    expect(res.status).toBe(400)
    expect(pause.readDrainHold()).toBeNull()
  })

  test('turns the drain on and off', async () => {
    const on = await call('POST', '/local/system/drain', { on: true, reason: 'desktop-restart' })
    expect(on.status).toBe(200)
    expect(on.json).toMatchObject({ ok: true, drain: { reason: 'desktop-restart' } })
    expect(await pause.isWorkspaceAgentsPaused(seed.workspaceId)).toBe(true)

    const off = await call('POST', '/local/system/drain', { on: false })
    expect(off.status).toBe(200)
    expect(off.json).toEqual({ ok: true, drain: null })
    expect(pause.readDrainHold()).toBeNull()
    pause.resetWorkspacePauseCache()
    expect(await pause.isWorkspaceAgentsPaused(seed.workspaceId)).toBe(false)
  })
})

describe('POST /api/local/system/shutdown', () => {
  test('401 without the per-launch token', async () => {
    shutdown.registerLocalShutdownHandler(async () => {
      throw new Error('must not run')
    })
    expect((await call('POST', '/local/system/shutdown', { reason: 'update' })).status).toBe(401)

    process.env.SHOGO_DESKTOP_SHUTDOWN_TOKEN = 'launch-token'
    expect((await call('POST', '/local/system/shutdown', { reason: 'update' })).status).toBe(401)
    expect((await call('POST', '/local/system/shutdown', { reason: 'update' }, { 'x-shogo-shutdown-token': 'nope' })).status).toBe(401)
  })

  test('runs the registered shutdown with the reason the desktop sent', async () => {
    process.env.SHOGO_DESKTOP_SHUTDOWN_TOKEN = 'launch-token'
    const reasons: string[] = []
    shutdown.registerLocalShutdownHandler(async (reason) => {
      reasons.push(reason)
    })

    const res = await call('POST', '/local/system/shutdown', { reason: 'update' }, { 'x-shogo-shutdown-token': 'launch-token' })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true, reason: 'update' })

    // Answered first, then stopped — the caller is holding its own exit open.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(reasons).toEqual(['update'])
  })

  test('an unknown reason is logged as a plain quit', async () => {
    process.env.SHOGO_DESKTOP_SHUTDOWN_TOKEN = 'launch-token'
    const reasons: string[] = []
    shutdown.registerLocalShutdownHandler(async (reason) => {
      reasons.push(reason)
    })
    const res = await call('POST', '/local/system/shutdown', { reason: 'whatever' }, { 'x-shogo-shutdown-token': 'launch-token' })
    expect(res.json).toEqual({ ok: true, reason: 'quit' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(reasons).toEqual(['quit'])
  })
})
