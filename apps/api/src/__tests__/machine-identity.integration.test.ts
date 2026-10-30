// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The machine's owner is one person on both sides (SHO-185).
 *
 * A paired desktop knows its owner by a local user id; the cloud by their cloud
 * account. The cloud copy keeps the desktop's rows as they are, so read as the
 * cloud account the owner was a stranger in their own workspace: no DMs, no
 * private channels, their own messages by "someone else". The real team-chat
 * routes run here over a copy seeded the way ingest writes one, behind the same
 * middleware order as the cloud server.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { setupChannelsTestDb } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const bus = await import('../lib/conversation-bus')
const service = await import('../services/conversation.service')
const { conversationRoutes } = await import('../routes/conversations')
const identity = await import('../lib/machine-identity')

const db = prisma as any
const suffix = crypto.randomUUID().slice(0, 8)
const CLOUD_OWNER = `cloud-owner-${suffix}`
const LOCAL_OWNER = `local-owner-${suffix}`
const STRANGER = `stranger-${suffix}`
const INSTANCE = `inst-${suffix}`
let copyId = ''
let dmId = ''
let channelId = ''

function appAs(userId: string) {
  const app = new Hono()
  app.use('/api/*', async (c, next) => {
    c.set('auth', { userId, isAuthenticated: true, via: 'session' })
    await next()
  })
  app.use('/api/*', identity.machineCopyIdentity())
  app.route(
    '/api',
    conversationRoutes({ resolveUserId: async (c: any) => c.get('auth')?.userId ?? null }),
  )
  return app
}

async function get(userId: string, path: string, named = true) {
  const res = await appAs(userId).request(`/api${path}`, {
    headers: named ? { [identity.MACHINE_WORKSPACE_HEADER]: copyId } : {},
  })
  return { status: res.status, body: (await res.json().catch(() => null)) as any }
}

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  await db.user.create({ data: { id: CLOUD_OWNER, name: 'Russell', email: `russell-${suffix}@example.com` } })
  await db.user.create({ data: { id: STRANGER, name: 'Someone', email: `someone-${suffix}@example.com` } })
  const home = await db.workspace.create({ data: { name: 'Cloud', slug: `cloud-${suffix}`, kind: 'team' } })
  await db.instance.create({
    data: { id: INSTANCE, workspaceId: home.id, userId: CLOUD_OWNER, name: 'Laptop', hostname: 'laptop.local' },
  })

  // What ingest writes: the desktop's user (email rewritten), its workspace
  // tagged as a copy, its own member rows, and the owner's cloud membership.
  await db.user.create({
    data: { id: LOCAL_OWNER, name: 'Local User', email: `${LOCAL_OWNER}@machines.shogo.invalid` },
  })
  await db.machineMirrorRow.create({ data: { model: 'User', recordId: LOCAL_OWNER, instanceId: INSTANCE } })
  const copy = await db.workspace.create({
    data: { name: 'Laptop Team', slug: `laptop-${suffix}`, kind: 'team', machineInstanceId: INSTANCE },
  })
  copyId = copy.id
  await db.member.create({ data: { userId: LOCAL_OWNER, workspaceId: copyId, role: 'owner' } })
  await db.member.create({ data: { userId: CLOUD_OWNER, workspaceId: copyId, role: 'owner' } })

  // On the machine: #general, a private channel and a DM, written by the owner.
  const [general] = await service.ensureDefaultConversations(copyId)
  await db.conversationMember.create({ data: { conversationId: general.id, userId: LOCAL_OWNER } })
  const priv = await service.createChannel({
    workspaceId: copyId, userId: LOCAL_OWNER, name: 'launch', kind: 'private', topic: null, memberUserIds: [],
  })
  channelId = priv.id
  const dm = await service.openAgentConversation(copyId, LOCAL_OWNER, { projectId: null })
  dmId = dm.id
  await service.postMessage({ conversationId: channelId, authorType: 'user', authorUserId: LOCAL_OWNER, text: 'ship it' } as any)
})

beforeEach(() => identity._resetMachineIdentityForTests())

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe("the owner's cloud account reading their machine's copy", () => {
  test('sees the DMs and private channels they are in on the machine', async () => {
    const { status, body } = await get(CLOUD_OWNER, `/workspaces/${copyId}/conversations`)
    expect(status).toBe(200)
    const ids = (body.conversations ?? body).map((c: any) => c.id)
    expect(ids).toContain(dmId)
    expect(ids).toContain(channelId)
  })

  test('their own messages are theirs, under their cloud id', async () => {
    const { status, body } = await get(CLOUD_OWNER, `/conversations/${channelId}/messages`)
    expect(status).toBe(200)
    const text = JSON.stringify(body)
    expect(text).toContain(CLOUD_OWNER)
    expect(text).not.toContain(LOCAL_OWNER)
    const mine = (body.messages ?? body).find((m: any) => m.text === 'ship it')
    expect(mine.authorUserId).toBe(CLOUD_OWNER)
  })

  test('the machine announcing its owner is enough, before any user row is copied', async () => {
    await db.machineMirrorRow.delete({ where: { model_recordId: { model: 'User', recordId: LOCAL_OWNER } } })
    try {
      identity.rememberMachineLocalUser(INSTANCE, LOCAL_OWNER)
      const { body } = await get(CLOUD_OWNER, `/workspaces/${copyId}/conversations`)
      expect((body.conversations ?? body).map((c: any) => c.id)).toContain(dmId)
    } finally {
      await db.machineMirrorRow.create({ data: { model: 'User', recordId: LOCAL_OWNER, instanceId: INSTANCE } })
    }
  })
})

describe('only the owner is linked', () => {
  test("someone else naming the machine's workspace is not served as its owner", async () => {
    await db.member.create({ data: { userId: STRANGER, workspaceId: copyId, role: 'member' } })
    const { body } = await get(STRANGER, `/workspaces/${copyId}/conversations`)
    const ids = (body.conversations ?? body ?? []).map?.((c: any) => c.id) ?? []
    expect(ids).not.toContain(dmId)
    expect(ids).not.toContain(channelId)
  })

  test('a cloud workspace is left alone', async () => {
    const plain = await db.workspace.create({ data: { name: 'Plain', slug: `plain-${suffix}`, kind: 'team' } })
    await db.member.create({ data: { userId: CLOUD_OWNER, workspaceId: plain.id, role: 'owner' } })
    const res = await appAs(CLOUD_OWNER).request(`/api/workspaces/${plain.id}/conversations`, {
      headers: { [identity.MACHINE_WORKSPACE_HEADER]: plain.id },
    })
    expect(res.status).toBe(200)
  })
})
