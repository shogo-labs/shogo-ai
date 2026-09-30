// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace chat mode: the kill switch for team chat, per-kind defaults, and
 * which surfaces each mode leaves reachable (Shogo chat UI vs agent tools).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes, agentChannelRoutes } = await import('../routes/conversations')
const bus = await import('../lib/conversation-bus')
const chatMode = await import('../services/chat-mode')
const activity = await import('../services/conversation-activity')

const db = prisma as any
let seed: SeededWorkspace

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
app.route('/api/internal', agentChannelRoutes({
  authorize: async (c) => ({ workspaceId: c.req.param('workspaceId'), projectId: seed.projectId }),
}))

async function call(user: string | null, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...(user ? { 'x-user': user } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

async function setMode(mode: string | null, provider: string | null = null) {
  await db.workspace.update({ where: { id: seed.workspaceId }, data: { chatMode: mode, chatProvider: provider } })
  chatMode._resetChatModeCacheForTests()
}

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
})

beforeEach(() => chatMode._resetChatModeCacheForTests())

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('defaults', () => {
  test('team workspaces default to native, personal ones to off', () => {
    expect(chatMode.resolveChatConfig({ kind: 'team' })).toEqual({ mode: 'native', provider: null, isDefault: true })
    expect(chatMode.resolveChatConfig({ kind: 'personal' }).mode).toBe('off')
    expect(chatMode.resolveChatConfig({ kind: 'personal', chatMode: 'native' })).toMatchObject({ mode: 'native', isDefault: false })
    expect(chatMode.resolveChatConfig({ kind: 'team', chatMode: 'bogus' }).mode).toBe('native')
    expect(chatMode.resolveChatConfig({ kind: 'team', chatMode: 'native', chatProvider: 'slack' }).provider).toBeNull()
  })

  test('chat settings are readable by members in every mode', async () => {
    await setMode('off')
    const res = await call(seed.member, 'GET', `/workspaces/${seed.workspaceId}/chat-mode`)
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ mode: 'off', provider: null, canManage: false })
    expect((await call(seed.outsider, 'GET', `/workspaces/${seed.workspaceId}/chat-mode`)).status).toBe(403)
    await setMode(null)
  })
})

describe('turning chat off', () => {
  test('only admins change the mode and it validates input', async () => {
    const path = `/workspaces/${seed.workspaceId}/chat-mode`
    expect((await call(seed.member, 'PATCH', path, { mode: 'off' })).status).toBe(403)
    expect((await call(seed.owner, 'PATCH', path, { mode: 'sideways' })).status).toBe(400)
    expect((await call(seed.owner, 'PATCH', path, { mode: 'external' })).status).toBe(400)
    const off = await call(seed.owner, 'PATCH', path, { mode: 'off' })
    expect(off.json).toMatchObject({ mode: 'off', isDefault: false })
    const native = await call(seed.owner, 'PATCH', path, { mode: 'native' })
    expect(native.json.mode).toBe('native')
  })

  test('off blocks the chat UI, agent tools, and #activity; native restores them', async () => {
    const list = await call(seed.member, 'GET', `/workspaces/${seed.workspaceId}/conversations`)
    const general = list.json.conversations.find((c: any) => c.slug === 'general')

    await setMode('off')
    const blockedList = await call(seed.member, 'GET', `/workspaces/${seed.workspaceId}/conversations`)
    expect(blockedList.status).toBe(403)
    expect(blockedList.json.error.code).toBe('chat_disabled')
    const blockedPost = await call(seed.member, 'POST', `/conversations/${general.id}/messages`, { text: 'hello?' })
    expect(blockedPost.status).toBe(403)
    expect(blockedPost.json.error.code).toBe('chat_disabled')
    const agentPost = await call(null, 'POST', `/internal/workspaces/${seed.workspaceId}/agent-channels/general/messages`, { text: 'hi' })
    expect(agentPost.status).toBe(403)
    expect(agentPost.json.error.message).toContain('turned off')
    expect(await activity.postActivity(seed.workspaceId, { kind: 'member.joined', text: 'x', ref: 'off-1' })).toBeNull()

    await setMode('native')
    expect((await call(seed.member, 'POST', `/conversations/${general.id}/messages`, { text: 'back' })).status).toBe(201)
    expect((await call(null, 'GET', `/internal/workspaces/${seed.workspaceId}/agent-channels`)).status).toBe(200)
  })

  test('external mode hides the Shogo chat UI but keeps agent tools', async () => {
    await setMode('external', 'slack')
    const res = await call(seed.member, 'GET', `/workspaces/${seed.workspaceId}/conversations`)
    expect(res.status).toBe(403)
    expect(res.json.error.message).toContain('Slack')
    expect((await call(null, 'GET', `/internal/workspaces/${seed.workspaceId}/agent-channels`)).status).toBe(200)
    await setMode(null)
  })
})
