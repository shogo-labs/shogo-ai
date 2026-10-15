// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Deleting a channel against a real SQLite database: who may, which channels
 * can't be deleted, that everything in the channel goes with it, that
 * references without a foreign key are cleaned up, and that channels an agent
 * system declares stay protected until its manifest drops them.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes, agentChannelRoutes } = await import('../routes/conversations')
const bus = await import('../lib/conversation-bus')
const files = await import('../lib/conversation-files')
const service = await import('../services/conversation.service')

const db = prisma as any
let seed: SeededWorkspace

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
app.route('/api/internal', agentChannelRoutes({
  authorize: async (c) => ({ workspaceId: c.req.param('workspaceId'), projectId: null }),
}))

async function call(user: string | null, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...(user ? { 'x-user': user } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

const teamChannels = (path = '') => `/internal/workspaces/${seed.workspaceId}/agent-channels/team-channels${path}`

async function createChannel(user: string, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await call(user, 'POST', `/workspaces/${seed.workspaceId}/conversations`, { name, ...extra })
  expect(res.status).toBe(201)
  return res.json.conversation.id
}

async function exists(id: string): Promise<boolean> {
  return !!(await db.conversation.findUnique({ where: { id } }))
}

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('who can delete', () => {
  test('a workspace owner can delete anyone’s channel', async () => {
    const id = await createChannel(seed.member, 'owner-deletes')
    expect((await call(seed.owner, 'DELETE', `/conversations/${id}`)).status).toBe(200)
    expect(await exists(id)).toBe(false)
  })

  test('the channel owner can delete their own channel', async () => {
    const id = await createChannel(seed.member, 'mine-to-delete')
    const detail = await call(seed.member, 'GET', `/conversations/${id}`)
    expect(detail.json.conversation.canDelete).toBe(true)
    expect((await call(seed.member, 'DELETE', `/conversations/${id}`)).status).toBe(200)
    expect(await exists(id)).toBe(false)
  })

  test('other members and viewers cannot', async () => {
    const id = await createChannel(seed.owner, 'not-yours')
    await call(seed.member, 'POST', `/conversations/${id}/join`)
    const detail = await call(seed.member, 'GET', `/conversations/${id}`)
    expect(detail.json.conversation.canDelete).toBe(false)
    expect((await call(seed.member, 'DELETE', `/conversations/${id}`)).status).toBe(403)
    expect((await call(seed.viewer, 'DELETE', `/conversations/${id}`)).status).toBe(403)
    expect((await call(seed.outsider, 'DELETE', `/conversations/${id}`)).status).toBe(404)
    expect(await exists(id)).toBe(true)
  })

  test('a deleted channel is gone for everyone', async () => {
    const id = await createChannel(seed.owner, 'gone')
    expect((await call(seed.owner, 'DELETE', `/conversations/${id}`)).status).toBe(200)
    expect((await call(seed.owner, 'GET', `/conversations/${id}`)).status).toBe(404)
    expect((await call(seed.owner, 'DELETE', `/conversations/${id}`)).status).toBe(404)
  })
})

describe('channels that cannot be deleted', () => {
  test('#general', async () => {
    const list = await call(seed.owner, 'GET', `/workspaces/${seed.workspaceId}/conversations`)
    const general = list.json.conversations.find((c: any) => c.slug === 'general')
    const detail = await call(seed.owner, 'GET', `/conversations/${general.id}`)
    expect(detail.json.conversation.canDelete).toBe(false)
    expect((await call(seed.owner, 'DELETE', `/conversations/${general.id}`)).status).toBe(400)
    expect(await exists(general.id)).toBe(true)
  })

  test('direct messages and #activity', async () => {
    const dm = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/dms`, { userIds: [seed.member] })
    expect(dm.status).toBe(200)
    expect((await call(seed.owner, 'DELETE', `/conversations/${dm.json.conversation.id}`)).status).toBe(400)
    const activity = await service.getActivityConversation(seed.workspaceId)
    expect((await call(seed.owner, 'DELETE', `/conversations/${activity.id}`)).status).toBe(400)
    expect(await exists(activity.id)).toBe(true)
  })

  test('a channel mirrored from another chat app', async () => {
    const mirrored = await db.conversation.create({
      data: { workspaceId: seed.workspaceId, kind: 'public', name: 'from-slack', slug: 'from-slack', provider: 'slack', externalId: 'C123' },
    })
    const res = await call(seed.owner, 'DELETE', `/conversations/${mirrored.id}`)
    expect(res.status).toBe(400)
    expect(await exists(mirrored.id)).toBe(true)
  })
})

describe('what deleting removes', () => {
  test('messages, files and their bytes go; links from elsewhere are cleaned up', async () => {
    const id = await createChannel(seed.owner, 'full-of-stuff')
    const post = await call(seed.owner, 'POST', `/conversations/${id}/messages`, { text: 'hello' })
    expect(post.status).toBe(201)
    const messageId = post.json.message.id

    const storageKey = files.buildConversationFileKey(seed.workspaceId, id, 'notes.txt')
    await files.putConversationFile(storageKey, new TextEncoder().encode('bytes'), 'text/plain')
    const bytesPath = join(dir, 'conversation-files', storageKey)
    expect(existsSync(bytesPath)).toBe(true)
    await db.conversationAttachment.create({
      data: { conversationId: id, uploaderUserId: seed.owner, storageKey, name: 'notes.txt', mimeType: 'text/plain', size: 5 },
    })

    const schedule = await db.agentSchedule.create({
      data: {
        workspaceId: seed.workspaceId, userId: seed.owner, name: 'Daily', prompt: 'Summarize',
        cronExpression: '0 9 * * *', nextRunAt: new Date(), notifyConversationId: id, notifyThreadRootId: messageId,
      },
    })
    const trigger = await db.eventSubscription.create({
      data: { workspaceId: seed.workspaceId, name: 'On push', eventType: 'github.push', notifyConversationId: id },
    })
    const task = await db.agentTask.create({
      data: { workspaceId: seed.workspaceId, userId: seed.owner, title: 'Report', notifyConversationId: id },
    })
    const approval = await db.integrationCredentialApproval.create({
      data: { projectId: seed.projectId, provider: 'github', op: 'read', expiresAt: new Date(Date.now() + 60_000), conversationId: id, messageId },
    })
    await db.chatReminder.create({
      data: { workspaceId: seed.workspaceId, userId: seed.owner, text: 'Follow up', remindAt: new Date(), conversationId: id, messageId },
    })
    await db.chatInboxItem.create({
      data: { workspaceId: seed.workspaceId, userId: seed.member, kind: 'mention', title: 'Mention', preview: 'hello', conversationId: id, messageId },
    })

    expect((await call(seed.owner, 'DELETE', `/conversations/${id}`)).status).toBe(200)

    expect(await exists(id)).toBe(false)
    expect(await db.conversationMessage.count({ where: { conversationId: id } })).toBe(0)
    expect(await db.conversationMember.count({ where: { conversationId: id } })).toBe(0)
    expect(await db.conversationAttachment.count({ where: { conversationId: id } })).toBe(0)
    expect(existsSync(bytesPath)).toBe(false)

    const keptSchedule = await db.agentSchedule.findUnique({ where: { id: schedule.id } })
    expect(keptSchedule).not.toBeNull()
    expect(keptSchedule.notifyConversationId).toBeNull()
    expect(keptSchedule.notifyThreadRootId).toBeNull()
    expect((await db.eventSubscription.findUnique({ where: { id: trigger.id } })).notifyConversationId).toBeNull()
    expect((await db.agentTask.findUnique({ where: { id: task.id } })).notifyConversationId).toBeNull()
    const keptApproval = await db.integrationCredentialApproval.findUnique({ where: { id: approval.id } })
    expect(keptApproval.conversationId).toBeNull()
    expect(keptApproval.messageId).toBeNull()
    expect(await db.chatReminder.count({ where: { conversationId: id } })).toBe(0)
    expect(await db.chatInboxItem.count({ where: { conversationId: id } })).toBe(0)
  })

  test('tells everyone who could see the channel', async () => {
    const seen: any[] = []
    const stop = bus.subscribeWorkspaceEvents(seed.workspaceId, (envelope) => {
      if (envelope.event.type === 'conversation.deleted') seen.push(envelope)
    })
    try {
      const publicId = await createChannel(seed.owner, 'public-bye')
      const privateId = await createChannel(seed.owner, 'private-bye', { kind: 'private' })
      await call(seed.owner, 'POST', `/conversations/${privateId}/members`, { userIds: [seed.member] })

      await call(seed.owner, 'DELETE', `/conversations/${publicId}`)
      await call(seed.owner, 'DELETE', `/conversations/${privateId}`)

      const pub = await waitFor(async () => seen.find((e) => e.event.conversationId === publicId))
      expect(pub.audience).toBeNull()
      const priv = await waitFor(async () => seen.find((e) => e.event.conversationId === privateId))
      expect([...priv.audience].sort()).toEqual([seed.owner, seed.member].sort())
    } finally {
      stop()
    }
  })
})

describe('channels an agent system declares', () => {
  test('stay protected while declared, and can be deleted once the manifest drops them', async () => {
    const put = await call(null, 'PUT', teamChannels('/sys-standup'), { system: seed.projectId, topic: 'Daily' })
    expect(put.status).toBe(201)
    const id = put.json.channel.id

    const detail = await call(seed.owner, 'GET', `/conversations/${id}`)
    expect(detail.json.conversation.systemManaged).toBe(true)
    expect(detail.json.conversation.canDelete).toBe(false)

    const blocked = await call(seed.owner, 'DELETE', `/conversations/${id}`)
    expect(blocked.status).toBe(409)
    expect(blocked.json.error.code).toBe('system_managed')
    expect(blocked.json.error.message).toContain('Billing Bot')
    expect(await exists(id)).toBe(true)

    const sync = await call(null, 'POST', teamChannels('/ownership'), { system: seed.projectId, declared: [] })
    expect(sync.status).toBe(200)
    expect(sync.json.released).toContain('sys-standup')

    expect((await call(seed.owner, 'DELETE', `/conversations/${id}`)).status).toBe(200)
  })

  test('an existing channel the manifest declares is protected without needing an upsert', async () => {
    const id = await createChannel(seed.owner, 'sys-existing')
    const first = await call(null, 'POST', teamChannels('/ownership'), { system: seed.projectId, declared: ['sys-existing'] })
    expect(first.json.claimed).toEqual(['sys-existing'])
    expect((await call(seed.owner, 'DELETE', `/conversations/${id}`)).status).toBe(409)

    const again = await call(null, 'POST', teamChannels('/ownership'), { system: seed.projectId, declared: ['#sys-existing'] })
    expect(again.json).toEqual({ claimed: [], released: [] })
  })

  test('one system never releases another system’s channels', async () => {
    const other = await db.project.create({ data: { name: 'Ops Bot', workspaceId: seed.workspaceId } })
    const put = await call(null, 'PUT', teamChannels('/sys-other'), { system: other.id })
    const sync = await call(null, 'POST', teamChannels('/ownership'), { system: seed.projectId, declared: [] })
    expect(sync.json.released).not.toContain('sys-other')
    const blocked = await call(seed.owner, 'DELETE', `/conversations/${put.json.channel.id}`)
    expect(blocked.status).toBe(409)
    expect(blocked.json.error.message).toContain('Ops Bot')
  })

  test('runtimes that send no system leave channels unprotected', async () => {
    const put = await call(null, 'PUT', teamChannels('/legacy-runtime'), { topic: 'old' })
    expect(put.status).toBe(201)
    expect((await call(seed.owner, 'DELETE', `/conversations/${put.json.channel.id}`)).status).toBe(200)
  })

  test('the ownership sync needs a system and a list', async () => {
    expect((await call(null, 'POST', teamChannels('/ownership'), { declared: [] })).status).toBe(400)
    expect((await call(null, 'POST', teamChannels('/ownership'), { system: seed.projectId })).status).toBe(400)
  })
})
