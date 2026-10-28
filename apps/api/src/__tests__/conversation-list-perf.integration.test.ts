// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The conversation list on a workspace that has grown: 150 channels, 150
 * projects and 150 messages. Home and the DMs screen both call this endpoint,
 * so its cost is the phone's cost.
 *
 * Two budgets are held here:
 *
 * - A steady-state list is two reads and no writes. The endpoint used to run
 *   `ensureDefaultConversations` + `ensureSelfConversation` on every call, so
 *   every phone poll paid for set-up writes that were already done.
 * - `since` returns only what changed, so a reconnect or a foreground does not
 *   re-download the whole workspace.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.SHOGO_DATA_DIR = dir

const { prisma } = await import('../lib/prisma')
const { conversationRoutes } = await import('../routes/conversations')

const db = prisma as any
let seed: SeededWorkspace

const CHANNELS = 150
const PROJECTS = 150
const MESSAGES = 150

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))

/** A budget wide enough for a loaded CI runner, tight enough to catch a regression. */
const FULL_LIST_BUDGET_MS = 2_000

async function list(query = ''): Promise<{ status: number; conversations: any[]; ms: number; syncedAt?: string }> {
  const started = performance.now()
  const res = await app.request(`/api/workspaces/${seed.workspaceId}/conversations${query}`, {
    headers: { 'x-user': seed.owner },
  })
  const json: any = await res.json()
  return {
    status: res.status,
    conversations: json.conversations ?? [],
    syncedAt: json.syncedAt,
    ms: performance.now() - started,
  }
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
  const base = Date.now() - CHANNELS * 1_000

  // 150 channels, each with a message, so the list has to build 150 rows with a
  // last-message preview and a membership.
  const conversations = Array.from({ length: CHANNELS }, (_, i) => ({
    workspaceId: seed.workspaceId,
    kind: 'public' as const,
    name: `channel-${i}`,
    slug: `channel-${i}`,
    createdById: seed.owner,
    lastSeq: 1,
    lastMessageAt: new Date(base + i * 1_000),
    createdAt: new Date(base + i * 1_000),
    updatedAt: new Date(base + i * 1_000),
  }))
  await db.conversation.createMany({ data: conversations })
  const rows = await db.conversation.findMany({
    where: { workspaceId: seed.workspaceId, slug: { startsWith: 'channel-' } },
    select: { id: true },
    orderBy: { slug: 'asc' },
  })
  expect(rows.length).toBe(CHANNELS)

  await db.conversationMember.createMany({
    data: rows.map((row: any, i: number) => ({ conversationId: row.id, memberType: 'user', userId: seed.owner, lastReadSeq: i % 2 })),
  })
  await db.conversationMessage.createMany({
    data: rows.slice(0, MESSAGES).map((row: any, i: number) => ({
      conversationId: row.id,
      workspaceId: seed.workspaceId,
      seq: 1,
      authorType: 'user' as const,
      authorUserId: seed.owner,
      text: `message ${i}`,
    })),
  })
  // 150 projects, the other list Home draws on one screen.
  await db.project.createMany({
    data: Array.from({ length: PROJECTS }, (_, i) => ({
      name: `project-${i}`,
      workspaceId: seed.workspaceId,
      createdBy: seed.owner,
    })),
  })
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('conversation list on a 150/150/150 workspace', () => {
  test('returns every channel it can see, inside the budget', async () => {
    const first = await list()
    expect(first.status).toBe(200)
    // The default #general and #activity channels are created on the first read.
    expect(first.conversations.length).toBeGreaterThanOrEqual(CHANNELS)
    expect(first.syncedAt).toBeTruthy()
    expect(first.ms).toBeLessThan(FULL_LIST_BUDGET_MS)
    console.log(`[perf] full list of ${first.conversations.length}: ${first.ms.toFixed(0)}ms`)

    // Steady state: the set-up writes are behind us, so a repeat call is only
    // the two reads and must not get slower.
    const second = await list()
    expect(second.conversations.length).toBe(first.conversations.length)
    expect(second.ms).toBeLessThan(FULL_LIST_BUDGET_MS)
    console.log(`[perf] steady-state list: ${second.ms.toFixed(0)}ms`)
  })

  test('carries the fields Home renders, not just ids', async () => {
    const { conversations } = await list()
    const channel = conversations.find((c) => c.slug === 'channel-7')
    expect(channel).toBeTruthy()
    expect(channel.name).toBe('channel-7')
    expect(channel.lastSeq).toBe(1)
    expect(typeof channel.unreadCount).toBe('number')
    expect(typeof channel.mentionCount).toBe('number')
    expect(channel.starred).toBe(false)
    expect(channel.archivedAt).toBeNull()
  })

  test('`since` returns only what changed, so a reconnect is cheap', async () => {
    const full = await list()
    expect(full.conversations.length).toBeGreaterThanOrEqual(CHANNELS)

    // Nothing has happened since the last read: an empty catch-up.
    const quiet = await list(`?since=${encodeURIComponent(full.syncedAt!)}`)
    expect(quiet.status).toBe(200)
    expect(quiet.conversations.length).toBe(0)
    console.log(`[perf] quiet catch-up: ${quiet.ms.toFixed(0)}ms`)

    // One new message in one channel: exactly that channel comes back.
    const target = full.conversations.find((c) => c.slug === 'channel-11')
    await new Promise((resolve) => setTimeout(resolve, 5))
    const since = new Date().toISOString()
    await db.conversationMessage.create({
      data: {
        conversationId: target.id,
        workspaceId: seed.workspaceId,
        seq: 2,
        authorType: 'user',
        authorUserId: seed.owner,
        text: 'a new message',
      },
    })
    await db.conversation.update({
      where: { id: target.id },
      data: { lastSeq: 2, lastMessageAt: new Date() },
    })

    const changed = await list(`?since=${encodeURIComponent(since)}`)
    expect(changed.conversations.map((c) => c.id)).toEqual([target.id])
    expect(changed.conversations[0].lastSeq).toBe(2)
    expect(changed.ms).toBeLessThan(FULL_LIST_BUDGET_MS)
    console.log(`[perf] one changed channel: ${changed.ms.toFixed(0)}ms`)
  })

  test('a `since` older than the workspace returns the whole list', async () => {
    const all = await list(`?since=${encodeURIComponent(new Date(0).toISOString())}`)
    expect(all.conversations.length).toBeGreaterThanOrEqual(CHANNELS)
  })

  test('an unparseable `since` falls back to the full list instead of failing', async () => {
    const all = await list('?since=not-a-date')
    expect(all.status).toBe(200)
    expect(all.conversations.length).toBeGreaterThanOrEqual(CHANNELS)
  })
})
