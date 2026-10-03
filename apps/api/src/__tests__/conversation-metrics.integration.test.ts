// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Channel usage metrics against a real SQLite database.
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
const metrics = await import('../services/conversation-metrics')

const db = prisma as any
let seed: SeededWorkspace
const now = new Date()
const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000)

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  const list = await service.listConversationsForUser(seed.workspaceId, seed.owner)
  const general = list.find((c: any) => c.slug === 'general')!
  const post = (input: Record<string, unknown>) =>
    service.postMessage({ conversationId: general.id, authorType: 'user', text: 'hi', ...input } as any)

  await post({ authorUserId: seed.owner, text: 'hey <@a:ws> summarize', createdAt: daysAgo(1) })
  await post({ authorUserId: seed.owner, createdAt: daysAgo(2) })
  await post({ authorUserId: seed.member, createdAt: daysAgo(3) })
  await post({ authorType: 'agent', authorAgentRef: { projectId: null, name: 'Shogo' }, text: 'done', createdAt: daysAgo(1) })
  await post({ authorUserId: seed.member, externalRef: 'slack:C1:1.0', createdAt: daysAgo(1) })
  await post({ authorUserId: seed.member, createdAt: daysAgo(9) })
  await db.conversationMember.updateMany({ where: { userId: { not: null } }, data: { lastReadAt: daysAgo(20) } })
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('channel metrics', () => {
  test('weekly active share, agent usage, and bridged share', async () => {
    const result = await metrics.getChannelMetrics(seed.workspaceId, { weeks: 2, now })
    expect(result.memberCount).toBe(3)
    const [thisWeek, lastWeek] = result.weeks
    expect(thisWeek.activeUsers).toBe(2)
    expect(thisWeek.activeShare).toBe(0.667)
    expect(thisWeek.humanMessages).toBe(3)
    expect(thisWeek.messagesPerActiveUser).toBe(1.5)
    expect(thisWeek.agentMentions).toBe(1)
    expect(thisWeek.agentPosts).toBe(1)
    expect(thisWeek.nativeMessages).toBe(4)
    expect(thisWeek.bridgedMessages).toBe(1)
    expect(thisWeek.bridgedShare).toBe(0.2)
    expect(lastWeek.activeUsers).toBe(1)
    expect(lastWeek.humanMessages).toBe(1)
    expect(result.gate.meetsActiveShareGate).toBe(true)
  })

  test('reading a channel counts as active', async () => {
    await service.listConversationsForUser(seed.workspaceId, seed.viewer)
    await db.conversationMember.updateMany({ where: { userId: seed.viewer }, data: { lastReadAt: daysAgo(1) } })
    const result = await metrics.getChannelMetrics(seed.workspaceId, { weeks: 1, now })
    expect(result.weeks[0].activeUsers).toBe(3)
    expect(result.weeks[0].activeShare).toBe(1)
  })

  test('only workspace admins can read metrics over HTTP', async () => {
    const path = `/api/workspaces/${seed.workspaceId}/conversations/metrics?weeks=1`
    const owner = await app.request(path, { headers: { 'x-user': seed.owner } })
    expect(owner.status).toBe(200)
    expect((await owner.json()).weeks).toHaveLength(1)
    expect((await app.request(path, { headers: { 'x-user': seed.member } })).status).toBe(403)
    expect((await app.request(path, { headers: { 'x-user': seed.outsider } })).status).toBe(403)
  })

  test('admin overview lists workspaces with recent traffic', async () => {
    const rows = await metrics.listChannelMetricsOverview({ now })
    expect(rows.map((r) => r.workspaceId)).toEqual([seed.workspaceId])
    expect(rows[0].activeUsers).toBeGreaterThan(0)
  })
})
