// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Per-channel analytics breakdown against a real SQLite database: window
 * bounds, deleted messages, DMs and archived channels excluded, provider
 * bucketing, empty workspaces, and workspace totals that agree with
 * `getChannelMetrics`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const bus = await import('../lib/conversation-bus')
const service = await import('../services/conversation.service')
const metrics = await import('../services/conversation-metrics')

const db = prisma as any
let seed: SeededWorkspace
const now = new Date()
const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000)
const WEEK = { from: daysAgo(7), to: now }

/** Every channel in this file is created direct-to-DB so provider/kind are exact. */
const mkChannel = async (workspaceId: string, data: Record<string, unknown>) =>
  (await db.conversation.create({ data: { workspaceId, lastSeq: 0, ...data } })).id as string

const post = (conversationId: string, input: Record<string, unknown>) =>
  service.postMessage({ conversationId, authorType: 'user', text: 'hi', ...input } as any)

let generalId: string
let supportId: string
let dmId: string
let archivedId: string
let quietId: string

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)

  generalId = await mkChannel(seed.workspaceId, { name: 'general', slug: 'general', kind: 'public' })
  supportId = await mkChannel(seed.workspaceId, {
    name: 'support',
    slug: 'support',
    kind: 'private',
    provider: 'slack',
    externalId: 'C_SUPPORT',
  })
  dmId = await mkChannel(seed.workspaceId, { kind: 'dm', dmKey: 'owner|member' })
  archivedId = await mkChannel(seed.workspaceId, {
    name: 'old-launch',
    slug: 'old-launch',
    kind: 'public',
    archivedAt: daysAgo(2),
  })
  quietId = await mkChannel(seed.workspaceId, { name: 'quiet', slug: 'quiet', kind: 'public' })

  // general: two human posts in the window (one @mentions an agent), one agent reply.
  await post(generalId, { authorUserId: seed.owner, text: 'hey <@a:ws> summarize', createdAt: daysAgo(1) })
  await post(generalId, { authorUserId: seed.member, createdAt: daysAgo(2) })
  await post(generalId, {
    authorType: 'agent',
    authorAgentRef: { projectId: null, name: 'Shogo' },
    text: 'done',
    createdAt: daysAgo(1),
  })
  // Outside the window and soft-deleted traffic must not count.
  await post(generalId, { authorUserId: seed.owner, createdAt: daysAgo(20) })
  const deleted = await post(generalId, { authorUserId: seed.owner, createdAt: daysAgo(1) })
  await db.conversationMessage.update({ where: { id: deleted.row.id }, data: { deletedAt: daysAgo(1) } })

  // support mirrors two providers, so bridged traffic is counted per provider.
  await post(supportId, { authorUserId: seed.member, externalRef: 'slack:C_SUPPORT:1.0', createdAt: daysAgo(1) })
  await post(supportId, { authorUserId: seed.owner, externalRef: 'teams:C_SUPPORT:9.0', createdAt: daysAgo(1) })
  await post(supportId, { authorUserId: seed.owner, createdAt: daysAgo(3) })

  // DMs and archived channels carry traffic that the breakdown must ignore.
  await post(dmId, { authorUserId: seed.owner, createdAt: daysAgo(1) })
  await post(archivedId, { authorUserId: seed.owner, createdAt: daysAgo(1) })

  await db.conversationMember.updateMany({ where: { userId: { not: null } }, data: { lastReadAt: daysAgo(20) } })
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

const rowFor = (rows: any[], id: string) => rows.find((r) => r.conversationId === id)

describe('getChannelBreakdown', () => {
  test('counts messages per channel inside the window only', async () => {
    const result = await metrics.getChannelBreakdown(seed.workspaceId, WEEK)
    const general = rowFor(result.channels, generalId)

    // The 20-day-old post and the soft-deleted one are both excluded.
    expect(general.humanMessages).toBe(2)
    expect(general.agentMessages).toBe(1)
    expect(general.messages).toBe(3)
    expect(general.agentMentions).toBe(1)
    expect(general.activeMembers).toBe(2)
    expect(general.kind).toBe('public')
    expect(general.provider).toBe('shogo')
    expect(general.bridged).toBe(false)
    expect(result.window.from).toBe(WEEK.from.toISOString())
  })

  test('labels bridged channels by provider and counts every mirrored message', async () => {
    const result = await metrics.getChannelBreakdown(seed.workspaceId, WEEK)
    const support = rowFor(result.channels, supportId)

    expect(support.provider).toBe('slack')
    expect(support.bridged).toBe(true)
    expect(support.kind).toBe('private')
    // slack: and teams: refs both count as bridged, alongside one native post.
    expect(support.bridgedMessages).toBe(2)
    expect(support.humanMessages).toBe(1)
    expect(support.messages).toBe(3)
  })

  test('excludes DMs and archived channels, and keeps quiet channels', async () => {
    const result = await metrics.getChannelBreakdown(seed.workspaceId, WEEK)
    const ids = result.channels.map((r) => r.conversationId)

    expect(ids).not.toContain(dmId)
    expect(ids).not.toContain(archivedId)
    expect(rowFor(result.channels, quietId)).toMatchObject({ messages: 0, activeMembers: 0, lastMessageAt: null })
    // Busiest first, so the quiet channel sorts last.
    expect(result.channels[0].conversationId).toBe(generalId)
    expect(result.totals.channels).toBe(result.channels.length)
  })

  test('a workspace without channels reports empty totals', async () => {
    const result = await metrics.getChannelBreakdown(seed.otherWorkspaceId, WEEK)
    expect(result.channels).toEqual([])
    expect(result.totals).toMatchObject({ channels: 0, activeUsers: 0, messages: 0, bridgedShare: 0 })
  })

  test('totals agree with getChannelMetrics when the workspace has no DMs', async () => {
    const ws = await db.workspace.create({ data: { name: 'Totals', slug: `totals-${crypto.randomUUID().slice(0, 8)}`, kind: 'team' } })
    await db.member.create({ data: { userId: seed.owner, workspaceId: ws.id, role: 'owner' } })
    await db.member.create({ data: { userId: seed.member, workspaceId: ws.id, role: 'member' } })
    const alpha = await mkChannel(ws.id, { name: 'alpha', slug: 'alpha', kind: 'public' })
    const beta = await mkChannel(ws.id, { name: 'beta', slug: 'beta', kind: 'public', provider: 'teams', externalId: 'T1' })

    await post(alpha, { authorUserId: seed.owner, createdAt: daysAgo(1) })
    await post(alpha, { authorUserId: seed.member, createdAt: daysAgo(2) })
    await post(beta, { authorUserId: seed.member, externalRef: 'teams:T1:1.0', createdAt: daysAgo(1) })

    const breakdown = await metrics.getChannelBreakdown(ws.id, WEEK)
    const weekly = await metrics.getChannelMetrics(ws.id, { weeks: 1, now })

    expect(breakdown.totals.activeUsers).toBe(weekly.weeks[0].activeUsers)
    expect(breakdown.totals.bridgedShare).toBe(weekly.weeks[0].bridgedShare)
    expect(breakdown.totals.humanMessages).toBe(weekly.weeks[0].humanMessages)
    expect(breakdown.totals.agentMessages).toBe(weekly.weeks[0].agentPosts)
    expect(breakdown.totals.activeUsers).toBe(2)
    expect(breakdown.totals.bridgedMessages).toBe(1)
  })
})
