// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Message search: query parsing, access filtering, and in:/from: filters.
 * Runs on SQLite; the Postgres full-text path shares the same filters.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes } = await import('../routes/conversations')
const bus = await import('../lib/conversation-bus')
const service = await import('../services/conversation.service')
const search = await import('../services/conversation-search')

const db = prisma as any
let seed: SeededWorkspace
let generalId: string
let privateId: string

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))

async function find(user: string, q: string) {
  const res = await app.request(`/api/workspaces/${seed.workspaceId}/conversations/search?q=${encodeURIComponent(q)}`, {
    headers: { 'x-user': user },
  })
  const json: any = await res.json()
  return { status: res.status, texts: (json.results ?? []).map((r: any) => r.message.text), json }
}

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  for (const user of [seed.owner, seed.member, seed.viewer]) await service.listConversationsForUser(seed.workspaceId, user)
  const list = await service.listConversationsForUser(seed.workspaceId, seed.owner)
  generalId = list.find((c: any) => c.slug === 'general')!.id
  const priv = await service.createChannel({ workspaceId: seed.workspaceId, userId: seed.owner, name: 'leads', kind: 'private' })
  privateId = priv.id
  const dm = await service.openDirectConversation(seed.workspaceId, seed.owner, [seed.member])
  const post = (conversationId: string, authorUserId: string | null, text: string, extra: Record<string, unknown> = {}) =>
    service.postMessage({ conversationId, authorType: 'user', authorUserId, text, ...extra } as any)

  await post(generalId, seed.owner, 'Launch plan is ready for Friday')
  await post(generalId, seed.member, 'I will write the launch changelog')
  await post(privateId, seed.owner, 'Launch budget is tight')
  await post(dm.id, seed.member, 'Can we talk about the launch?')
  await post(generalId, null, 'Launch checklist drafted', { authorType: 'agent', authorAgentRef: { projectId: null, name: 'Shogo' } })
  const deleted = await post(generalId, seed.owner, 'launch secret')
  await db.conversationMessage.update({ where: { id: deleted.row.id }, data: { deletedAt: new Date() } })
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('parseSearchQuery', () => {
  test('splits words from in:/from: filters', () => {
    expect(search.parseSearchQuery('ship it in:#Launch from:@Ada "big day" -nope')).toEqual({
      text: 'ship it "big day" -nope',
      terms: ['ship', 'it', 'big', 'day'],
      inChannels: ['launch'],
      inPeople: [],
      from: ['ada'],
    })
    expect(search.parseSearchQuery('in:@ada from:me').inPeople).toEqual(['ada'])
  })
})

describe('search', () => {
  test('finds messages only in conversations you can read, never deleted ones', async () => {
    const owner = await find(seed.owner, 'launch')
    expect(owner.status).toBe(200)
    expect(owner.texts.sort()).toEqual([
      'Can we talk about the launch?',
      'I will write the launch changelog',
      'Launch budget is tight',
      'Launch checklist drafted',
      'Launch plan is ready for Friday',
    ])
    const viewer = await find(seed.viewer, 'launch')
    expect(viewer.texts.sort()).toEqual([
      'I will write the launch changelog',
      'Launch checklist drafted',
      'Launch plan is ready for Friday',
    ])
    expect(owner.json.results[0].conversation.id).toBeDefined()
  })

  test('all words must match', async () => {
    expect((await find(seed.owner, 'launch friday')).texts).toEqual(['Launch plan is ready for Friday'])
  })

  test('in: narrows to a channel or a DM with someone', async () => {
    expect((await find(seed.owner, 'launch in:#leads')).texts).toEqual(['Launch budget is tight'])
    expect((await find(seed.owner, 'launch in:@member')).texts).toEqual(['Can we talk about the launch?'])
    expect((await find(seed.viewer, 'launch in:#leads')).texts).toEqual([])
  })

  test('from: narrows to a person, yourself, or agents', async () => {
    expect((await find(seed.owner, 'launch from:@member')).texts.sort())
      .toEqual(['Can we talk about the launch?', 'I will write the launch changelog'])
    expect((await find(seed.member, 'from:me in:#general')).texts).toEqual(['I will write the launch changelog'])
    expect((await find(seed.owner, 'launch from:agent')).texts).toEqual(['Launch checklist drafted'])
    expect((await find(seed.owner, 'launch from:shogo')).texts).toEqual(['Launch checklist drafted'])
  })

  test('outsiders are rejected and empty queries return nothing', async () => {
    expect((await find(seed.outsider, 'launch')).status).toBe(403)
    expect((await find(seed.owner, '   ')).texts).toEqual([])
    expect((await find(seed.owner, 'launch in:#nope')).texts).toEqual([])
  })
})
